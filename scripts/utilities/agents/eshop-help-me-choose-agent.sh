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
When the user message contains customer answers, use only the authorized AdventureWorks MCP product-catalog tools: search_products, get_product_details, find_complementary_products, and get_categories_with_products. These tools run through the managed-identity-backed api-mcp service token, limited to products.read. Do not query customer, order, review-write, administration, or DAB MCP APIs.

## Recommendation workflow
Given the customer's preference answers:
1. Identify key requirements such as budget, activity type, size, style, colour, and intended use.
2. Call search_products for up to three relevant terms using {{cultureId}} as the culture.
3. Use get_product_details only to verify promising catalog matches; use find_complementary_products only for a suitable primary product.
4. Select 3–5 products from tool results, prioritizing the customer's stated preferences and budget.
5. Explain concisely why each recommendation suits the customer's stated needs.

Return ONLY a valid JSON object with this exact structure (no markdown fences):
{\"summary\": \"<2-3 sentence summary>\", \"recommendations\": [{\"productId\": <number>, \"productName\": \"<name>\", \"category\": \"<category>\", \"price\": <number or null>, \"reason\": \"<one sentence explanation>\", \"thumbnailUrl\": null}], \"searchTermsUsed\": [\"<term1>\"]}"

DESCRIPTION="Guides customers through the AdventureWorks product catalogue to find the ideal outdoor and sporting equipment. Matches budget, experience level, and intended use to the best available products, returning clear, concise recommendations with honest explanations of why each product suits the customer's stated needs."

STARTER_PROMPTS='[{"text":"I am a beginner looking for a road bike under $500"},{"text":"Help me choose a tent for weekend camping with two adults"},{"text":"What is the best mountain bike helmet under $150?"},{"text":"I need trail running shoes for rocky terrain"}]'

# Public wizard requests are stateless: no caller-supplied identity, stored memory,
# Foundry continuation ID, or DAB MCP connection is exposed.
STRUCTURED_INPUTS='{"cultureId": {"type": "string", "description": "AdventureWorks culture code for the user language and region (e.g. en, fr, de, zh-cht). Use this culture for every product-search tool call.", "default_value": "en"}, "profileContext": {"type": "string", "description": "Public catalog context injected into the questions phase.", "default_value": ""}}'
ALLOWED_TOOLS='["search_products","get_product_details","find_complementary_products","get_categories_with_products"]'

AGENT_ID=$(upsert_agent "eshop-help-me-choose-agent" "Product Advisor" "$INSTRUCTIONS" "" "$DESCRIPTION" "$STARTER_PROMPTS" "$STRUCTURED_INPUTS" "$ALLOWED_TOOLS" "false")
if [ -z "$AGENT_ID" ]; then error "Failed to create eshop-help-me-choose-agent"; exit 1; fi
success "eshop-help-me-choose-agent created: $AGENT_ID"
azd env set AI_AGENT_HELP_ME_CHOOSE_ID "$AGENT_ID"
