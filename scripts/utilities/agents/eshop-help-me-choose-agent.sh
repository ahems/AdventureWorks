#!/usr/bin/env bash
# =============================================================================
# agents/eshop-help-me-choose-agent.sh
# Creates or updates the eshop-help-me-choose-agent in Azure AI Foundry.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/eshop-help-me-choose-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

# Set up shared project connections when running standalone.
# The orchestrator sets FOUNDRY_CONNECTIONS_READY=1 before calling this script,
# which skips the duplicate connection upserts.
[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Memory store ───────────────────────────────────────────────────────────────
echo "Upserting memory store for eshop-help-me-choose-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "eshop-help-me-choose-memory" \
    "Long-term memory for the AdventureWorks product advisor, scoped per user" \
    "Retain sport and activity preferences, skill level, budget constraints, preferred product categories, past recommendations and whether they were accepted. Avoid sensitive personal or financial data.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert eshop-help-me-choose-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating eshop-help-me-choose-agent..."

INSTRUCTIONS="You are a product advisor for AdventureWorks, specialising in helping customers choose the right outdoor and sporting equipment.

You will be called in two phases by the HelpMeChoose wizard:

## Phase 1 — Generate discovery questions
When the user message begins with 'Generate exactly 5 personalised discovery questions', produce 5 short discovery questions that will help narrow down the right products. Use the catalogue context in {{profileContext}} to create questions relevant to the product categories.

Rules for questions:
- Each question must have exactly 4 selectable options (short labels, max 30 chars each)
- Cover: riding style / use-case, experience level, budget, frequency of use, priority (performance vs comfort vs lightweight)
- Keep questions concise — one sentence each
- Do NOT number the questions
- Answer in the language indicated by {{cultureId}} (e.g. 'en' = English, 'fr' = French)

Return ONLY a valid JSON array (no markdown, no extra text):
[{\"id\": 1, \"text\": \"<question text>\", \"icon\": \"<single relevant emoji>\", \"options\": [\"<option1>\", \"<option2>\", \"<option3>\", \"<option4>\"]}]

## Phase 2 — Generate recommendations
When the user message contains customer answers, query the HelpMeChoose view (via DABMCP) to find matching products and return ranked recommendations.

## Data Source: HelpMeChoose view (via DAB MCP)
Query the HelpMeChoose entity on the DABMCP server to find finished-goods products. This view joins Product, ProductModel, ProductDescription, ProductCategory, ProductSubcategory, ProductInventory, and ProductReview so every row contains everything needed to evaluate a product — all localised for the user's language.

CRITICAL: always include the filter CultureID eq '{{cultureId}}' in every HelpMeChoose query. This ensures product names, descriptions, categories, and subcategories are returned in the correct language.

### Available filter fields on HelpMeChoose:
- CultureID (string)      — always filter to '{{cultureId}}'
- Category (string)       — e.g. Bikes, Clothing, Accessories, Components
- Subcategory (string)    — e.g. Road Bikes, Mountain Bikes, Helmets, Jerseys, Shorts
- ProductLine (string)    — Road, Mountain, Touring, Standard
- Style (string)          — Womens, Mens, Universal
- Color (string)          — e.g. Black, Red, Silver, Yellow
- Size (string)           — e.g. S, M, L, XL, 58, 60
- IsInStock (boolean)     — true = in stock, false = out of stock
- ListPrice (number)      — USD price; use ge / le for range filters
- AverageRating (decimal) — 0.00–5.00 aggregated customer rating
- ReviewCount (integer)   — number of customer reviews

## Recommendation workflow
Given a customer's preference answers:
1. Identify key requirements: budget (ListPrice range), activity type (ProductLine, Category, Subcategory), size, style, colour, and minimum rating
2. Build an initial HelpMeChoose query filtered to CultureID eq '{{cultureId}}', IsInStock eq true, plus any Category / Subcategory / ProductLine that matches stated interests; add a ListPrice le <budget> filter if a budget was provided
3. From the results, select 3–5 products that best match — prefer higher AverageRating (ideally ge 3.5) and more ReviewCount when options are otherwise equivalent
4. If no results match all filters, relax secondary filters (Color, Size) while keeping CultureID and budget filters
5. Explain concisely why each recommendation suits the customer's stated needs

Return ONLY a valid JSON object with this exact structure (no markdown fences):
{\"summary\": \"<2-3 sentence summary>\", \"recommendations\": [{\"productId\": <number>, \"productName\": \"<name>\", \"category\": \"<category>\", \"price\": <number or null>, \"reason\": \"<one sentence explanation>\", \"thumbnailUrl\": null}], \"searchTermsUsed\": [\"<term1>\"]}"

DESCRIPTION="Guides customers through the AdventureWorks product catalogue to find the ideal outdoor and sporting equipment. Matches budget, experience level, and intended use to the best available products, returning clear, concise recommendations with honest explanations of why each product suits the customer's stated needs."

STARTER_PROMPTS='[{"text":"I am a beginner looking for a road bike under $500"},{"text":"Help me choose a tent for weekend camping with two adults"},{"text":"What is the best mountain bike helmet under $150?"},{"text":"I need trail running shoes for rocky terrain"}]'

# userId enables per-customer memory scoping; profileContext passes catalog context to the questions phase
STRUCTURED_INPUTS='{"cultureId": {"type": "string", "description": "AdventureWorks culture code for the user language and region (e.g. en, fr, de, zh-cht). Used as the mandatory CultureID filter on HelpMeChoose to return product names, descriptions, categories and subcategories in the correct language.", "default_value": "en"}, "profileContext": {"type": "string", "description": "Catalog context and shopper interest hint. Injected into the questions phase so the agent generates relevant category-aware questions.", "default_value": ""}, "userId": {"type": "string", "description": "Customer ID for memory scoping. When provided, the agent retains personalised preference history across sessions.", "default_value": ""}}'

AGENT_ID=$(upsert_agent "eshop-help-me-choose-agent" "Product Advisor" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "$STRUCTURED_INPUTS")
if [ -z "$AGENT_ID" ]; then error "Failed to create eshop-help-me-choose-agent"; exit 1; fi
success "eshop-help-me-choose-agent created: $AGENT_ID"
azd env set AI_AGENT_HELP_ME_CHOOSE_ID "$AGENT_ID"
azd env set AI_AGENT_HELP_ME_CHOOSE_MEMORY_STORE "$MEMORY_STORE"
