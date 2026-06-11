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

# ── Memory store ───────────────────────────────────────────────────────────────
echo "Upserting memory store for admin-order-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-order-memory" \
    "Long-term memory for the AdventureWorks order generation agent, scoped per persona or customer" \
    "Retain recently generated order patterns per persona type (e.g. beginner, enthusiast, commuter) and per customer ID so the agent produces varied and non-repetitive orders across successive runs. Avoid storing payment or sensitive personal data.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-order-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-order-agent..."

INSTRUCTIONS="You are an intelligent order generation agent for AdventureWorks. Your role is to design a realistic, data-driven purchase order for a given customer persona.

## Context
- Today's date:   {{todayDate}}
- Persona:        {{personaDescription}}
{{#if isExistingCustomer}}
## Existing customer
- Name:              {{customerName}}
- Customer ID:       {{customerId}}
- Previous orders:   {{orderCount}}
- Total spend:       \${{totalSpend}}
- Recent purchases:  {{recentProducts}}

Design a complementary order that extends or refreshes this customer's existing gear. Avoid duplicating recently purchased items unless they are consumables (e.g. lubricant, tubes, nutrition).
{{else}}
## New customer
Design a realistic starter order appropriate to the persona description. Use SearchProducts or GetProductDetails to find in-stock products suitable for this profile. Create a plausible new customer (realistic first name, last name, and email address).
{{/if}}

## Workflow
1. Use SearchProducts and/or GetProductDetails to browse the live AdventureWorks catalogue for products matching the persona profile
2. Select 2–5 products that together form a coherent, realistic purchase for this persona
3. Verify each product ID is real (returned by a tool call) — do NOT invent product IDs
4. Check inventory availability; skip out-of-stock products
5. For existing customers, search for active promotions or bundle deals via the SpecialOffer entity
6. Use memory to recall past orders for this persona/customer so you can produce varied orders across successive runs

## Response format
Return ONLY a valid JSON object (no markdown fences):
{
  \"personaSummary\": \"<one sentence describing this order>\",
  \"aiReasoning\": \"<1-2 sentences explaining why these products were chosen>\",
  {{#if isExistingCustomer}}
  \"existingCustomerId\": {{customerId}},
  {{else}}
  \"newCustomer\": {\"firstName\": \"<name>\", \"lastName\": \"<name>\", \"emailAddress\": \"<email>\", \"city\": \"<city>\", \"stateProvince\": \"<state>\", \"countryRegion\": \"<country>\"},
  {{/if}}
  \"orderItems\": [
    {\"productId\": <number>, \"productName\": \"<name>\", \"quantity\": <1-5>, \"unitPrice\": <number>, \"specialOfferId\": <1 or valid offer ID>}
  ]
}"

DESCRIPTION="Generates realistic AI-driven purchase orders for AdventureWorks. Supports both new-customer creation and existing-customer reorders. Uses live product data and inventory checks via MCP tools to ensure all products are in stock. Supports multi-turn refinement and memory-scoped variance across successive runs."

STARTER_PROMPTS='[{"text":"Generate a beginner cyclist order"},{"text":"Create an order for an experienced mountain biker"},{"text":"Generate an order for a family buying bikes and helmets"},{"text":"Create a reorder for an existing road cyclist customer"}]'

# Structured inputs resolve Handlebars templates in agent instructions.
# todayDate, personaDescription, isExistingCustomer are always injected.
# customerName, customerId, orderCount, totalSpend, recentProducts are only injected for existing customers.
STRUCTURED_INPUTS='{
  "todayDate":          {"type": "string",  "description": "Today'\''s date (YYYY-MM-DD) for campaign and order date calculations.", "default_value": ""},
  "personaDescription": {"type": "string",  "description": "Description of the customer persona being simulated (e.g. beginner cyclist, family shopper).", "default_value": "A generic AdventureWorks customer"},
  "isExistingCustomer": {"type": "boolean", "description": "True when generating an order for an existing customer with purchase history; false for a new customer.", "default_value": false},
  "customerName":       {"type": "string",  "description": "Full name of the existing customer (only set when isExistingCustomer is true).", "default_value": ""},
  "customerId":         {"type": "string",  "description": "CustomerID of the existing customer (only set when isExistingCustomer is true).", "default_value": ""},
  "orderCount":         {"type": "string",  "description": "Number of previous orders placed by this customer.", "default_value": ""},
  "totalSpend":         {"type": "string",  "description": "Total lifetime spend by this customer formatted as a number.", "default_value": ""},
  "recentProducts":     {"type": "string",  "description": "Comma-separated list of recent product names purchased by this customer.", "default_value": ""}
}'

AGENT_ID=$(upsert_agent "admin-order-agent" "Sales Order Generator" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "$STRUCTURED_INPUTS")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-order-agent"; exit 1; fi
success "admin-order-agent created: $AGENT_ID"
azd env set AI_AGENT_ORDER_ID "$AGENT_ID"
azd env set AI_AGENT_ORDER_MEMORY_STORE "$MEMORY_STORE"
