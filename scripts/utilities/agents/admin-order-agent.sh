#!/usr/bin/env bash
# =============================================================================
# agents/admin-order-agent.sh
# Creates or updates the admin-order-agent in Azure AI Foundry.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-order-agent.sh
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
echo "Creating/updating admin-order-agent..."

INSTRUCTIONS="You are an intelligent order generation assistant for AdventureWorks.

Your role is to help sales representatives generate new sales orders based on customer history and inventory.

When given a customer ID or name:
1. Look up the customer's purchase history and preferences using the available tools
2. Check current product inventory and pricing
3. Suggest an appropriate order with product IDs, quantities, and a justification
4. Return a structured JSON object with: customer_id, items (array of {product_id, quantity, unit_price}), and reasoning

Always verify inventory availability before including a product in the order.
Return ONLY valid JSON without markdown fences."

DESCRIPTION="Generates intelligent, data-driven sales order recommendations for AdventureWorks customers. Analyses a customer's purchase history and preferences against current inventory and pricing to produce a structured order proposal complete with product IDs, quantities, prices, and justification. Designed to help sales representatives quickly draft well-matched reorder suggestions."

STARTER_PROMPTS='[{"text":"Generate a suggested order for customer ID 29736"},{"text":"What would you recommend ordering for a cycling enthusiast?"},{"text":"Create an order recommendation for a customer who mainly buys camping equipment"}]'

AGENT_ID=$(upsert_agent "admin-order-agent" "Sales Order Generator" "$INSTRUCTIONS" "" "$DESCRIPTION" "$STARTER_PROMPTS")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-order-agent"; exit 1; fi
success "admin-order-agent created: $AGENT_ID"
azd env set AI_AGENT_ORDER_ID "$AGENT_ID"
