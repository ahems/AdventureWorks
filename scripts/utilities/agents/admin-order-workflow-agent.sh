#!/usr/bin/env bash
# =============================================================================
# agents/admin-order-workflow-agent.sh
# Creates or updates the admin-order-workflow-agent in Azure AI Foundry.
#
# This is a "kind: workflow" agent — a declarative orchestration agent that
# routes admin order-generation requests. It determines whether the admin wants
# to generate an order for a new or existing customer, gathers the appropriate
# details via Q&A, then delegates to admin-order-agent which uses live MCP data.
#
# The YAML definition lives in workflows/admin-order-advisor.yaml and is read
# at deploy time — re-run this script whenever the YAML changes.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-order-workflow-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
#
# Prerequisites:
#   - admin-order-agent must already exist
#     (run admin-order-agent.sh first, or use the orchestrator)
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Create admin-order-intent-agent (micro-agent, no tools) ──────────────────
INTENT_AGENT_NAME="admin-order-intent-agent"
INTENT_AGENT_INSTRUCTIONS="You are an intent classifier for an AdventureWorks order generator.

Given the admin user's message, classify whether they want to generate an order for an existing customer or a brand-new customer persona.

Respond with EXACTLY ONE WORD — no explanation, no punctuation, no additional text:

  EXISTING_CUSTOMER
    Use when the admin provides or mentions a customer ID, an existing customer name,
    or phrases like 'for customer', 'existing customer', 'reorder for', 'customer ID'.

  NEW_CUSTOMER
    Use for everything else: persona descriptions (e.g. 'beginner cyclist',
    'family shopper'), requests without a customer ID, or when the admin says
    'new customer', 'simulate', 'persona', or similar.

Only output one of those two words."

echo "Creating/updating $INTENT_AGENT_NAME..."

TOKEN_INTENT=$(get_ai_token)
INTENT_BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'name':        sys.argv[1],
    'description': 'Minimal intent classifier for the admin-order-workflow. Returns EXISTING_CUSTOMER or NEW_CUSTOMER.',
    'metadata':    {'display_name': 'Order Intent Classifier'},
    'definition': {
        'kind':         'prompt',
        'model':        sys.argv[2],
        'instructions': sys.argv[3],
        'tools':        []
    }
}))
" "$INTENT_AGENT_NAME" "$CHAT_GPT_DEPLOYMENT" "$INTENT_AGENT_INSTRUCTIONS")

INTENT_GET=$(curl -s -o /tmp/_order_intent_get.json -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN_INTENT" \
    "${PROJECT_ENDPOINT}/agents/${INTENT_AGENT_NAME}?api-version=${API_VERSION}" 2>/dev/null)

if [ "$INTENT_GET" = "200" ]; then
    INTENT_HTTP=$(curl -s -o /tmp/_order_intent_resp.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $TOKEN_INTENT" \
        -H "Content-Type: application/json" \
        -d "$INTENT_BODY" \
        "${PROJECT_ENDPOINT}/agents/${INTENT_AGENT_NAME}?api-version=${API_VERSION}" 2>/dev/null)
else
    INTENT_HTTP=$(curl -s -o /tmp/_order_intent_resp.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $TOKEN_INTENT" \
        -H "Content-Type: application/json" \
        -d "$INTENT_BODY" \
        "${PROJECT_ENDPOINT}/agents?api-version=${API_VERSION}" 2>/dev/null)
fi

INTENT_RESPONSE=$(cat /tmp/_order_intent_resp.json 2>/dev/null || true)
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
YAML_PATH="$(cd "$(dirname "$0")" && pwd)/../../../workflows/admin-order-advisor.yaml"

if [ ! -f "$YAML_PATH" ]; then
    error "Workflow YAML not found at: $YAML_PATH"
    exit 1
fi

YAML_CONTENT=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    content = f.read()
print(content)
" "$YAML_PATH")

if [ -z "$YAML_CONTENT" ]; then
    error "Failed to read workflow YAML from $YAML_PATH"
    exit 1
fi

# ── Agent metadata ─────────────────────────────────────────────────────────────
AGENT_NAME="admin-order-workflow-agent"
DISPLAY_NAME="AdventureWorks Order Advisor Workflow"
DESCRIPTION="Intelligent workflow agent for AdventureWorks admin order generation. Determines whether the admin wants a new-customer or existing-customer order, gathers the required details via Q&A, then delegates to the order agent which uses live product and inventory data via MCP to produce a realistic, database-ready order."

# ── Upsert the workflow agent via Foundry data-plane API ──────────────────────
echo "Creating/updating $AGENT_NAME..."

TOKEN=$(get_ai_token)
if [ -z "$TOKEN" ]; then
    error "Failed to obtain Azure AD token"
    exit 1
fi

BASE_URL="${PROJECT_ENDPOINT}/agents"
API_QS="api-version=${API_VERSION}"

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

GET_STATUS=$(curl -s -o /tmp/_order_wf_get.json -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Foundry-Features: WorkflowAgents=V1Preview" \
    "${BASE_URL}/${AGENT_NAME}?${API_QS}" 2>/dev/null)

if [ "$GET_STATUS" = "200" ]; then
    echo "  (updating existing workflow agent '$AGENT_NAME')" >&2
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
    HTTP_CODE=$(curl -s -o /tmp/_order_wf_resp.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -H "Foundry-Features: WorkflowAgents=V1Preview" \
        -d "$UPDATE_BODY" \
        "${BASE_URL}/${AGENT_NAME}?${API_QS}" 2>/dev/null)
else
    HTTP_CODE=$(curl -s -o /tmp/_order_wf_resp.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -H "Foundry-Features: WorkflowAgents=V1Preview" \
        -d "$REQUEST_BODY" \
        "${BASE_URL}?${API_QS}" 2>/dev/null)
fi

RESPONSE=$(cat /tmp/_order_wf_resp.json 2>/dev/null || true)

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
azd env set AI_AGENT_WORKFLOW_ORDER_ID "$AGENT_ID"
