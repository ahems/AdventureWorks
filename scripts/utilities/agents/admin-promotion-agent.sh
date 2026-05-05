#!/usr/bin/env bash
# =============================================================================
# agents/admin-promotion-agent.sh
# Creates or updates the admin-promotion-agent in Azure AI Foundry.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-promotion-agent.sh
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
echo "Upserting memory store for admin-promotion-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-promotion-memory" \
    "Long-term memory for the AdventureWorks promotions advisor, scoped per promotion type" \
    "Retain details of recently generated campaigns per promotion type and category so the agent produces varied and non-repetitive suggestions across successive admin runs. Avoid storing individual customer data.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-promotion-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-promotion-agent..."

INSTRUCTIONS="You are a promotions and marketing strategist for AdventureWorks.

## Context
- Promotion type: {{promotionType}}  (e.g. Clearance, Seasonal, Bundle, Flash-sale)
- Offer category: {{offerCategory}}  (e.g. Customer, Reseller, All)
- Today's date:   {{todayDate}}
{{#if categoryName}}- Target category: {{categoryName}}{{#if subcategoryName}} / {{subcategoryName}}{{/if}}{{/if}}

## Your task
Design one targeted promotion campaign for the given type and category. Use the GetProductsForPromotion MCP tool to retrieve live product data (prices, inventory, recent sales) for the target category before making any recommendations.

## Workflow
1. Call GetProductsForPromotion to fetch current products, prices, inventory levels, and recent sales in the target category (or all categories if none specified)
2. Identify 3–5 products that are good candidates for a promotion — e.g. high inventory relative to recent sales, or products that complement recent top-sellers
3. Choose a discount percentage (5–40%) appropriate to the promotion type
4. Set a campaign date range: start = today or within 2 weeks; end = 1–4 weeks after start depending on the promotion type
5. Write a concise campaign description (1–2 sentences) suitable for an email or banner

## Memory guidance
Use your memory to recall which campaign types and discounts were recently suggested for this promotion type so you can produce a varied set of promotions over time. Favour products not featured in recent campaigns.

## Response format
Return ONLY a valid JSON object (no markdown fences):
{
  \"description\": \"<1-2 sentence campaign description>\",
  \"discountPct\": <number 5-40>,
  \"type\": \"<promotionType>\",
  \"category\": \"<category or 'All'>\",
  \"startDate\": \"<YYYY-MM-DD>\",
  \"endDate\": \"<YYYY-MM-DD>\",
  \"minQty\": <1 or higher>,
  \"aiReasoning\": \"<1-2 sentence explanation of why these products were chosen>\",
  \"suggestedProducts\": [
    {\"productId\": <number>, \"productName\": \"<name>\", \"currentPrice\": <number>, \"inventoryLevel\": <number>, \"recentSalesCount\": <number>, \"reason\": \"<one sentence>\"}
  ]
}"

DESCRIPTION="Generates targeted promotion campaigns for AdventureWorks administrators. Uses live product inventory, pricing, and sales data from the MCP server to recommend the best products, appropriate discount levels, and campaign date ranges. Supports multi-turn refinement so admins can adjust and iterate on suggestions."

STARTER_PROMPTS='[{"text":"Create a clearance campaign for mountain bikes"},{"text":"Generate a seasonal promotion for cycling apparel"},{"text":"Design a bundle offer for road bike components"},{"text":"Suggest a flash-sale for high-inventory accessories"}]'

# Structured inputs resolve Handlebars templates in agent instructions.
# promotionType, offerCategory, todayDate are always injected.
# categoryId, categoryName, subcategoryId, subcategoryName are optional and injected when the admin has scoped the promotion to a category.
STRUCTURED_INPUTS='{
  "promotionType":   {"type": "string", "description": "Type of promotion campaign (e.g. Clearance, Seasonal, Bundle, Flash-sale).", "default_value": "Seasonal"},
  "offerCategory":   {"type": "string", "description": "Target offer category (e.g. Customer, Reseller, All).", "default_value": "Customer"},
  "todayDate":       {"type": "string", "description": "Today'\''s date in YYYY-MM-DD format for campaign date calculations.", "default_value": ""},
  "categoryId":      {"type": "string", "description": "Optional numeric ID of the target product category.", "default_value": ""},
  "categoryName":    {"type": "string", "description": "Optional display name of the target product category.", "default_value": ""},
  "subcategoryId":   {"type": "string", "description": "Optional numeric ID of the target product subcategory.", "default_value": ""},
  "subcategoryName": {"type": "string", "description": "Optional display name of the target product subcategory.", "default_value": ""}
}'

AGENT_ID=$(upsert_agent "admin-promotion-agent" "Promotions & Offers Advisor" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "$STRUCTURED_INPUTS")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-promotion-agent"; exit 1; fi
success "admin-promotion-agent created: $AGENT_ID"
azd env set AI_AGENT_PROMOTION_ID "$AGENT_ID"
azd env set AI_AGENT_PROMOTION_MEMORY_STORE "$MEMORY_STORE"
