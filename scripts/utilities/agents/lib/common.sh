#!/usr/bin/env bash
# =============================================================================
# scripts/utilities/agents/lib/common.sh
# Shared utilities for creating/updating Azure AI Foundry agents.
#
# Sourced by every agent script in the parent directory and by the orchestrator
# (create-foundry-agents.sh).  Exports environment variables, logging helpers,
# and the two main functions used by all agent scripts:
#
#   upsert_memory_store        — create (or return existing) a memory store
#   upsert_agent               — create or update a "kind: prompt" Foundry agent
# =============================================================================

# ── Colour / log helpers ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}    $*"; }
success() { echo -e "${GREEN}[OK]${NC}     $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC}  $*" >&2; }

AGENT_TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/adventureworks-agent.XXXXXXXX") || {
    error "Could not create a private agent deployment temporary directory."
    exit 1
}
cleanup_agent_temp() {
    rm -f -- "$AGENT_TEMP_DIR/memory-store.json" \
        "$AGENT_TEMP_DIR/agent-get.json" "$AGENT_TEMP_DIR/agent-response.json"
    rmdir -- "$AGENT_TEMP_DIR"
}
trap cleanup_agent_temp EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── Read a single value from the azd environment ─────────────────────────────
get_azd_value() {
    local environment_args=()
    if [[ -n "${AZURE_ENV_NAME:-}" ]]; then
        environment_args=(--environment "$AZURE_ENV_NAME")
    fi
    azd env get-value "$1" "${environment_args[@]}" --no-prompt 2>/dev/null | tr -d '\n\r '
}

# ── Environment variables — loaded once at source time ───────────────────────
PROJECT_ENDPOINT=$(get_azd_value "AI_FOUNDRY_PROJECT_ENDPOINT")
MCP_SERVICE_URL=$(get_azd_value "MCP_SERVICE_URL")
API_URL=$(get_azd_value "API_URL")
CHAT_GPT_DEPLOYMENT=$(get_azd_value "chatGptDeploymentName")
EMBEDDING_DEPLOYMENT="embedding"   # deployment name (not the model name)
AZURE_SUBSCRIPTION_ID=$(get_azd_value "AZURE_SUBSCRIPTION_ID")
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
if [ -z "$AZURE_SUBSCRIPTION_ID" ]; then
    error "AZURE_SUBSCRIPTION_ID is not set in the selected azd environment."
    exit 1
fi

# ── Get a fresh Azure AI Foundry bearer token ─────────────────────────────────
get_ai_token() {
    az account get-access-token --subscription "$AZURE_SUBSCRIPTION_ID" --resource "https://ai.azure.com/" \
        --query accessToken -o tsv 2>/dev/null | tr -d '\n\r '
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

    local resp_file="$AGENT_TEMP_DIR/memory-store.json"
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
#              [allowed_tools_json="[]"] [include_dabmcp="false"]
#              [allowed_dab_tools_json="[]"]
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
#   allowed_tools      — explicit JSON array of api-mcp tool names.
#                        An empty array omits the api-mcp server.
#   include_dabmcp     — "true" only when a DAB MCP allow-list is provided;
#                        defaults to "false".
#   allowed_dab_tools  — explicit JSON array of DAB MCP tool names.
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
    local include_dabmcp="${9:-false}"
    local allowed_dab_tools="${10:-[]}"

    local token
    token=$(get_ai_token)
    if [ -z "$token" ]; then
        error "Could not obtain Azure AI token for agent upsert"
        return 1
    fi

    # ── Build the least-privilege tools array ─────────────────────────────────
    local tools_json
    if ! tools_json=$(python3 "$(dirname "${BASH_SOURCE[0]}")/build-agent-tools.py" \
        "$MCP_SERVICE_URL" "$DAB_MCP_URL" "$allowed_tools" "$include_dabmcp" \
        "$allowed_dab_tools"); then
        error "Could not build a fail-closed MCP tool configuration for $name."
        return 1
    fi

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
    'instructions': instructions
}

tools = json.loads(tools_json)
if tools:
    definition['tools'] = tools

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

    local resp_file="$AGENT_TEMP_DIR/agent-response.json"

    # ── Check whether the agent already exists ────────────────────────────────
    local get_status
    get_status=$(curl -s -o "$AGENT_TEMP_DIR/agent-get.json" -w "%{http_code}" \
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
