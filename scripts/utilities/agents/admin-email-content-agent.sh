#!/usr/bin/env bash
# =============================================================================
# agents/admin-email-content-agent.sh
# Creates or updates the admin-email-content-agent in Azure AI Foundry.
#
# This agent generates personalised email subjects and bodies for various
# marketing and transactional email templates (cart recovery, order follow-up,
# loyalty rewards, etc.).
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-email-content-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

# Set up shared project connections when running standalone.
[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Memory store ───────────────────────────────────────────────────────────────
echo "Upserting memory store for admin-email-content-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-email-content-memory" \
    "Long-term memory for the AdventureWorks email content agent" \
    "Retain brand voice guidelines, successful subject line patterns, and per-template-type tone calibration. Do not store customer personal data.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-email-content-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-email-content-agent..."

INSTRUCTIONS='You are an email marketing specialist for AdventureWorks, an outdoor and sporting goods retailer.

## Your task
Generate a personalised email subject line and body based on the template type and customer context provided.

## Inputs (resolved at runtime)
- Customer first name: {{firstName}}
- Template type: {{templateType}}
- Total orders (optional): {{totalOrders}}
- Total spent (optional): {{totalSpent}}
- Cart value (optional): {{cartValue}}
- Last order ID (optional): {{lastOrderId}}
- Product names (optional): {{productNames}}

## Requirements
1. The tone should be warm, friendly, and on-brand for AdventureWorks
2. Keep the body concise (3-5 short paragraphs)
3. Personalise using the customer first name and context data
4. Match the urgency and style to the template type:
   - cart_recovery: create urgency, mention specific products
   - order_followup: thank them, ask for feedback
   - loyalty_reward: celebrate their milestone, offer incentive
   - win_back: re-engage lapsed customer warmly
   - new_product: excitement about new arrivals

## Response format
Return ONLY a valid JSON object with exactly two fields:
```json
{
  "subject": "Your compelling subject line here",
  "body": "The email body here with paragraphs separated by newlines"
}
```

No markdown fences, no explanation — just the JSON object.'

DESCRIPTION="Generates personalised email subject lines and bodies for AdventureWorks marketing and transactional emails. Supports multiple template types (cart recovery, order follow-up, loyalty reward, win-back, new product). Returns JSON with subject and body fields."

STARTER_PROMPTS='[{"text":"Write a cart recovery email"},{"text":"Generate a loyalty reward email"},{"text":"Create an order follow-up email"}]'

AGENT_ID=$(upsert_agent "admin-email-content-agent" "Email Content Generator" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "{}" "[]" "false")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-email-content-agent"; exit 1; fi
success "admin-email-content-agent created: $AGENT_ID"
azd env set AI_AGENT_EMAIL_CONTENT_ID "$AGENT_ID"
azd env set AI_AGENT_EMAIL_CONTENT_MEMORY_STORE "$MEMORY_STORE"
