#!/usr/bin/env bash
# =============================================================================
# create-foundry-agents.sh
# Creates or updates the four AdventureWorks AI agents in Azure AI Foundry
# using the data-plane API (az rest PUT).
#
# Usage:
#   bash scripts/utilities/create-foundry-agents.sh
#
# Prerequisites:
#   - azd environment populated (run after `azd provision`)
#   - az CLI authenticated (az login)
#   - AI_FOUNDRY_PROJECT_ENDPOINT in azd env
#   - MCP_SERVICE_URL in azd env
#   - API_URL in azd env
# =============================================================================
set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}$*${NC}"; }
success() { echo -e "${GREEN}  ✓ $*${NC}"; }
warn()    { echo -e "${YELLOW}  ⚠ $*${NC}"; }
error()   { echo -e "${RED}  ✗ $*${NC}"; }

# ── Helper: read from azd env ───────────────────────────────────────────────────
get_azd_value() {
    local key="$1"
    local value
    value=$(azd env get-value "$key" 2>/dev/null | tail -n1 | tr -d '\n\r ')
    echo "$value"
}

echo ""
echo "=========================================="
echo "Creating / Updating Azure AI Foundry Agents"
echo "=========================================="
echo ""

# ── Read required environment values ───────────────────────────────────────────
PROJECT_ENDPOINT=$(get_azd_value "AI_FOUNDRY_PROJECT_ENDPOINT")
MCP_SERVICE_URL=$(get_azd_value "MCP_SERVICE_URL")
API_URL=$(get_azd_value "API_URL")
CHAT_GPT_DEPLOYMENT=$(get_azd_value "chatGptDeploymentName")
APPINSIGHTS_CONNECTION_STRING=$(get_azd_value "APPINSIGHTS_CONNECTIONSTRING")
# embeddingDeploymentName is not written back to azd env; the Bicep default is 'embedding'
EMBEDDING_DEPLOYMENT="embedding"

if [ -z "$PROJECT_ENDPOINT" ]; then
    error "AI_FOUNDRY_PROJECT_ENDPOINT is not set. Run 'azd provision' first."
    exit 1
fi
if [ -z "$MCP_SERVICE_URL" ]; then
    error "MCP_SERVICE_URL is not set. Run 'azd provision' first."
    exit 1
fi
if [ -z "$API_URL" ]; then
    error "API_URL is not set. Run 'azd provision' first."
    exit 1
fi
if [ -z "$CHAT_GPT_DEPLOYMENT" ]; then
    CHAT_GPT_DEPLOYMENT="chat"
    warn "chatGptDeploymentName not found, defaulting to: $CHAT_GPT_DEPLOYMENT"
fi

# Derive DAB MCP endpoint from the API_URL.
# API_URL may include a path component (e.g. /graphql/) — strip it to get just
# the origin (scheme + host) and append the DAB-native /mcp path.
DAB_API_ORIGIN=$(python3 -c "from urllib.parse import urlparse; u=urlparse('$API_URL'); print(u.scheme+'://'+u.netloc)")
DAB_MCP_URL="${DAB_API_ORIGIN}/mcp"

info "Project endpoint : $PROJECT_ENDPOINT"
info "MCP service URL  : $MCP_SERVICE_URL"
info "DAB MCP URL      : $DAB_MCP_URL"
info "Model deployment : $CHAT_GPT_DEPLOYMENT"
info "Embed deployment : $EMBEDDING_DEPLOYMENT"
info "App Insights     : ${APPINSIGHTS_CONNECTION_STRING:0:40}..."
echo ""

# ── API versions ────────────────────────────────────────────────────────────────
# Uses the stable v1 routes for the new Microsoft Foundry Agents Service
# (replaces the legacy date-based api-version used by the classic Assistants API)
API_VERSION="v1"
# Memory Store API is a separate preview surface with its own version
MEMORY_API_VERSION="2025-11-15-preview"

# ── Helper: get Azure AD token for AI Foundry ──────────────────────────────────
_ai_token=""
get_ai_token() {
    if [ -z "$_ai_token" ]; then
        _ai_token=$(az account get-access-token \
            --resource "https://ai.azure.com" \
            --query accessToken -o tsv 2>/dev/null)
        if [ -z "$_ai_token" ]; then
            echo "[ERROR] Failed to obtain Azure AD token for https://ai.azure.com" >&2
            return 1
        fi
    fi
    echo "$_ai_token"
}

# ── Helper: upsert a Foundry memory store (create-if-not-exists) ────────────────
# Memory stores are stateful (they accumulate memories across conversations), so
# this helper creates the store on first run and skips it on subsequent runs.
# Uses the preview Memory Store API (api-version=2025-11-15-preview).
# Returns the memory store name via stdout.
upsert_memory_store() {
    local store_name="$1"          # e.g. "aw-chat-memory"
    local description="$2"         # human-readable description
    local user_profile_details="$3" # guidance for what user data to retain

    local token
    token=$(get_ai_token) || return 1

    local base_url="${PROJECT_ENDPOINT}/memory_stores"

    # Check whether the store already exists
    local list_response
    list_response=$(curl -s \
        -H "Authorization: Bearer $token" \
        "${base_url}?api-version=${MEMORY_API_VERSION}" 2>/dev/null)

    local exists
    exists=$(echo "$list_response" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('data', [])
names = [i.get('name','') for i in items]
print('yes' if sys.argv[1] in names else 'no')
" "$store_name" 2>/dev/null)

    if [ "$exists" = "yes" ]; then
        echo "  (memory store '$store_name' already exists, skipping creation)" >&2
        echo "$store_name"
        return 0
    fi

    # Create the memory store
    local body
    body=$(python3 -c "
import json, sys
print(json.dumps({
    'name':        sys.argv[1],
    'description': sys.argv[2],
    'definition': {
        'kind':            'default',
        'chat_model':      sys.argv[3],
        'embedding_model': sys.argv[4],
        'options': {
            'chat_summary_enabled':  True,
            'user_profile_enabled':  True,
            'user_profile_details':  sys.argv[5]
        }
    }
}))
" "$store_name" "$description" "$CHAT_GPT_DEPLOYMENT" "$EMBEDDING_DEPLOYMENT" "$user_profile_details")

    local http_status
    http_status=$(curl -s -o /tmp/_mem_resp.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$body" \
        "${base_url}?api-version=${MEMORY_API_VERSION}" 2>/dev/null)

    if [[ "$http_status" == "200" || "$http_status" == "201" ]]; then
        local name
        name=$(python3 -c "import json; d=json.load(open('/tmp/_mem_resp.json')); print(d.get('name',''))" 2>/dev/null)
        echo "$name"
    else
        echo "[ERROR] Memory store creation failed (HTTP $http_status): $(cat /tmp/_mem_resp.json 2>/dev/null)" >&2
        return 1
    fi
}

# ── Helper: upsert the App Insights project connection ─────────────────────────
# Creates (or replaces) the AppInsights project connection via ARM PUT.
# This is what the Foundry portal Tracing experience reads to display traces.
# Requires:
#   - The AI Services account identity type is "SystemAssigned, UserAssigned" so
#     Foundry can manage its internal Key Vault workspace identity for ApiKey storage.
#     (The Bicep module sets this; the script patches it as a fallback.)
#   - APPINSIGHTS_CONNECTION_STRING env var must be set.
# Returns the connection name on stdout.
upsert_appinsights_connection() {
    local conn_name="${1:-AppInsights}"

    if [ -z "$APPINSIGHTS_CONNECTION_STRING" ]; then
        warn "APPINSIGHTS_CONNECTIONSTRING not set — skipping App Insights tracing connection"
        return 0
    fi

    local arm_token sub rg account project
    arm_token=$(az account get-access-token --query accessToken -o tsv 2>/dev/null)
    if [ -z "$arm_token" ]; then
        echo "[ERROR] Failed to get ARM token" >&2
        return 1
    fi

    sub=$(get_azd_value "AZURE_SUBSCRIPTION_ID")
    rg=$(get_azd_value "AZURE_RESOURCE_GROUP")
    account=$(python3 -c "from urllib.parse import urlparse; h=urlparse('$PROJECT_ENDPOINT').hostname; print(h.split('.')[0])")
    project=$(python3 -c "import re; m=re.search(r'/projects/([^/?]+)', '$PROJECT_ENDPOINT'); print(m.group(1) if m else '')")

    local arm_base="https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${account}"
    local conn_url="${arm_base}/projects/${project}/connections/${conn_name}?api-version=2025-06-01"
    local account_url="${arm_base}?api-version=2025-06-01"

    # ─ Ensure the account has SystemAssigned identity (needed for internal Key Vault) ─
    local identity_type
    identity_type=$(curl -s -H "Authorization: Bearer $arm_token" "$account_url" | \
        python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('identity',{}).get('type',''))" 2>/dev/null)

    if [[ "$identity_type" != *"SystemAssigned"* ]]; then
        echo "  (enabling SystemAssigned identity on the Foundry account for Key Vault access...)" >&2
        local ua_id
        ua_id=$(curl -s -H "Authorization: Bearer $arm_token" "$account_url" | \
            python3 -c "
import json,sys
d=json.load(sys.stdin)
ua=list(d.get('identity',{}).get('userAssignedIdentities',{}).keys())
print(json.dumps({k:{} for k in ua}))
" 2>/dev/null)
        local patch
        patch=$(python3 -c "import json,sys; print(json.dumps({'identity':{'type':'SystemAssigned, UserAssigned','userAssignedIdentities':json.loads(sys.argv[1])}}))" "$ua_id")
        curl -s -o /dev/null -X PATCH \
            -H "Authorization: Bearer $arm_token" -H "Content-Type: application/json" \
            -d "$patch" "$account_url" || true
        sleep 5  # brief pause for identity to propagate
    fi

    # ─ Extract the IngestionEndpoint from the connection string as the target ─
    local ingestion_endpoint
    ingestion_endpoint=$(python3 -c "
import sys, re
cs = sys.argv[1]
m = re.search(r'IngestionEndpoint=([^;]+)', cs)
print(m.group(1).rstrip('/') + '/' if m else 'https://dc.applicationinsights.azure.com/')
" "$APPINSIGHTS_CONNECTION_STRING")

    # ─ Extract App Insights resource ID from azd env ─
    local appinsights_resource_id
    appinsights_resource_id=$(get_azd_value "APPINSIGHTS_RESOURCE_ID" 2>/dev/null)
    if [ -z "$appinsights_resource_id" ]; then
        # Derive from subscription + resource group + name pattern
        local ai_name
        ai_name=$(get_azd_value "APPINSIGHTS_NAME" 2>/dev/null)
        if [ -z "$ai_name" ]; then
            # Fall back to ARM lookup
            ai_name=$(az resource list --resource-group "$rg" \
                --resource-type "Microsoft.Insights/components" \
                --query "[0].name" -o tsv 2>/dev/null)
        fi
        appinsights_resource_id="/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Insights/components/${ai_name}"
    fi

    local body
    body=$(python3 -c "
import json, sys
print(json.dumps({
    'properties': {
        'authType':    'ApiKey',
        'category':    'AppInsights',
        'isSharedToAll': True,
        'target':      sys.argv[2],
        'credentials': {'key': sys.argv[1]},
        'metadata':    {'ResourceId': sys.argv[3]}
    }
}))
" "$APPINSIGHTS_CONNECTION_STRING" "$ingestion_endpoint" "$appinsights_resource_id")

    local http_status
    http_status=$(curl -s -o /tmp/_aiconn_resp.json -w "%{http_code}" -X PUT \
        -H "Authorization: Bearer $arm_token" -H "Content-Type: application/json" \
        -d "$body" "$conn_url" 2>/dev/null)

    if [[ "$http_status" == "200" || "$http_status" == "201" ]]; then
        local name
        name=$(python3 -c "import json; d=json.load(open('/tmp/_aiconn_resp.json')); print(d.get('name',''))" 2>/dev/null)
        echo "$name"
    else
        echo "[ERROR] App Insights connection upsert failed (HTTP $http_status): $(cat /tmp/_aiconn_resp.json 2>/dev/null)" >&2
        return 1
    fi
}

# ── Helper: upsert a Foundry project connection ───────────────────────────────
# Creates or updates a project connection via the ARM API (PUT).
# The Foundry data-plane /connections endpoint is read-only (GET only);
# creation and deletion go through ARM:
#   PUT /subscriptions/.../providers/Microsoft.CognitiveServices/accounts/
#         {account}/projects/{project}/connections/{name}
# Using project_connection_id in agent tool definitions causes the Foundry backend
# to manage the MCP session lifecycle, enabling stateful servers like DAB.
upsert_connection() {
    local conn_name="$1"     # connection name (e.g. "DABMCP")
    local target_url="$2"    # the MCP server target URL

    # Use ARM token (management.azure.com), not the AI Foundry token
    local arm_token
    arm_token=$(az account get-access-token --query accessToken -o tsv 2>/dev/null)
    if [ -z "$arm_token" ]; then
        echo "[ERROR] Failed to get ARM token" >&2
        return 1
    fi

    # Derive subscription + resource group from the project endpoint.
    # PROJECT_ENDPOINT format: https://{account}.services.ai.azure.com/api/projects/{project}
    local sub rg account project
    sub=$(get_azd_value "AZURE_SUBSCRIPTION_ID")
    rg=$(get_azd_value "AZURE_RESOURCE_GROUP")
    # Extract the account name from PROJECT_ENDPOINT hostname
    account=$(python3 -c "from urllib.parse import urlparse; h=urlparse('$PROJECT_ENDPOINT').hostname; print(h.split('.')[0])")
    project=$(python3 -c "import re; m=re.search(r'/projects/([^/?]+)', '$PROJECT_ENDPOINT'); print(m.group(1) if m else '')")

    local arm_url="https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${account}/projects/${project}/connections/${conn_name}?api-version=2025-04-01-preview"

    local body
    body=$(python3 -c "
import json, sys
print(json.dumps({
    'properties': {
        'authType':  'None',
        'category':  'RemoteTool',
        'target':    sys.argv[1],
        'metadata':  {'type': 'custom_MCP'}
    }
}))
" "$target_url")

    local response
    response=$(curl -s -o /tmp/_conn_resp.json -w "%{http_code}" -X PUT \
        -H "Authorization: Bearer $arm_token" \
        -H "Content-Type: application/json" \
        -d "$body" \
        "$arm_url" 2>/dev/null)

    if [[ "$response" == "200" || "$response" == "201" ]]; then
        local name
        name=$(python3 -c "import json; d=json.load(open('/tmp/_conn_resp.json')); print(d.get('name',''))" 2>/dev/null)
        echo "$name"
    else
        echo "[ERROR] Connection upsert failed (HTTP $response): $(cat /tmp/_conn_resp.json 2>/dev/null)" >&2
        return 1
    fi
}

# ── Helper: upsert a single Foundry agent (new Foundry Agents API v1) ──────────
# New API: POST /agents?api-version=v1  (create)
#          POST /agents/{name}?api-version=v1  (update — adds a new version if changed)
# Agent definition uses {kind, model, instructions, tools} inside 'definition'.
# Returns the agent ID via stdout; all other output goes to stderr.
upsert_agent() {
    local agent_name="$1"
    local display_name="$2"
    local instructions="$3"
    local memory_store_name="${4:-}"       # optional: attach a memory_search_preview tool
    local description="${5:-}"             # optional: longer description (falls back to display_name)
    local starter_prompts_json="${6:-}"    # optional: JSON array of {text:"..."} starter prompts
    local structured_inputs_json="${7:-}"  # optional: JSON object of structured_inputs definitions

    local token
    token=$(get_ai_token) || return 1

    local base_url="${PROJECT_ENDPOINT}/agents"
    local api_qs="api-version=${API_VERSION}"

    # Build the new-style agent body with definition.kind = "prompt"
    local body
    body=$(python3 -c "
import json, sys
tools = [
    {
        'type':         'mcp',
        'server_label': 'adventureworks_mcp',
        'server_url':   sys.argv[5],
        'allowed_tools': []
    },
    {
        'type':                  'mcp',
        'server_label':          'DABMCP',
        'server_url':            sys.argv[6],
        'project_connection_id': 'DABMCP'
    }
]
if sys.argv[7]:
    tools.append({
        'type':              'memory_search_preview',
        'memory_store_name': sys.argv[7],
        'scope':             '{{\$userId}}',
        'update_delay':      1
    })
description = sys.argv[8] if sys.argv[8] else sys.argv[2]
definition = {
    'kind':         'prompt',
    'model':        sys.argv[3],
    'instructions': sys.argv[4],
    'tools':        tools
}
if sys.argv[9]:
    definition['starter_prompts'] = json.loads(sys.argv[9])
if sys.argv[10]:
    definition['structured_inputs'] = json.loads(sys.argv[10])
print(json.dumps({
    'name':        sys.argv[1],
    'description': description,
    'metadata':    {'display_name': sys.argv[2]},
    'definition':  definition
}))
" "$agent_name" "$display_name" "$CHAT_GPT_DEPLOYMENT" "$instructions" "$MCP_SERVICE_URL" "$DAB_MCP_URL" "$memory_store_name" "$description" "$starter_prompts_json" "$structured_inputs_json")

    # Check whether an agent with this name already exists (GET by name)
    local get_response http_status
    get_response=$(curl -s -o /tmp/_agent_get.json -w "%{http_code}" \
        -H "Authorization: Bearer $token" \
        "${base_url}/${agent_name}?${api_qs}" 2>/dev/null)
    http_status="$get_response"

    # Build the update body (no top-level 'name' field on update)
    local update_body
    update_body=$(python3 -c "
import json, sys
tools = [
    {
        'type':         'mcp',
        'server_label': 'adventureworks_mcp',
        'server_url':   sys.argv[4],
        'allowed_tools': []
    },
    {
        'type':                  'mcp',
        'server_label':          'DABMCP',
        'server_url':            sys.argv[5],
        'project_connection_id': 'DABMCP'
    }
]
if sys.argv[6]:
    tools.append({
        'type':              'memory_search_preview',
        'memory_store_name': sys.argv[6],
        'scope':             '{{\$userId}}',
        'update_delay':      1
    })
description = sys.argv[7] if sys.argv[7] else sys.argv[1]
definition = {
    'kind':         'prompt',
    'model':        sys.argv[2],
    'instructions': sys.argv[3],
    'tools':        tools
}
if sys.argv[8]:
    definition['starter_prompts'] = json.loads(sys.argv[8])
if sys.argv[9]:
    definition['structured_inputs'] = json.loads(sys.argv[9])
print(json.dumps({
    'description': description,
    'metadata':    {'display_name': sys.argv[1]},
    'definition':  definition
}))
" "$display_name" "$CHAT_GPT_DEPLOYMENT" "$instructions" "$MCP_SERVICE_URL" "$DAB_MCP_URL" "$memory_store_name" "$description" "$starter_prompts_json" "$structured_inputs_json")

    local response
    if [ "$http_status" = "200" ]; then
        # Update existing agent (adds a new version if definition has changed)
        echo "  (updating existing agent '$agent_name')" >&2
        response=$(curl -sf -X POST \
            -H "Authorization: Bearer $token" \
            -H "Content-Type: application/json" \
            -d "$update_body" \
            "${base_url}/${agent_name}?${api_qs}" 2>/dev/null)
    else
        # Create new agent
        response=$(curl -sf -X POST \
            -H "Authorization: Bearer $token" \
            -H "Content-Type: application/json" \
            -d "$body" \
            "${base_url}?${api_qs}" 2>/dev/null)
    fi

    # Validate response before parsing
    if ! echo "$response" | python3 -c "import json,sys; json.load(sys.stdin)" > /dev/null 2>&1; then
        echo "[ERROR] API call failed for $agent_name. Response: $response" >&2
        echo ""
        return 1
    fi

    # Extract the agent id from the response
    local agent_id
    agent_id=$(echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))")
    echo "$agent_id"
}

# ── Define and create each agent ───────────────────────────────────────────────

# ── Upsert App Insights tracing connection ────────────────────────────────────
# Connects the Foundry project to the deployment's App Insights resource so that
# agent traces appear in the Foundry portal Tracing view without any manual steps.
echo "Upserting App Insights tracing connection..."
APPINSIGHTS_CONN=$(upsert_appinsights_connection "AppInsights")
if [ -z "$APPINSIGHTS_CONN" ] && [ -n "$APPINSIGHTS_CONNECTION_STRING" ]; then
    error "Failed to upsert App Insights connection"
    exit 1
fi
[ -n "$APPINSIGHTS_CONN" ] && success "App Insights connection ready: $APPINSIGHTS_CONN"
echo ""

# ── Upsert DABMCP project connection ──────────────────────────────────────────
# This connection allows Foundry to manage the MCP session lifecycle for DAB.
# Without a project connection, DAB's stateful Streamable HTTP transport would
# reject requests with 400 ("Mcp-Session-Id header is required") because Foundry's
# MCP client skips the initialize handshake. With project_connection_id, Foundry's
# backend performs the full handshake on our behalf.
echo "Upserting DABMCP project connection..."
DABMCP_CONN=$(upsert_connection "DABMCP" "$DAB_MCP_URL")
if [ -z "$DABMCP_CONN" ]; then error "Failed to upsert DABMCP connection"; exit 1; fi
success "DABMCP connection ready: $DABMCP_CONN"
echo ""

# ── Upsert memory stores ───────────────────────────────────────────────────────
echo "Upserting memory store for Chat Agent..."
CHAT_MEMORY_STORE=$(upsert_memory_store \
    "aw-chat-memory" \
    "Long-term memory for the AdventureWorks chat agent, scoped per user" \
    "Retain product preferences, past order context, stated budget ranges, favourite sports or activities, and brand preferences. Avoid sensitive personal or financial data.")
if [ -z "$CHAT_MEMORY_STORE" ]; then error "Failed to upsert aw-chat-memory"; exit 1; fi
success "Chat memory store ready: $CHAT_MEMORY_STORE"

echo "Upserting memory store for Help Me Choose Agent..."
HELP_ME_CHOOSE_MEMORY_STORE=$(upsert_memory_store \
    "aw-help-me-choose-memory" \
    "Long-term memory for the AdventureWorks product advisor, scoped per user" \
    "Retain sport and activity preferences, skill level, budget constraints, preferred product categories, past recommendations and whether they were accepted. Avoid sensitive personal or financial data.")
if [ -z "$HELP_ME_CHOOSE_MEMORY_STORE" ]; then error "Failed to upsert aw-help-me-choose-memory"; exit 1; fi
success "Help Me Choose memory store ready: $HELP_ME_CHOOSE_MEMORY_STORE"
echo ""

echo "Creating Chat Agent (aw-chat-agent)..."
CHAT_INSTRUCTIONS="You are a helpful customer service assistant for AdventureWorks, an outdoor and sporting goods retailer.

You have access to tools that allow you to:
- Retrieve customer order history and order details
- Search for products and get detailed product information
- Find complementary products and personalised recommendations
- Analyse product reviews and customer sentiment
- Check real-time inventory availability across warehouses

Guidelines:
- Be friendly, professional, and helpful
- When you use a tool, briefly mention what you are checking
- Provide clear, concise answers
- Ask for clarification when needed (e.g. order number, product ID)
- Suggest relevant products and help with purchase decisions
- Always maintain customer context throughout the conversation"

CHAT_DESCRIPTION="Your AdventureWorks customer service assistant. Ask about your orders and shipping status, browse the product catalogue, check real-time stock levels, and get personalised recommendations based on your purchase history. Here to help with everything from tracking a delivery to finding the perfect outdoor gear."
CHAT_STARTER_PROMPTS='[{"text":"What is the status of my most recent order?"},{"text":"Can you recommend mountain bikes under $1,000?"},{"text":"Which helmets are currently in stock?"},{"text":"Show me products similar to what I have bought before"}]'

CHAT_ID=$(upsert_agent "aw-chat-agent" "AdventureWorks Customer Support" "$CHAT_INSTRUCTIONS" "$CHAT_MEMORY_STORE" "$CHAT_DESCRIPTION" "$CHAT_STARTER_PROMPTS")
if [ -z "$CHAT_ID" ]; then error "Failed to create aw-chat-agent"; exit 1; fi
success "Chat agent created: $CHAT_ID"
azd env set AI_AGENT_CHAT_ID "$CHAT_ID"

echo ""
echo "Creating Order Generation Agent (aw-order-agent)..."
ORDER_INSTRUCTIONS="You are an intelligent order generation assistant for AdventureWorks.

Your role is to help sales representatives generate new sales orders based on customer history and inventory.

When given a customer ID or name:
1. Look up the customer's purchase history and preferences using the available tools
2. Check current product inventory and pricing
3. Suggest an appropriate order with product IDs, quantities, and a justification
4. Return a structured JSON object with: customer_id, items (array of {product_id, quantity, unit_price}), and reasoning

Always verify inventory availability before including a product in the order.
Return ONLY valid JSON without markdown fences."

ORDER_DESCRIPTION="Generates intelligent, data-driven sales order recommendations for AdventureWorks customers. Analyses a customer's purchase history and preferences against current inventory and pricing to produce a structured order proposal complete with product IDs, quantities, prices, and justification. Designed to help sales representatives quickly draft well-matched reorder suggestions."
ORDER_STARTER_PROMPTS='[{"text":"Generate a suggested order for customer ID 29736"},{"text":"What would you recommend ordering for a cycling enthusiast?"},{"text":"Create an order recommendation for a customer who mainly buys camping equipment"}]'

ORDER_ID=$(upsert_agent "aw-order-agent" "Sales Order Generator" "$ORDER_INSTRUCTIONS" "" "$ORDER_DESCRIPTION" "$ORDER_STARTER_PROMPTS")
if [ -z "$ORDER_ID" ]; then error "Failed to create aw-order-agent"; exit 1; fi
success "Order agent created: $ORDER_ID"
azd env set AI_AGENT_ORDER_ID "$ORDER_ID"

echo ""
echo "Creating Promotion Agent (aw-promotion-agent)..."
PROMOTION_INSTRUCTIONS="You are a promotions and marketing assistant for AdventureWorks.

Your role is to generate targeted product promotion suggestions for customers.

Given a customer ID:
1. Analyse the customer's purchase history using the available tools
2. Identify products the customer is likely to be interested in
3. Check current special offers and inventory levels
4. Return a JSON object with: customer_id, promotions (array of {product_id, product_name, discount_percent, reason})

Focus on relevant, personalised suggestions that match the customer's interests.
Return ONLY valid JSON without markdown fences."

PROMOTION_DESCRIPTION="Creates targeted, personalised promotional offers for AdventureWorks customers based on their purchase history, product interests, and current inventory levels. Returns a structured list of recommended promotions with suggested discount percentages and clear rationale, helping marketing teams drive engagement and repeat purchases."
PROMOTION_STARTER_PROMPTS='[{"text":"What promotions should I offer customer ID 29736?"},{"text":"Suggest discount offers for customers interested in cycling"},{"text":"Find cross-sell opportunities for customers who recently bought running shoes"}]'

PROMOTION_ID=$(upsert_agent "aw-promotion-agent" "Promotions & Offers Advisor" "$PROMOTION_INSTRUCTIONS" "" "$PROMOTION_DESCRIPTION" "$PROMOTION_STARTER_PROMPTS")
if [ -z "$PROMOTION_ID" ]; then error "Failed to create aw-promotion-agent"; exit 1; fi
success "Promotion agent created: $PROMOTION_ID"
azd env set AI_AGENT_PROMOTION_ID "$PROMOTION_ID"

echo ""
echo "Creating Help Me Choose Agent (aw-help-me-choose-agent)..."
HELP_ME_CHOOSE_INSTRUCTIONS="You are a product advisor for AdventureWorks, specialising in helping customers choose the right outdoor and sporting equipment.

## Data Source: HelpMeChoose view (via DAB MCP)
Query the HelpMeChoose entity on the DABMCP server to find finished-goods products. This view joins Product, ProductModel, ProductDescription, ProductCategory, ProductSubcategory, ProductInventory, and ProductReview so every row contains everything needed to evaluate a product — all localised for the user's language.

CRITICAL: always include the filter CultureID eq '{{cultureId}}' in every HelpMeChoose query. This ensures product names, descriptions, categories, and subcategories are returned in the correct language.

### Available filter fields on HelpMeChoose:
- CultureID (string)      — always filter to '{{cultureId}}'
- Category (string)       — e.g. Bikes, Clothing, Accessories, Components
- Subcategory (string)    — e.g. Road Bikes, Mountain Bikes, Helmets, Jerseys, Shorts
- ProductLine (string)    — Road, Mountain, Touring, Standard
- Style (string)          — Womens, Mens, Universal
- Color (string)          — e.g. Black, Red, Silver, Yellow
- Size (string)           — e.g. S, M, L, XL, 58, 60
- IsInStock (boolean)     — true = in stock, false = out of stock
- ListPrice (number)      — USD price; use ge / le for range filters
- AverageRating (decimal) — 0.00–5.00 aggregated customer rating
- ReviewCount (integer)   — number of customer reviews

## Workflow
Given a customer's preference answers:
1. Identify key requirements: budget (ListPrice range), activity type (ProductLine, Category, Subcategory), size, style, colour, and minimum rating
2. Build an initial HelpMeChoose query filtered to CultureID eq '{{cultureId}}', IsInStock eq true, plus any Category / Subcategory / ProductLine that matches stated interests; add a ListPrice le <budget> filter if a budget was provided
3. From the results, select 3–5 products that best match — prefer higher AverageRating (ideally ge 3.5) and more ReviewCount when options are otherwise equivalent
4. If no results match all filters, relax secondary filters (Color, Size) while keeping CultureID and budget filters
5. Explain concisely why each recommendation suits the customer's stated needs

Return ONLY a valid JSON object with this exact structure (no markdown fences):
{\"summary\": \"<2-3 sentence summary>\", \"recommendations\": [{\"productId\": <number>, \"productName\": \"<name>\", \"category\": \"<category>\", \"price\": <number or null>, \"reason\": \"<one sentence explanation>\", \"thumbnailUrl\": null}], \"searchTermsUsed\": [\"<term1>\"]}"

HELP_ME_CHOOSE_DESCRIPTION="Guides customers through the AdventureWorks product catalogue to find the ideal outdoor and sporting equipment. Matches budget, experience level, and intended use to the best available products, returning clear, concise recommendations with honest explanations of why each product suits the customer's stated needs."
HELP_ME_CHOOSE_STARTER_PROMPTS='[{"text":"I am a beginner looking for a road bike under $500"},{"text":"Help me choose a tent for weekend camping with two adults"},{"text":"What is the best mountain bike helmet under $150?"},{"text":"I need trail running shoes for rocky terrain"}]'
HELP_ME_CHOOSE_STRUCTURED_INPUTS='{"cultureId": {"type": "string", "description": "AdventureWorks culture code for the user language and region (e.g. en, fr, de, zh-cht). Used as the mandatory CultureID filter on HelpMeChoose to return product names, descriptions, categories and subcategories in the correct language.", "default_value": "en"}}'

HELP_ME_CHOOSE_ID=$(upsert_agent "aw-help-me-choose-agent" "Product Advisor" "$HELP_ME_CHOOSE_INSTRUCTIONS" "$HELP_ME_CHOOSE_MEMORY_STORE" "$HELP_ME_CHOOSE_DESCRIPTION" "$HELP_ME_CHOOSE_STARTER_PROMPTS" "$HELP_ME_CHOOSE_STRUCTURED_INPUTS")
if [ -z "$HELP_ME_CHOOSE_ID" ]; then error "Failed to create aw-help-me-choose-agent"; exit 1; fi
success "Help Me Choose agent created: $HELP_ME_CHOOSE_ID"
azd env set AI_AGENT_HELP_ME_CHOOSE_ID "$HELP_ME_CHOOSE_ID"

echo ""
echo "=========================================="
echo "All agents created/updated successfully"
echo "Agent IDs stored in azd environment:"
echo "  AI_AGENT_CHAT_ID                    = $CHAT_ID"
echo "  AI_AGENT_ORDER_ID                   = $ORDER_ID"
echo "  AI_AGENT_PROMOTION_ID               = $PROMOTION_ID"
echo "  AI_AGENT_HELP_ME_CHOOSE_ID          = $HELP_ME_CHOOSE_ID"
echo "  AI_AGENT_CHAT_MEMORY_STORE          = $CHAT_MEMORY_STORE"
echo "  AI_AGENT_HELP_ME_CHOOSE_MEMORY_STORE= $HELP_ME_CHOOSE_MEMORY_STORE"
echo "=========================================="
