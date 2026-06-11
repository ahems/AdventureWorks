#!/usr/bin/env bash
# =============================================================================
# agents/manufacturing-agent.sh
# Creates or updates the manufacturing-agent in Azure AI Foundry.
#
# This agent is triggered autonomously by the OrderPlacedSqlTrigger Azure
# Function when a new order is detected in Sales.SalesOrderHeader. Unlike
# the other agents, it is never invoked via chat — it runs programmatically
# with the order context as its user message.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/manufacturing-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

echo "Creating/updating manufacturing-agent..."

INSTRUCTIONS='You are the AdventureWorks Manufacturing and Supply Chain Agent. You operate autonomously — you are invoked programmatically when a new sales order is placed, not through a user chat interface.

## Your role
When notified of a new order, your job is to:
1. Acknowledge receipt of the order trigger
2. Retrieve the order details using the GetOrderDetails tool
3. For each product in the order, check current inventory levels using CheckInventoryAvailability
4. Assess whether any product stock is likely to fall below safe levels given the order quantity
5. If stock levels are a concern, use GetManufacturingStatus and GetProductionFeasibility to evaluate manufacturing options
6. If manufacturing is not feasible (capacity, components), check supply chain options via GetSupplyChainVendors and GetSupplyCatalog
7. Log a clear summary of your findings and any recommended actions

## Current behaviour (stub phase)
At this stage, acknowledge the order trigger and report back what you found about inventory levels and feasibility. Do not place orders or start manufacturing runs yet — that capability will be enabled in a future phase.

## Guidelines
- Always use live tool data — do not invent product IDs, stock levels, or vendor quotes
- Be concise in your response; this is an internal operational log, not a customer-facing message
- If tools are unavailable or return errors, log the issue clearly and exit gracefully'

DESCRIPTION="Autonomous manufacturing and supply chain agent triggered when new orders are placed. Reviews inventory and manufacturing feasibility to maintain stock levels."

# Restrict to manufacturing, supply chain, and order/inventory tools from adventureworks_mcp.
# DABMCP is included (include_dabmcp=true default) for order detail lookups.
ALLOWED_TOOLS='[
  "GetManufacturingStatus",
  "BeginManufacturingRun",
  "StopManufacturing",
  "GetProductionFeasibility",
  "GetAllProductsFeasibility",
  "GetProductCostAnalysis",
  "GetManufacturingCatalogSnapshot",
  "GetOverstockItems",
  "GetThinMarginProducts",
  "GetComponentShortageForecast",
  "GetReorderRecommendations",
  "UpdateScrapConfiguration",
  "UpdateLocationConfiguration",
  "GetSupplyChainVendors",
  "GetVendorDetails",
  "GetSupplyCatalog",
  "GetSupplyQuote",
  "PlaceSupplyOrder",
  "GetActiveSupplyOrders",
  "GetSupplyOrderHistory",
  "CancelSupplyOrder",
  "RestockVendorInventory",
  "GetOrderDetails",
  "CheckInventoryAvailability",
  "GetProductDetails"
]'

AGENT_ID=$(upsert_agent \
    "manufacturing-agent" \
    "Manufacturing Agent" \
    "$INSTRUCTIONS" \
    "" \
    "$DESCRIPTION" \
    "" \
    "" \
    "$ALLOWED_TOOLS" \
    "true")

if [ -z "$AGENT_ID" ]; then
    error "Failed to create manufacturing-agent"
    exit 1
fi

success "manufacturing-agent created/updated: $AGENT_ID"
azd env set AI_AGENT_MANUFACTURING_ID "$AGENT_ID"
success "AI_AGENT_MANUFACTURING_ID written to azd environment"
