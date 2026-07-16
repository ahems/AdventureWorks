#!/usr/bin/env bash
# =============================================================================
# agents/admin-catalog-suggestion-agent.sh
# Creates or updates the admin-catalog-suggestion-agent in Azure AI Foundry.
#
# This agent suggests new product categories and subcategories for the
# AdventureWorks catalog based on the existing hierarchy. Context (existing
# categories, target parent category) is supplied via structured_inputs.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-catalog-suggestion-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

# Set up shared project connections when running standalone.
[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Memory store ───────────────────────────────────────────────────────────────
echo "Upserting memory store for admin-catalog-suggestion-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-catalog-suggestion-memory" \
    "Long-term memory for the AdventureWorks catalog suggestion agent" \
    "Retain previously suggested categories and subcategories to avoid repetition across runs. Track which adjacent markets have been explored and which product subdivisions exist.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-catalog-suggestion-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-catalog-suggestion-agent..."

INSTRUCTIONS='You are a product catalog consultant for AdventureWorks, an outdoor and adventure sports equipment e-commerce site.

## Your task
Suggest ONE new product category or subcategory that would make commercial sense for AdventureWorks but is NOT already in the provided category hierarchy.

## Inputs (resolved at runtime)
- Existing category hierarchy: {{categoryHierarchy}}
- Suggestion type: {{suggestionType}}
- Target parent category (for subcategory suggestions): {{parentCategoryName}}
- Existing subcategories for target (for subcategory suggestions): {{existingSubcategories}}

## Context
AdventureWorks sells outdoor, cycling, and adventure sports equipment — primarily bikes, bike components, clothing, and accessories.

## Rules for category suggestions (suggestionType = "category")
- The name must be 1–4 words, title-cased
- It must not duplicate or closely overlap any existing category
- Think about adjacent markets: water sports, camping, fitness, nutrition, footwear, winter sports
- If you genuinely cannot think of a suitable category, set suggested to false

## Rules for subcategory suggestions (suggestionType = "subcategory")
- The name must be 1–4 words, title-cased
- It must not duplicate or closely overlap any existing subcategory for the target parent
- It should be a logical product subdivision of the parent category
- If you genuinely cannot think of a suitable subcategory, set suggested to false

## Response format
Return ONLY a valid JSON object — no markdown fences, no explanation:
{
  "suggested": true,
  "name": "New Name Here"
}
or
{
  "suggested": false,
  "name": null
}'

DESCRIPTION="Suggests new product categories or subcategories for the AdventureWorks catalog. Receives the existing category hierarchy and suggestion parameters via structured inputs. Returns a JSON object with suggested (boolean) and name (string or null)."

STARTER_PROMPTS='[{"text":"Suggest a new top-level category"},{"text":"Suggest a subcategory for Accessories"},{"text":"What product category is missing?"}]'

# No MCP tools needed — category hierarchy supplied via structured_inputs
AGENT_ID=$(upsert_agent "admin-catalog-suggestion-agent" "Catalog Suggestion Advisor" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "{}" "[]" "false")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-catalog-suggestion-agent"; exit 1; fi
success "admin-catalog-suggestion-agent created: $AGENT_ID"
azd env set AI_AGENT_CATALOG_SUGGESTION_ID "$AGENT_ID"
azd env set AI_AGENT_CATALOG_SUGGESTION_MEMORY_STORE "$MEMORY_STORE"
