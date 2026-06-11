#!/usr/bin/env bash
# =============================================================================
# agents/admin-product-content-agent.sh
# Creates or updates the admin-product-content-agent in Azure AI Foundry.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-product-content-agent.sh
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
echo "Upserting memory store for admin-product-content-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-product-content-memory" \
    "Long-term memory for the AdventureWorks product content designer, scoped per subcategory" \
    "Retain the names, styles, and descriptions of products recently designed for each subcategory so the agent produces varied and non-repetitive catalogue entries across successive wizard runs. Do not store pricing or inventory data.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-product-content-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-product-content-agent..."

# shellcheck disable=SC2016
INSTRUCTIONS='You are a creative product copywriter and pricing analyst for the fictional AdventureWorks e-commerce brand.

## Context
AdventureWorks is a demo outdoor / cycling goods retailer. The tone should feel realistic and professional — like a real retail website — but also playful and light-hearted.

## Memory guidance
Use your memory to recall product names and styles recently designed for the same subcategory. Favour different names, styles, and price points to build a varied catalogue. Avoid repeating the same product name or description.

## Your task
Return a JSON object with all required fields below. Do NOT add extra text outside the JSON.

## JSON fields
- productName: (string) 2-5 words, premium retail product name — avoid real trademarks
- productDescription: (string) 2 short engaging marketing paragraphs (4-6 sentences total) in US English — focus on experience, NOT specs or pricing
- estimatedWeightLb: (number) realistic weight in pounds for the product given its category/subcategory
- suggestedStandardCost: (number) realistic USD manufacturing or bulk purchase cost
- suggestedListPrice: (number) realistic USD retail price; must be >= suggestedStandardCost
- suggestedSizes: (array of strings -- always quoted, even for numeric sizes like "48") subset of the provided available sizes that physically make sense for this product; empty array if sizes do not vary
- suggestedColors: (array of strings) subset of the provided available colors that make sense for this product; empty array if color does not vary
- suggestedStyles: (array of strings) subset of the provided available styles that make sense for this product; empty array if style does not vary

## Guidelines for suggestedSizes
- Bikes: use only numeric frame sizes (38-70)
- Apparel (jerseys, shorts, gloves): use only clothing sizes (XS, S, M, L, XL)
- Helmets, caps: S, M, L only
- Small accessories (water bottles, lights, locks): return empty array (one size)
- Tires: use numeric sizes if available; otherwise empty

## Response format
Return ONLY a valid JSON object. No markdown fences, no explanation.'

DESCRIPTION="Generates creative product content for the AdventureWorks admin catalogue wizard. Designs realistic product names, marketing descriptions, pricing (cost and list price), weight estimates, and variation hints (sizes, colors, styles) for any given product category and subcategory. Supports within-session chaining via Foundry response IDs to avoid duplicate names within a single wizard run."

STARTER_PROMPTS='[{"text":"Design a mountain bike for the Bikes > Mountain Bikes category"},{"text":"Create a cycling jersey product for the Clothing > Jerseys subcategory"},{"text":"Generate a road helmet for the Components > Helmets and Helmets category"},{"text":"Design a water bottle accessory for the Accessories category"}]'

AGENT_ID=$(upsert_agent "admin-product-content-agent" "Product Content Designer" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "{}")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-product-content-agent"; exit 1; fi
success "admin-product-content-agent created: $AGENT_ID"
azd env set AI_AGENT_PRODUCT_CONTENT_ID "$AGENT_ID"
azd env set AI_AGENT_PRODUCT_CONTENT_MEMORY_STORE "$MEMORY_STORE"
