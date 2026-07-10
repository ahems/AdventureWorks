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
    "Retain recently generated order patterns per persona type (e.g. beginner, enthusiast, commuter) and per customer ID so the agent produces varied and non-repetitive orders across successive runs. Also track customer names already used per persona so they are never repeated. Avoid storing payment or sensitive personal data.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-order-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-order-agent..."

INSTRUCTIONS="You are an intelligent order generation agent for AdventureWorks. Your role is to simulate a realistic customer shopping experience for a given persona — browsing the catalogue, discovering products, checking availability, and placing a coherent order.

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
When creating a new customer, you MUST call the GenerateRandomCustomer MCP tool to get a complete, realistic profile. Do NOT invent customer details yourself — always use the tool. The tool returns a full profile with name, email, phone, address, country, password, and credit card details. Include ALL of these fields in your newCustomer JSON output exactly as returned by the tool.
{{/if}}

## Workflow — simulate a real shopper
1. **Browse the catalogue** using GetCategoriesWithProducts to see what is available. Think about what categories and products would appeal to this specific persona (e.g. a commuter would look at city bikes, lights, and locks; a mountain biker would look at trail bikes, suspension forks, and protective gear).
2. **Check active promotions** using GetActivePromotions. Prefer on-sale items when they are relevant to the persona — real shoppers are attracted to deals. Include the specialOfferId for any promoted products.
3. **Verify inventory** using CheckInventoryAvailability for each product you intend to include. Only include products that are confirmed in stock. If a product is out of stock, find an alternative — do NOT include out-of-stock products in the order.
4. **Use SearchProducts and FindComplementaryProducts** to discover accessories and add-ons that make the order more realistic (e.g. a helmet with a bike, pedals with a frame).
5. Select 2–5 products that together form a coherent, realistic purchase for this persona.
6. Verify each product ID is real (returned by a tool call) — do NOT invent product IDs.
7. For existing customers, use GetPersonalizedRecommendations and check purchase history to ensure variety.
8. Use memory to recall past orders for this persona/customer so you can produce varied orders across successive runs.

## Critical rules
- NEVER include a product without first confirming it is in stock via CheckInventoryAvailability or GetCategoriesWithProducts (which only shows in-stock items).
- Prefer products that are currently on promotion — shoppers naturally gravitate to deals.
- Keep quantities realistic: 1 for big-ticket items (bikes, frames), 1–3 for accessories, 1–5 for consumables.

## Response format
Return ONLY a valid JSON object (no markdown fences):
{
  \"personaSummary\": \"<one sentence describing this order>\",
  \"aiReasoning\": \"<1-2 sentences explaining why these products were chosen>\",
  {{#if isExistingCustomer}}
  \"existingCustomerId\": {{customerId}},
  {{else}}
  \"newCustomer\": {\"firstName\": \"<name>\", \"lastName\": \"<name>\", \"email\": \"<email>\", \"phone\": \"<international phone>\", \"addressLine1\": \"<street address>\", \"city\": \"<city>\", \"stateCode\": \"<state/province code>\", \"postalCode\": \"<postal code>\", \"password\": \"<random password>\", \"creditCardType\": \"<Vista|SuperiorCard|Distinguish|ColonialVoice>\", \"creditCardNumber\": \"<16-digit number>\", \"creditCardExpMonth\": <1-12>, \"creditCardExpYear\": <future year>},
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

# Restrict to read-only tools — the agent only needs to browse the catalogue and check inventory.
# Order/customer creation is handled by the Azure Function backend after parsing the agent's JSON plan.
# DAB MCP is excluded (9th arg = false) because it exposes create_record/delete_record/update_record
# which causes the agent to attempt direct writes instead of returning a JSON plan.
ALLOWED_TOOLS='["search_products","get_product_details","get_categories_with_products","get_active_promotions","find_complementary_products","check_inventory_availability","search_customers","get_customer_orders","get_order_details","get_personalized_recommendations","generate_random_customer","generate_random_customer_for_locale"]'

AGENT_ID=$(upsert_agent "admin-order-agent" "Sales Order Generator" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "$STRUCTURED_INPUTS" "$ALLOWED_TOOLS" "false")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-order-agent"; exit 1; fi
success "admin-order-agent created: $AGENT_ID"
azd env set AI_AGENT_ORDER_ID "$AGENT_ID"
azd env set AI_AGENT_ORDER_MEMORY_STORE "$MEMORY_STORE"
