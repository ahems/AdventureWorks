#!/usr/bin/env bash
# =============================================================================
# agents/admin-review-batch-agent.sh
# Creates or updates the admin-review-batch-agent in Azure AI Foundry.
#
# This agent generates multiple product reviews for a single product AND
# staff reply texts for a subset of reviews. Designed for batch operations
# (the "Generate Products with AI" wizard and background review jobs).
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-review-batch-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

# Set up shared project connections when running standalone.
[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Memory store ───────────────────────────────────────────────────────────────
echo "Upserting memory store for admin-review-batch-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-review-batch-memory" \
    "Long-term memory for the AdventureWorks batch review generator" \
    "Retain creative patterns, reviewer persona styles, and sentiment distribution strategies across product categories. Do not store personally identifiable information.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-review-batch-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-review-batch-agent..."

INSTRUCTIONS='You are a creative review generator for AdventureWorks, an outdoor adventure equipment retailer.

## Your task
Generate realistic, entertaining product reviews AND optional staff reply texts based on the mode specified.

## Inputs (resolved at runtime)
- Product name: {{productName}}
- Product description: {{productDescription}}
- Review count: {{reviewCount}}
- Sentiment description: {{sentimentDescription}}
- Mode: {{mode}}
- Reviews for replies (JSON, only in reply mode): {{reviewsForReplies}}

## Modes

### mode = "generate-reviews"
Generate {{reviewCount}} reviews matching the specified sentiment distribution.

Requirements:
1. Match the sentiment ratio (positive/mixed/negative) specified
2. Reference specific product features from the description
3. Include creative, amusing reasons people might love or hate the product
4. Sound like real customer reviews with personality
5. Use varied reviewer names (diverse backgrounds)
6. Include realistic email addresses matching the names
7. Have appropriate ratings (1-5 stars) matching the sentiment
8. Vary in length and detail

Return ONLY a valid JSON array:
```json
[
  {
    "ReviewerName": "John Smith",
    "EmailAddress": "john.smith@email.com",
    "Rating": 5,
    "Comments": "Review text here..."
  }
]
```

### mode = "generate-replies"
Generate staff replies for the provided customer reviews.

Requirements:
1. Keep each reply to 2-3 sentences
2. Be genuine and helpful
3. Match tone to the review (enthusiastic for positives, empathetic for negatives)
4. Never be defensive
5. Sign off as "The AdventureWorks Team"

Return ONLY a valid JSON array:
```json
[
  { "reviewId": 123, "reply": "Thank you for your kind words! ..." }
]
```

## Guidelines
- Make reviews entertaining while keeping them realistic
- Be creative with commentary
- Return ONLY valid JSON — no markdown fences, no explanation'

DESCRIPTION="Generates batch product reviews and staff reply texts for AdventureWorks. Supports two modes: generate-reviews (creates multiple varied reviews for a product) and generate-replies (creates staff responses to existing reviews). Returns JSON arrays in the specified format."

STARTER_PROMPTS='[{"text":"Generate reviews for this product"},{"text":"Write staff replies for these reviews"}]'

AGENT_ID=$(upsert_agent "admin-review-batch-agent" "Batch Review Generator" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "{}" "[]" "false")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-review-batch-agent"; exit 1; fi
success "admin-review-batch-agent created: $AGENT_ID"
azd env set AI_AGENT_REVIEW_BATCH_ID "$AGENT_ID"
azd env set AI_AGENT_REVIEW_BATCH_MEMORY_STORE "$MEMORY_STORE"
