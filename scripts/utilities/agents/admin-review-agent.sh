#!/usr/bin/env bash
# =============================================================================
# agents/admin-review-agent.sh
# Creates or updates the admin-review-agent in Azure AI Foundry.
#
# This agent generates a single realistic product review written from the
# perspective of a real customer who purchased and received the product.
# Context (product name/description, customer first name, sentiment) is
# supplied via structured_inputs that resolve Handlebars templates in the
# agent instructions at runtime.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-review-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

# Set up shared project connections when running standalone.
[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Memory store ───────────────────────────────────────────────────────────────
echo "Upserting memory store for admin-review-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-review-memory" \
    "Long-term memory for the AdventureWorks verified review generator" \
    "Retain patterns about product category voice, common phrasing styles for outdoor/sporting goods reviews, and sentiment variation strategies across runs. Do not store any personally identifiable customer information.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-review-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-review-agent..."

INSTRUCTIONS='You are a review generator for AdventureWorks, an outdoor adventure equipment retailer.

## Your task
Generate a single realistic product review written from the perspective of a real customer who purchased and received the product.

## Inputs (resolved at runtime)
- Product name: {{productName}}
- Product description: {{productDescription}}
- Customer first name: {{customerFirstName}}
- Required sentiment: {{sentimentDescription}}

## Review requirements
1. Reflect the specified sentiment exactly
2. Reference the product name and, where useful, features from the description naturally — do not sound like an ad
3. Sound like an authentic personal experience from {{customerFirstName}} — specific, not generic
4. Be between 2 and 5 sentences
5. Assign a star rating (1–5) that matches the sentiment:
   - "positive (4-5 stars)" → Rating 4 or 5
   - "mixed (2-4 stars)" → Rating 2, 3, or 4
   - "mostly positive with one specific complaint (3-4 stars)" → Rating 3 or 4

## Response format
Return ONLY a valid JSON object — no markdown fences, no explanation, no extra keys:
{
  "Rating": <1-5>,
  "Comments": "<review text here>"
}'

DESCRIPTION="Generates a single realistic product review from a real customer's perspective for AdventureWorks verified review generation. Receives product name, description, customer first name, and required sentiment via structured inputs and returns a JSON object containing Rating (1-5) and Comments."

STARTER_PROMPTS='[{"text":"Generate a review for this product"},{"text":"Write a positive review from this customer"},{"text":"Create a mixed-sentiment review"}]'

AGENT_ID=$(upsert_agent "admin-review-agent" "Verified Review Generator" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "{}")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-review-agent"; exit 1; fi
success "admin-review-agent created: $AGENT_ID"
azd env set AI_AGENT_REVIEW_ID "$AGENT_ID"
azd env set AI_AGENT_REVIEW_MEMORY_STORE "$MEMORY_STORE"
