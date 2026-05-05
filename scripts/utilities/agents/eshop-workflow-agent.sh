#!/usr/bin/env bash
# =============================================================================
# agents/eshop-workflow-agent.sh
# Creates or updates the chat-product-advisor workflow agent in Azure AI Foundry.
#
# This is a "kind: workflow" agent — a declarative orchestration agent that
# routes chat messages between the eshop-chat-agent and eshop-help-me-choose-agent.
# When a customer asks for product recommendations, the workflow gathers their
# preferences through Q&A and delegates to the product advisor; all other requests
# are handled directly by the chat agent.
#
# The YAML definition lives in workflows/chat-product-advisor.yaml and is read at
# deploy time — re-run this script whenever the YAML changes.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/eshop-workflow-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
#
# Prerequisites:
#   - eshop-chat-agent and eshop-help-me-choose-agent must already exist
#     (run eshop-chat-agent.sh and eshop-help-me-choose-agent.sh first, or
#      use the orchestrator which runs all scripts in the correct order)
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

# Set up shared project connections when running standalone.
# The orchestrator sets FOUNDRY_CONNECTIONS_READY=1 before calling this script,
# which skips the duplicate connection upserts.
[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Create eshop-intent-agent (micro-agent, no tools) ─────────────────────────
# The workflow YAML invokes this agent in an isolated conversation to classify the
# user's intent as PRODUCT_ADVISOR or CHAT.  It is intentionally minimal:
#   - no MCP tools (to keep latency low and the output predictable)
#   - no memory store
#   - plain text response (one word)
# The agent is distinct from eshop-chat-agent so its classification replies never
# appear in the main chat conversation history.
INTENT_AGENT_NAME="eshop-intent-agent"
INTENT_AGENT_INSTRUCTIONS="You are an intent classifier for an outdoor sports e-commerce assistant.

Given the customer's message, classify whether they are asking for help CHOOSING or RECOMMENDING a product.

Respond with EXACTLY ONE WORD — no explanation, no punctuation, no additional text:

  PRODUCT_ADVISOR
    Use when the customer wants to find, choose, or receive recommendations for a product.
    Examples: 'help me choose a bike', 'what mountain bike should I buy', 'recommend a helmet under \$100', 'I need new running shoes', 'suggest a gift for a cyclist'.

  CHAT
    Use for everything else: order status, returns, delivery, account help, greetings, general questions, complaints, or any request that is not about selecting a product.

Only output one of those two words."

echo "Creating/updating $INTENT_AGENT_NAME..."

TOKEN_INTENT=$(get_ai_token)
INTENT_BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'name':        sys.argv[1],
    'description': 'Minimal intent classifier used by the chat-product-advisor workflow. Returns PRODUCT_ADVISOR or CHAT.',
    'metadata':    {'display_name': 'Intent Classifier'},
    'definition': {
        'kind':         'prompt',
        'model':        sys.argv[2],
        'instructions': sys.argv[3],
        'tools':        []
    }
}))
" "$INTENT_AGENT_NAME" "$CHAT_GPT_DEPLOYMENT" "$INTENT_AGENT_INSTRUCTIONS")

INTENT_GET=$(curl -s -o /tmp/_intent_get.json -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN_INTENT" \
    "${PROJECT_ENDPOINT}/agents/${INTENT_AGENT_NAME}?api-version=${API_VERSION}" 2>/dev/null)

if [ "$INTENT_GET" = "200" ]; then
    # Update
    INTENT_HTTP=$(curl -s -o /tmp/_intent_resp.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $TOKEN_INTENT" \
        -H "Content-Type: application/json" \
        -d "$INTENT_BODY" \
        "${PROJECT_ENDPOINT}/agents/${INTENT_AGENT_NAME}?api-version=${API_VERSION}" 2>/dev/null)
else
    # Create
    INTENT_HTTP=$(curl -s -o /tmp/_intent_resp.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $TOKEN_INTENT" \
        -H "Content-Type: application/json" \
        -d "$INTENT_BODY" \
        "${PROJECT_ENDPOINT}/agents?api-version=${API_VERSION}" 2>/dev/null)
fi

INTENT_RESPONSE=$(cat /tmp/_intent_resp.json 2>/dev/null || true)
if ! echo "$INTENT_RESPONSE" | python3 -c "import json,sys; json.load(sys.stdin)" > /dev/null 2>&1; then
    error "API call failed for $INTENT_AGENT_NAME (HTTP $INTENT_HTTP). Response: $INTENT_RESPONSE"
    exit 1
fi
INTENT_ID=$(echo "$INTENT_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
if [ -z "$INTENT_ID" ]; then
    error "Failed to extract agent ID from response (HTTP $INTENT_HTTP): $INTENT_RESPONSE"
    exit 1
fi
success "$INTENT_AGENT_NAME created/updated: $INTENT_ID"

# ── Locate the workflow YAML file ─────────────────────────────────────────────
YAML_PATH="$(cd "$(dirname "$0")" && pwd)/../../../workflows/chat-product-advisor.yaml"

if [ ! -f "$YAML_PATH" ]; then
    error "Workflow YAML not found at: $YAML_PATH"
    exit 1
fi

# ── Read the YAML file and inline it as a JSON-safe string ───────────────────
# python3 reads the file and emits a properly JSON-escaped string value.
YAML_CONTENT=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    content = f.read()
# Output as a JSON string (with escaping) — strip the surrounding quotes so
# it can be embedded inside a larger python3 JSON payload below.
print(content)
" "$YAML_PATH")

if [ -z "$YAML_CONTENT" ]; then
    error "Failed to read workflow YAML from $YAML_PATH"
    exit 1
fi

# ── Agent metadata ─────────────────────────────────────────────────────────────
AGENT_NAME="eshop-workflow-agent"
DISPLAY_NAME="AdventureWorks Product Advisor Workflow"
DESCRIPTION="Intelligent routing agent for AdventureWorks customer chat. Detects product-recommendation requests and guides customers through a Q&A to gather preferences, then delegates to the product-advisor agent for tailored recommendations. All other requests are handled by the chat agent."

# ── Upsert the workflow agent via Foundry data-plane API ──────────────────────
echo "Creating/updating $AGENT_NAME..."

TOKEN=$(get_ai_token)
if [ -z "$TOKEN" ]; then
    error "Failed to obtain Azure AD token"
    exit 1
fi

BASE_URL="${PROJECT_ENDPOINT}/agents"
API_QS="api-version=${API_VERSION}"

# Build the workflow agent request body.
# kind: "workflow" agents use definition.workflow (the YAML string) instead of
# the prompt-agent fields (model, instructions, tools).
REQUEST_BODY=$(python3 -c "
import json, sys
yaml_content = sys.argv[1]
print(json.dumps({
    'name':        sys.argv[2],
    'description': sys.argv[3],
    'metadata':    {'display_name': sys.argv[4]},
    'definition': {
        'kind':     'workflow',
        'workflow': yaml_content
    }
}))
" "$YAML_CONTENT" "$AGENT_NAME" "$DESCRIPTION" "$DISPLAY_NAME")

# Check whether the agent already exists
GET_STATUS=$(curl -s -o /tmp/_wf_get.json -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Foundry-Features: WorkflowAgents=V1Preview" \
    "${BASE_URL}/${AGENT_NAME}?${API_QS}" 2>/dev/null)

if [ "$GET_STATUS" = "200" ]; then
    # Update: POST /agents/{name}  (adds a new version if the definition changed)
    echo "  (updating existing workflow agent '$AGENT_NAME')" >&2
    # Update body omits the top-level 'name' field
    UPDATE_BODY=$(python3 -c "
import json, sys
yaml_content = sys.argv[1]
print(json.dumps({
    'description': sys.argv[2],
    'metadata':    {'display_name': sys.argv[3]},
    'definition': {
        'kind':     'workflow',
        'workflow': yaml_content
    }
}))
" "$YAML_CONTENT" "$DESCRIPTION" "$DISPLAY_NAME")
    HTTP_CODE=$(curl -s -o /tmp/_wf_resp.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -H "Foundry-Features: WorkflowAgents=V1Preview" \
        -d "$UPDATE_BODY" \
        "${BASE_URL}/${AGENT_NAME}?${API_QS}" 2>/dev/null)
else
    # Create: POST /agents
    HTTP_CODE=$(curl -s -o /tmp/_wf_resp.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -H "Foundry-Features: WorkflowAgents=V1Preview" \
        -d "$REQUEST_BODY" \
        "${BASE_URL}?${API_QS}" 2>/dev/null)
fi

RESPONSE=$(cat /tmp/_wf_resp.json 2>/dev/null || true)

# Validate JSON response
if ! echo "$RESPONSE" | python3 -c "import json,sys; json.load(sys.stdin)" > /dev/null 2>&1; then
    error "API call failed for $AGENT_NAME (HTTP $HTTP_CODE). Response: $RESPONSE"
    exit 1
fi

AGENT_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)

if [ -z "$AGENT_ID" ]; then
    error "Failed to extract agent ID from response (HTTP $HTTP_CODE): $RESPONSE"
    exit 1
fi

success "$AGENT_NAME created/updated: $AGENT_ID"
azd env set AI_AGENT_WORKFLOW_CHAT_ID "$AGENT_ID"
