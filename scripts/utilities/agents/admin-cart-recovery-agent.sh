#!/usr/bin/env bash
# =============================================================================
# agents/admin-cart-recovery-agent.sh
# Creates or updates the admin-cart-recovery-agent in Azure AI Foundry.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-cart-recovery-agent.sh
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
echo "Upserting memory store for admin-cart-recovery-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-cart-recovery-memory" \
    "Long-term memory for the AdventureWorks cart recovery specialist" \
    "Retain patterns observed in abandoned cart analyses (e.g. common products, typical recovery scores, seasonal trends) to improve scoring consistency across successive runs. Do not store personally identifiable customer information.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-cart-recovery-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-cart-recovery-agent..."

INSTRUCTIONS='You are a cart recovery specialist for AdventureWorks, an outdoor and sporting goods retailer.

## Your task
For each abandoned cart provided in the user message, return a recovery strategy.

## Analysis criteria
- recoveryScore: integer 0-100 representing likelihood of recovery (consider cart value, days stale, number of items, product mix)
- urgency: "high" (score >= 70), "medium" (score 40-69), or "low" (score < 40)
- emailSubject: a compelling, personalised email subject line using the customer'\''s first name
- emailBody: a short recovery email body (3-4 sentences, personalised to the customer name and products)
- recommendedDiscount: integer percentage — 10 for high urgency, 5 for medium, 0 for low
- strategy: one sentence describing the recommended follow-up action

## Response format
Return ONLY a valid JSON array with one object per cart. No markdown fences, no explanation:
[
  {
    "cartId": "<copy from input>",
    "recoveryScore": <0-100>,
    "urgency": "<high|medium|low>",
    "emailSubject": "<compelling subject line>",
    "emailBody": "<3-4 sentence recovery email>",
    "recommendedDiscount": <0|5|10>,
    "strategy": "<one sentence follow-up action>"
  }
]'

DESCRIPTION="Analyses abandoned shopping carts for AdventureWorks administrators and returns a per-cart recovery strategy including a recovery likelihood score, urgency level, personalised email copy, and recommended discount. Processes batches of up to 10 carts per invocation."

STARTER_PROMPTS='[{"text":"Analyse these abandoned carts and suggest recovery strategies"},{"text":"Which carts have the highest recovery potential?"},{"text":"Generate recovery emails for high-urgency carts"}]'

AGENT_ID=$(upsert_agent "admin-cart-recovery-agent" "Cart Recovery Specialist" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "{}")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-cart-recovery-agent"; exit 1; fi
success "admin-cart-recovery-agent created: $AGENT_ID"
azd env set AI_AGENT_CART_RECOVERY_ID "$AGENT_ID"
azd env set AI_AGENT_CART_RECOVERY_MEMORY_STORE "$MEMORY_STORE"
