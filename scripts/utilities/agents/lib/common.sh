#!/usr/bin/env bash
# =============================================================================
# scripts/utilities/agents/lib/common.sh
# Shared utilities for creating/updating Azure AI Foundry agents.
#
# Sourced by every agent script in the parent directory and by the orchestrator
# (create-foundry-agents.sh).  Exports environment variables, logging helpers,
# and the three main functions used by all agent scripts:
#
#   setup_shared_connections   — create / verify the DAB MCP project connection
#   upsert_memory_store        — create (or return existing) a memory store
#   upsert_agent               — create or update a "kind: prompt" Foundry agent
# =============================================================================

# ── Colour / log helpers ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}    $*"; }
success() { echo -e "${GREEN}[OK]${NC}     $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC}  $*" >&2; }

# ── Read a single value from the azd environment ─────────────────────────────
get_azd_value() {
    azd env get-value "$1" 2>/dev/null | tr -d '\n\r '
}

# ── Environment variables — loaded once at source time ───────────────────────
PROJECT_ENDPOINT=$(get_azd_value "AI_FOUNDRY_PROJECT_ENDPOINT")
MCP_SERVICE_URL=$(get_azd_value "MCP_SERVICE_URL")
API_URL=$(get_azd_value "API_URL")
CHAT_GPT_DEPLOYMENT=$(get_azd_value "chatGptDeploymentName")
EMBEDDING_DEPLOYMENT="embedding"   # deployment name (not the model name)
AZURE_SUBSCRIPTION_ID=$(get_azd_value "AZURE_SUBSCRIPTION_ID")
AZURE_RESOURCE_GROUP=$(get_azd_value "AZURE_RESOURCE_GROUP")
APPINSIGHTS_CONNECTION_STRING=$(get_azd_value "APPLICATIONINSIGHTS_CONNECTION_STRING")

# Derive the DAB MCP URL from the GraphQL API URL:
#   https://host/graphql/  →  https://host/mcp
DAB_MCP_URL="${API_URL%/graphql/}/mcp"

# Foundry data-plane API version
API_VERSION="v1"

# ── Validate required values ──────────────────────────────────────────────────
if [ -z "$PROJECT_ENDPOINT" ]; then
    error "AI_FOUNDRY_PROJECT_ENDPOINT is not set. Run 'azd provision' first."
    exit 1
fi
if [ -z "$MCP_SERVICE_URL" ]; then
    error "MCP_SERVICE_URL is not set. Run 'azd provision' first."
    exit 1
fi
if [ -z "$CHAT_GPT_DEPLOYMENT" ]; then
    error "chatGptDeploymentName is not set. Run 'azd provision' first."
    exit 1
fi

# Connection ID exported by setup_shared_connections; used as
# project_connection_id in DAB MCP tool configs.
DAB_MCP_CONNECTION_ID=""

# ── Get a fresh Azure AI Foundry bearer token ─────────────────────────────────
get_ai_token() {
    az account get-access-token --resource "https://ai.azure.com/" \
        --query accessToken -o tsv 2>/dev/null | tr -d '\n\r '
}

# ── Get an Azure management-plane token ───────────────────────────────────────
_get_mgmt_token() {
    az account get-access-token --resource "https://management.azure.com/" \
        --query accessToken -o tsv 2>/dev/null | tr -d '\n\r '
}

# ── Extract project name from the Foundry endpoint URL ───────────────────────
# PROJECT_ENDPOINT: https://{account}.services.ai.azure.com/api/projects/{project}
_get_project_name() {
    echo "$PROJECT_ENDPOINT" | python3 -c "
import sys, re
m = re.search(r'/projects/([^/?#]+)', sys.stdin.read())
print(m.group(1) if m else '')
"
}

# =============================================================================
# setup_shared_connections
#
# Creates (or verifies) a project connection for the DAB MCP endpoint so that
# Foundry manages the stateful Streamable HTTP session handshake on behalf of
# agents that use DAB MCP tools.
#
# Without a project_connection_id, DAB's Streamable HTTP transport rejects
# Foundry requests with 400 "Mcp-Session-Id header is required" because Foundry
# skips the MCP initialize handshake.  With project_connection_id, Foundry's
# backend performs the full handshake automatically.
#
# On success exports DAB_MCP_CONNECTION_ID (the connection name).
# On failure warns and continues — agents are still created, but DAB MCP tools
# may not function until the connection is added manually.
# =============================================================================
setup_shared_connections() {
    info "Setting up shared project connections..."

    local conn_name="adventureworks-dab-mcp"
    local token
    token=$(get_ai_token)

    if [ -z "$token" ]; then
        warn "Could not obtain Azure AI token — skipping connection setup"
        return 0
    fi

    if [ -z "$DAB_MCP_URL" ] || [ "$DAB_MCP_URL" = "/mcp" ]; then
        warn "Could not derive DAB MCP URL from API_URL ($API_URL) — skipping connection setup"
        return 0
    fi

    # ── Check whether the connection already exists (Foundry data plane) ──────
    local get_status
    get_status=$(curl -s -o /tmp/_aw_conn_get.json -w "%{http_code}" \
        -H "Authorization: Bearer $token" \
        "${PROJECT_ENDPOINT}/connections/${conn_name}?api-version=${API_VERSION}" 2>/dev/null)

    if [ "$get_status" = "200" ]; then
        DAB_MCP_CONNECTION_ID="$conn_name"
        success "DAB MCP connection already exists: $DAB_MCP_CONNECTION_ID"
        return 0
    fi

    # ── Try to create via Foundry data-plane API ──────────────────────────────
    local fp_body
    fp_body=$(python3 -c "
import json, sys
print(json.dumps({
    'name':            sys.argv[1],
    'connection_type': 'HttpEndpoint',
    'target':          sys.argv[2],
    'auth':            {'type': 'none'}
}))
" "$conn_name" "$DAB_MCP_URL")

    local fp_status
    fp_status=$(curl -s -o /tmp/_aw_conn_create.json -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$fp_body" \
        "${PROJECT_ENDPOINT}/connections?api-version=${API_VERSION}" 2>/dev/null)

    if [ "$fp_status" = "200" ] || [ "$fp_status" = "201" ]; then
        DAB_MCP_CONNECTION_ID="$conn_name"
        success "Created DAB MCP project connection (Foundry API): $DAB_MCP_CONNECTION_ID"
        return 0
    fi

    # ── Fall back to ARM REST API (CognitiveServices/accounts/projects path) ──
    local mgmt_token
    mgmt_token=$(_get_mgmt_token)

    # Extract account and project names from the project endpoint URL:
    #   https://{account}.services.ai.azure.com/api/projects/{project}
    local account_name project_name
    account_name=$(echo "$PROJECT_ENDPOINT" | python3 -c "
import sys, re
m = re.match(r'https://([^.]+)\.', sys.stdin.read())
print(m.group(1) if m else '')
")
    project_name=$(_get_project_name)

    if [ -n "$mgmt_token" ] && [ -n "$account_name" ] && [ -n "$project_name" ] && \
       [ -n "$AZURE_SUBSCRIPTION_ID" ] && [ -n "$AZURE_RESOURCE_GROUP" ]; then

        local arm_url
        arm_url="https://management.azure.com/subscriptions/${AZURE_SUBSCRIPTION_ID}"
        arm_url+="/resourceGroups/${AZURE_RESOURCE_GROUP}"
        arm_url+="/providers/Microsoft.CognitiveServices/accounts/${account_name}"
        arm_url+="/projects/${project_name}"
        arm_url+="/connections/${conn_name}?api-version=2025-04-01-preview"

        local arm_body
        arm_body=$(python3 -c "
import json, sys
print(json.dumps({
    'properties': {
        'category': 'CustomKeys',
        'target':   sys.argv[1],
        'authType': 'None',
        'credentials': {}
    }
}))
" "$DAB_MCP_URL")

        local arm_status
        arm_status=$(curl -s -o /tmp/_aw_conn_arm.json -w "%{http_code}" -X PUT \
            -H "Authorization: Bearer $mgmt_token" \
            -H "Content-Type: application/json" \
            -d "$arm_body" \
            "$arm_url" 2>/dev/null)

        if [ "$arm_status" = "200" ] || [ "$arm_status" = "201" ]; then
            DAB_MCP_CONNECTION_ID="$conn_name"
            success "Created DAB MCP project connection (ARM API): $DAB_MCP_CONNECTION_ID"
            return 0
        fi

        local arm_resp
        arm_resp=$(cat /tmp/_aw_conn_arm.json 2>/dev/null || echo "")
        warn "ARM connection creation returned HTTP $arm_status: ${arm_resp:0:200}"
    fi

    # ── Both methods failed — continue without a connection ───────────────────
    local fp_resp
    fp_resp=$(cat /tmp/_aw_conn_create.json 2>/dev/null || echo "")
    warn "Could not create DAB MCP project connection (Foundry HTTP $fp_status: ${fp_resp:0:150})."
    warn "Agents requiring DAB MCP will be created with a direct server_url."
    warn "DAB MCP tool calls may fail until the connection is added manually in the Foundry portal."
    DAB_MCP_CONNECTION_ID=""
    return 0
}

# =============================================================================
# upsert_memory_store <name> <description> <schema_description>
#
# Creates a 'kind: default' memory store.  If a store with the same name
# already exists the API returns it unchanged (idempotent).
#
# The schema_description (3rd arg) captures what the store should remember;
# it is stored in the description field for documentation purposes.
#
# Outputs the store NAME to stdout.  Returns 1 on failure.
# =============================================================================
upsert_memory_store() {
    local name="$1"
    local description="${2:-}"
    local schema_description="${3:-}"

    # Combine description + schema guidance into the API description field
    local full_description="$description"
    if [ -n "$schema_description" ]; then
        full_description="${description:+${description} }Schema: ${schema_description}"
    fi

    local token
    token=$(get_ai_token)
    if [ -z "$token" ]; then
        error "Could not obtain Azure AI token for memory store upsert"
        return 1
    fi

    # Build the request body
    local body
    body=$(python3 -c "
import json, sys
d = {
    'name':        sys.argv[1],
    'description': sys.argv[2],
    'definition': {
        'kind':            'default',
        'chat_model':      sys.argv[3],
        'embedding_model': sys.argv[4]
    }
}
print(json.dumps(d))
" "$name" "$full_description" "$CHAT_GPT_DEPLOYMENT" "$EMBEDDING_DEPLOYMENT")

    local resp_file="/tmp/_aw_memstore_${name}.json"
    local http_code
    http_code=$(curl -s -o "$resp_file" -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -H "Foundry-Features: MemoryStores=V1Preview" \
        -d "$body" \
        "${PROJECT_ENDPOINT}/memory_stores?api-version=${API_VERSION}" 2>/dev/null)

    local response
    response=$(cat "$resp_file" 2>/dev/null || echo "{}")

    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        local store_name
        store_name=$(echo "$response" | python3 -c \
            "import json,sys; d=json.load(sys.stdin); print(d.get('name',''))" 2>/dev/null || echo "")
        if [ -n "$store_name" ]; then
            echo "$store_name"
            return 0
        fi
    fi

    # Some conflict codes indicate the store already exists
    local err_code
    err_code=$(echo "$response" | python3 -c \
        "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('code',''))" \
        2>/dev/null || echo "")

    if [ "$err_code" = "already_exists" ] || [ "$err_code" = "conflict" ] || \
       [ "$err_code" = "ResourceAlreadyExists" ]; then
        echo "$name"
        return 0
    fi

    # Try to read the existing store by name as a last resort
    local get_code
    get_code=$(curl -s -o "$resp_file" -w "%{http_code}" \
        -H "Authorization: Bearer $token" \
        -H "Foundry-Features: MemoryStores=V1Preview" \
        "${PROJECT_ENDPOINT}/memory_stores/${name}?api-version=${API_VERSION}" 2>/dev/null)

    if [ "$get_code" = "200" ]; then
        echo "$name"
        return 0
    fi

    local err_msg
    err_msg=$(echo "$response" | python3 -c \
        "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message','')[:200])" \
        2>/dev/null || echo "")
    error "Failed to upsert memory store '$name' (HTTP $http_code): $err_msg"
    return 1
}

# =============================================================================
# upsert_agent <name> <display_name> <instructions> <memory_store_name>
#              <description> <starter_prompts_json> <structured_inputs_json>
#              [allowed_tools_json="[]"] [include_dabmcp="true"]
#
# Creates or updates a 'kind: prompt' Foundry agent.
#
# Parameters:
#   name               — unique agent identifier (used as the Foundry agent name)
#   display_name       — human-friendly label shown in the Foundry portal
#   instructions       — system prompt / instructions for the model
#   memory_store_name  — name of a memory store to attach (empty = no memory)
#   description        — short description of what the agent does
#   starter_prompts    — JSON array of starter message objects, e.g.
#                        '[{"text":"..."}]'  (stored in metadata)
#   structured_inputs  — JSON object declaring Handlebars template variables,
#                        e.g. '{"userId":{"type":"string","default_value":""}}'
#                        Pass "" or "{}" to omit.
#   allowed_tools      — JSON array of tool names to allow on adventureworks_mcp,
#                        e.g. '["search_products","get_order_details"]'.
#                        Pass "[]" or "{}" to allow all tools.
#   include_dabmcp     — "true" (default) to attach the DAB MCP server as an
#                        additional tool; "false" to omit it.
#
# Outputs the agent ID to stdout.  Returns 1 on failure.
# =============================================================================
upsert_agent() {
    local name="$1"
    local display_name="$2"
    local instructions="$3"
    local memory_store_name="${4:-}"
    local description="${5:-}"
    local starter_prompts="${6:-}"
    local structured_inputs="${7:-}"
    local allowed_tools="${8:-[]}"
    local include_dabmcp="${9:-true}"

    local token
    token=$(get_ai_token)
    if [ -z "$token" ]; then
        error "Could not obtain Azure AI token for agent upsert"
        return 1
    fi

    # ── Build the tools array ─────────────────────────────────────────────────
    local tools_json
    tools_json=$(python3 -c "
import json, sys

mcp_url      = sys.argv[1]
dab_mcp_url  = sys.argv[2]
raw_tools    = sys.argv[3]
include_dab  = sys.argv[4].lower() == 'true'
conn_id      = sys.argv[5]

# Parse allowed_tools — accept JSON array or empty/object → all tools
try:
    allowed = json.loads(raw_tools)
    if not isinstance(allowed, list):
        allowed = []
except Exception:
    allowed = []

tools = []

# adventureworks_mcp tool
mcp_tool = {
    'type':             'mcp',
    'server_label':     'adventureworks_mcp',
    'server_url':       mcp_url,
    'require_approval': 'never',
    'allowed_tools':    allowed
}
tools.append(mcp_tool)

# DAB MCP tool (optional)
if include_dab and dab_mcp_url:
    dab_tool = {
        'type':             'mcp',
        'server_label':     'dabmcp',
        'require_approval': 'never',
        'allowed_tools':    []
    }
    if conn_id:
        dab_tool['project_connection_id'] = conn_id
    else:
        dab_tool['server_url'] = dab_mcp_url
    tools.append(dab_tool)

print(json.dumps(tools))
" "$MCP_SERVICE_URL" "$DAB_MCP_URL" "$allowed_tools" "$include_dabmcp" "$DAB_MCP_CONNECTION_ID")

    # ── Build the complete agent request body ─────────────────────────────────
    local body
    body=$(python3 -c "
import json, sys

name             = sys.argv[1]
display_name     = sys.argv[2]
instructions     = sys.argv[3]
memory_name      = sys.argv[4]
description      = sys.argv[5]
tools_json       = sys.argv[6]
model            = sys.argv[7]
struct_inputs_s  = sys.argv[8]
starter_s        = sys.argv[9]

metadata = {'display_name': display_name}

# Starter prompts stored in metadata as a JSON string (portal UX only)
# The Foundry API expects metadata values to be strings.
if starter_s and starter_s not in ('', '[]'):
    try:
        # Validate it parses but store as a JSON string
        json.loads(starter_s)
        metadata['starter_prompts'] = starter_s
    except Exception:
        pass

definition = {
    'kind':         'prompt',
    'model':        model,
    'instructions': instructions,
    'tools':        json.loads(tools_json)
}

if memory_name:
    definition['memory_stores'] = [{'name': memory_name}]

# structured_inputs schema (for Handlebars template resolution)
if struct_inputs_s and struct_inputs_s not in ('', '{}'):
    try:
        definition['structured_inputs'] = json.loads(struct_inputs_s)
    except Exception:
        pass

d = {
    'name':        name,
    'description': description,
    'metadata':    metadata,
    'definition':  definition
}
print(json.dumps(d))
" "$name" "$display_name" "$instructions" "$memory_store_name" \
  "$description" "$tools_json" "$CHAT_GPT_DEPLOYMENT" \
  "$structured_inputs" "$starter_prompts")

    local resp_file="/tmp/_aw_agent_${name}.json"

    # ── Check whether the agent already exists ────────────────────────────────
    local get_status
    get_status=$(curl -s -o /tmp/_aw_agent_get_${name}.json -w "%{http_code}" \
        -H "Authorization: Bearer $token" \
        "${PROJECT_ENDPOINT}/agents/${name}?api-version=${API_VERSION}" 2>/dev/null)

    local http_code
    if [ "$get_status" = "200" ]; then
        # ── Update: POST /agents/{name} without the top-level 'name' field ───
        local update_body
        update_body=$(echo "$body" | python3 -c \
            "import json,sys; d=json.load(sys.stdin); d.pop('name',None); print(json.dumps(d))")

        http_code=$(curl -s -o "$resp_file" -w "%{http_code}" -X POST \
            -H "Authorization: Bearer $token" \
            -H "Content-Type: application/json" \
            -d "$update_body" \
            "${PROJECT_ENDPOINT}/agents/${name}?api-version=${API_VERSION}" 2>/dev/null)
    else
        # ── Create: POST /agents ──────────────────────────────────────────────
        http_code=$(curl -s -o "$resp_file" -w "%{http_code}" -X POST \
            -H "Authorization: Bearer $token" \
            -H "Content-Type: application/json" \
            -d "$body" \
            "${PROJECT_ENDPOINT}/agents?api-version=${API_VERSION}" 2>/dev/null)
    fi

    local response
    response=$(cat "$resp_file" 2>/dev/null || echo "{}")

    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        local agent_id
        agent_id=$(echo "$response" | python3 -c \
            "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
        if [ -n "$agent_id" ]; then
            echo "$agent_id"
            return 0
        fi
    fi

    local err_msg
    err_msg=$(echo "$response" | python3 -c \
        "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message','')[:250])" \
        2>/dev/null || echo "")
    error "Failed to upsert agent '$name' (HTTP $http_code): $err_msg"
    error "Response body: ${response:0:500}"
    return 1
}
