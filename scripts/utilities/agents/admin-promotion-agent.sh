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

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-promotion-agent..."

INSTRUCTIONS="You are a promotions and marketing assistant for AdventureWorks.

Your role is to generate targeted product promotion suggestions for customers.

Given a customer ID:
1. Analyse the customer's purchase history using the available tools
2. Identify products the customer is likely to be interested in
3. Check current special offers and inventory levels
4. Return a JSON object with: customer_id, promotions (array of {product_id, product_name, discount_percent, reason})

Focus on relevant, personalised suggestions that match the customer's interests.
Return ONLY valid JSON without markdown fences."

DESCRIPTION="Creates targeted, personalised promotional offers for AdventureWorks customers based on their purchase history, product interests, and current inventory levels. Returns a structured list of recommended promotions with suggested discount percentages and clear rationale, helping marketing teams drive engagement and repeat purchases."

STARTER_PROMPTS='[{"text":"What promotions should I offer customer ID 29736?"},{"text":"Suggest discount offers for customers interested in cycling"},{"text":"Find cross-sell opportunities for customers who recently bought running shoes"}]'

AGENT_ID=$(upsert_agent "admin-promotion-agent" "Promotions & Offers Advisor" "$INSTRUCTIONS" "" "$DESCRIPTION" "$STARTER_PROMPTS")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-promotion-agent"; exit 1; fi
success "admin-promotion-agent created: $AGENT_ID"
azd env set AI_AGENT_PROMOTION_ID "$AGENT_ID"
