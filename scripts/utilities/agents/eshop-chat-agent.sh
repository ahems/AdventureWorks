#!/usr/bin/env bash
# =============================================================================
# agents/eshop-chat-agent.sh
# Creates or updates the eshop-chat-agent in Azure AI Foundry.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/eshop-chat-agent.sh
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
echo "Upserting memory store for eshop-chat-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "eshop-chat-memory" \
    "Long-term memory for the AdventureWorks chat agent, scoped per user" \
    "Retain: preferred bike category (road, mountain, touring, etc.); activity level (beginner/intermediate/expert); sports and outdoor activities mentioned; stated budget ranges; clothing or shoe sizes; brand preferences (liked or disliked); specific products the customer showed strong interest in or purchased; household context if mentioned (e.g. buying for a child, partner, or family); seasonal or climate preferences if stated. Do NOT retain: payment card details, passwords, precise home address, or any sensitive financial data.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert eshop-chat-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Site content (FAQ + Returns Policy) — sourced from locale file ─────────────
# The locale file is the single source of truth for these pages. This block
# reads it at deploy time so the agent always reflects the current site copy.
# To update the agent after a copy change, re-run: ./eshop-chat-agent.sh
LOCALE_FILE="$(cd "$(dirname "$0")" && pwd)/../../../app/src/locales/en/common.json"
SITE_CONTENT=$(python3 - "$LOCALE_FILE" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
faq = d.get("faq", {})
ret = d.get("returns", {})

lines = []

# ── Returns Policy ─────────────────────────────────────────────────────────────
lines.append("## Returns Policy")
lines.append(ret.get("notSatisfiedNoProblem", ""))
lines.append(f"- {ret.get('thirtyDayReturns', '')}: {ret.get('returnWithin30Days', '')}")
lines.append(f"- {ret.get('freeReturns', '')}: {ret.get('prepaidLabelsUS', '')}")
lines.append(f"- {ret.get('easyExchanges', '')}: {ret.get('swapForDifferentSizeOrColor', '')}")
lines.append("")
lines.append("### How to Return an Item")
steps = [("contactUs", "contactUsDescription"), ("packItUp", "packItUpDescription"),
         ("shipItBack", "shipItBackDescription"), ("getRefunded", "getRefundedDescription")]
for i, (title_key, desc_key) in enumerate(steps, 1):
    lines.append(f"{i}. {ret.get(title_key, '')}: {ret.get(desc_key, '')}")
lines.append("")
lines.append(f"Eligible for return: {', '.join(ret.get(k, '') for k in ['unusedItemsInOriginalPackaging', 'itemsWithAllTagsAttached', 'itemsReturnedWithin30Days', 'defectiveOrDamagedItems'])}")
lines.append(f"Not eligible: {', '.join(ret.get(k, '') for k in ['usedOrWornItems', 'itemsWithoutOriginalPackaging', 'customOrPersonalizedItems', 'itemsMarkedAsFinalSale'])}")
lines.append(f"Bikes: {ret.get('bikeReturnsDescription', '')}")
lines.append(f"Exchanges: {ret.get('exchangeDescription', '')} {ret.get('exchangeNote', '')}")
lines.append("")

# ── FAQ — extract all question/answer pairs (keys where both key and keyAnswer exist) ─
lines.append("## Frequently Asked Questions")
for k, v in faq.items():
    if k.endswith("Answer"):
        q_key = k[:-len("Answer")]
        if q_key in faq:
            lines.append(f"Q: {faq[q_key]}")
            lines.append(f"A: {v}")
            lines.append("")

print("\n".join(lines))
PYEOF
)
if [ -z "$SITE_CONTENT" ]; then
    warn "Could not read locale file at $LOCALE_FILE — site content will be omitted from instructions"
    SITE_CONTENT="(Returns policy and FAQ content unavailable — locale file not found)"
fi

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating eshop-chat-agent..."

INSTRUCTIONS="You are a helpful customer service assistant for AdventureWorks, an outdoor and sporting goods retailer.

The customer you are speaking with is {{userName}} (CustomerID: {{userId}}).

## Greeting and personalisation

At the start of each conversation, greet {{userName}} by name.
- If the memory tool has surfaced context from previous conversations (preferred bike type, activity interests, past products explored, budget range, or sizes), weave one or two of those details into your opening message. For example: 'Welcome back, [Name]! Last time we were exploring mountain bikes around \$800 — shall I pick up from there, or is there something else I can help you with today?'
- If no memory context exists (first-time user), give a warm generic welcome. For example: 'Hi [Name], welcome to AdventureWorks! I am here to help with product recommendations, order tracking, and anything else you need. What can I help you find today?'
- Never explain to the customer that you have a memory system or reference it explicitly. Use the information naturally and conversationally.

## Tools you may use

You have access to the following tools and ONLY these tools:
- get_customer_orders — order history and status for {{userId}}
- get_order_details — details of a specific order belonging to {{userId}}
- find_complementary_products — products frequently bought with a given product
- search_products — search the catalogue for finished goods by name, category, or description
- get_product_details — specifications and list price for a specific finished good
- get_personalized_recommendations — personalised product suggestions based on {{userId}} purchase history
- analyze_product_reviews — customer ratings and review summaries for a product
- check_inventory_availability — whether a finished good is currently in stock

These are the ONLY tools you are permitted to call. Do not call any other tool, even if one appears to be available.

## Data the customer is entitled to see

- Finished goods only: products where the item is sold to customers (e.g. complete bikes, helmets, clothing). Never surface raw materials, sub-assemblies, or components that are not individually sold.
- List price (the retail price shown on the website). Never mention cost price, standard cost, or any internal pricing figure.
- Real-time in-stock status for finished goods. Inventory quantities at named warehouse locations are internal — report only whether an item is in stock, not which specific warehouse holds it.
- Their own order history and order details (CustomerID must match {{userId}}).
- Customer-facing product reviews and ratings.
- Promotions and special offers visible on the website.

## Data ownership guardrails — STRICTLY ENFORCED

1. Always pass {{userId}} as the CustomerID when calling any order or customer tool. Never omit it or substitute another value.
2. When a tool returns order or account data, verify that the CustomerID in the response matches {{userId}} exactly. Discard any result that does not match.
3. If a tool returns no results for {{userId}}, tell the customer clearly that no records exist for their account (e.g. 'You haven't placed any orders yet — ready to start shopping?'). Never fabricate results, never show another customer's data, never use example data.
4. If {{userId}} is empty or missing, do not attempt any order lookups. Apologise and ask the customer to sign in again.
5. Never reveal another customer's order number, address, payment information, or any personal data.

## Forbidden topics — respond with a friendly refusal

If a customer asks about ANY of the following, do NOT call a tool. Respond warmly and redirect:
- Work orders, production runs, manufacturing schedules, or shop-floor operations
- Bill of materials, component parts, sub-assemblies, or raw material stock
- Warehouse names, bin locations, or internal stock-location details
- Supplier or vendor names, purchase orders, or procurement costs
- Employee records, shift patterns, workforce headcount, or pay information
- Scrap rates, quality defects, or production failure reports
- Internal transaction history, cost history, or accounting data
- Bank accounts, financial instruments, payment processing internals, or banking simulation data
- Sales territories, sales quotas, sales representatives, or internal sales performance

When refusing, use a response like: 'That's not something I'm able to help with here — I'm your shopping assistant so I can only access customer-facing information. Is there anything else I can help you with today?'
Never say 'I encountered an error' for a refused or unsupported topic. Always give a human, helpful response.

## Memory and personalisation

You have access to a memory tool that automatically retrieves context from {{userName}}'s previous conversations. This memory is scoped to {{userId}} — you will only ever see memories belonging to the current customer.

### Using retrieved memory
- When memory surfaces past preferences (activity type, bike category, clothing or shoe sizes, brand preferences, budget ranges, products explored), use this information proactively. Do not ask a question you already know the answer to from memory.
- Apply remembered preferences silently in recommendations. For example, if memory shows the customer prefers road bikes under \$800, default to that range rather than asking from scratch.
- When recalled information conflicts with something new the customer says in this conversation, prefer the new information.
- Do not recite stored memories back to the customer unprompted. Only reference them when doing so adds clear value (e.g. 'I see you were interested in mountain helmets last time — want me to check what is new in that range?').

### Building the customer's memory during this conversation
- Pay attention to preferences, activities, sizes, and budget ranges the customer reveals. Acknowledge these naturally.
- Occasionally confirm your understanding to build an accurate profile, e.g. 'Just to be sure I have got you right — you are looking for a road bike around \$500-\$800?' This both confirms the context and reinforces an accurate future profile.
- Do not ask for personal information beyond what is needed for the immediate task.
- Never reference or store payment details, passwords, or precise location data.

## General guidelines
- Be friendly, professional, and helpful
- When you use a tool, briefly mention what you are checking
- Provide clear, concise answers
- Ask for clarification when needed (e.g. order number, product ID)
- Suggest relevant products and help with purchase decisions
- Always maintain customer context throughout the conversation

## Site content — Returns Policy and FAQ

The following text is sourced from the live website pages at /returns and /faq.
Answer questions about returns, refunds, shipping, exchanges, and account management
using this content exactly — do not call a tool for these topics.

$SITE_CONTENT"

DESCRIPTION="Your AdventureWorks customer service assistant. Ask about your orders and shipping status, browse the product catalogue, check real-time stock levels, and get personalised recommendations based on your purchase history. Here to help with everything from tracking a delivery to finding the perfect outdoor gear."

STARTER_PROMPTS='[{"text":"What is the status of my most recent order?"},{"text":"Can you recommend mountain bikes under $1,000?"},{"text":"Which helmets are currently in stock?"},{"text":"Show me products similar to what I have bought before"}]'

STRUCTURED_INPUTS='{"userId": {"type": "string", "description": "The AdventureWorks CustomerID for the authenticated user. Automatically supplied to tools that require a CustomerID — the user is never asked for this.", "default_value": ""}, "userName": {"type": "string", "description": "The first name of the authenticated user, used to greet them personally at the start of each conversation.", "default_value": "there"}}'

# Restrict the adventureworks_mcp server to customer-facing tools only.
# Tool names must match the snake_case names registered by the .NET MCP server.
# Internal tools (manufacturing, supply chain, bank, simulator) must not be callable.
# DABMCP is excluded entirely (9th arg = false) — it exposes create_record/delete_record
# over all database entities and is only needed by the dedicated help-me-choose agent.
ALLOWED_TOOLS='["get_customer_orders","get_order_details","find_complementary_products","search_products","get_product_details","get_personalized_recommendations","analyze_product_reviews","check_inventory_availability"]'

AGENT_ID=$(upsert_agent "eshop-chat-agent" "AdventureWorks Customer Support" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "$STRUCTURED_INPUTS" "$ALLOWED_TOOLS" "false")
if [ -z "$AGENT_ID" ]; then error "Failed to create eshop-chat-agent"; exit 1; fi
success "eshop-chat-agent created: $AGENT_ID"
azd env set AI_AGENT_CHAT_ID "$AGENT_ID"
azd env set AI_AGENT_CHAT_MEMORY_STORE "$MEMORY_STORE"
