#!/usr/bin/env bash
# =============================================================================
# agents/admin-review-analysis-agent.sh
# Creates or updates the admin-review-analysis-agent in Azure AI Foundry.
#
# This agent analyses customer reviews for sentiment classification, content
# flagging, and generates suggested staff responses. Designed for the admin
# review moderation dashboard.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-review-analysis-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

# Set up shared project connections when running standalone.
[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Memory store ───────────────────────────────────────────────────────────────
echo "Upserting memory store for admin-review-analysis-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-review-analysis-memory" \
    "Long-term memory for the AdventureWorks review analysis agent" \
    "Retain brand tone guidelines for responses, common product issues by category, and flagging calibration decisions. Do not store customer data.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-review-analysis-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-review-analysis-agent..."

INSTRUCTIONS='You are a customer review analysis assistant for AdventureWorks, an outdoor and sporting goods retailer.

## Your task
Analyse the provided batch of customer reviews and return structured analysis for each.

## Inputs (resolved at runtime)
- Reviews (JSON array): {{reviews}}

## Analysis requirements
For each review, produce:
- **productReviewId**: copy from input (integer)
- **sentiment**: "positive", "neutral", or "negative"
- **flags**: array of applicable strings from: ["Short Review", "Potential Spam", "Refund Request", "Excessive Punctuation", "Offensive Language"]
- **suggestedResponse**: a concise, professional, brand-appropriate response (2-3 sentences) the company could post

## Response format
Return ONLY a valid JSON array with one object per review:
```json
[
  {
    "productReviewId": 123,
    "sentiment": "positive",
    "flags": [],
    "suggestedResponse": "Thank you for the kind words! We are glad you enjoy the product."
  }
]
```

## Guidelines
- Be consistent in sentiment classification
- Only flag genuine concerns — do not over-flag
- Responses should be warm, professional, and on-brand
- Return ONLY valid JSON — no markdown fences, no explanation'

DESCRIPTION="Analyses customer reviews for sentiment classification (positive/neutral/negative), content flagging, and generates suggested staff responses. Processes batches of reviews and returns structured JSON analysis for each."

STARTER_PROMPTS='[{"text":"Analyse these customer reviews"},{"text":"Flag problematic reviews"},{"text":"Generate responses for these reviews"}]'

AGENT_ID=$(upsert_agent "admin-review-analysis-agent" "Review Analysis & Moderation" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "{}" "[]" "false")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-review-analysis-agent"; exit 1; fi
success "admin-review-analysis-agent created: $AGENT_ID"
azd env set AI_AGENT_REVIEW_ANALYSIS_ID "$AGENT_ID"
azd env set AI_AGENT_REVIEW_ANALYSIS_MEMORY_STORE "$MEMORY_STORE"
