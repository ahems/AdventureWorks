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
echo ""

# ── API version ────────────────────────────────────────────────────────────────
# Uses the stable v1 routes for the new Microsoft Foundry Agents Service
# (replaces the legacy date-based api-version used by the classic Assistants API)
API_VERSION="v1"

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

# ── Helper: upsert a single Foundry agent (new Foundry Agents API v1) ──────────
# New API: POST /agents?api-version=v1  (create)
#          POST /agents/{name}?api-version=v1  (update — adds a new version if changed)
# Agent definition uses {kind, model, instructions, tools} inside 'definition'.
# Returns the agent ID via stdout; all other output goes to stderr.
upsert_agent() {
    local agent_name="$1"
    local display_name="$2"
    local instructions="$3"

    local token
    token=$(get_ai_token) || return 1

    local base_url="${PROJECT_ENDPOINT}/agents"
    local api_qs="api-version=${API_VERSION}"

    # Build the new-style agent body with definition.kind = "prompt"
    local body
    body=$(python3 -c "
import json, sys
print(json.dumps({
    'name':        sys.argv[1],
    'description': sys.argv[2],
    'definition': {
        'kind':         'prompt',
        'model':        sys.argv[3],
        'instructions': sys.argv[4],
        'tools': [
            {
                'type':         'mcp',
                'server_label': 'adventureworks_mcp',
                'server_url':   sys.argv[5],
                'allowed_tools': []
            }
        ]
    }
}))
" "$agent_name" "$display_name" "$CHAT_GPT_DEPLOYMENT" "$instructions" "$MCP_SERVICE_URL" "$DAB_MCP_URL")

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
print(json.dumps({
    'description': sys.argv[1],
    'definition': {
        'kind':         'prompt',
        'model':        sys.argv[2],
        'instructions': sys.argv[3],
        'tools': [
            {
                'type':         'mcp',
                'server_label': 'adventureworks_mcp',
                'server_url':   sys.argv[4],
                'allowed_tools': []
            }
        ]
    }
}))
" "$display_name" "$CHAT_GPT_DEPLOYMENT" "$instructions" "$MCP_SERVICE_URL" "$DAB_MCP_URL")

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

CHAT_ID=$(upsert_agent "aw-chat-agent" "AdventureWorks Chat Agent" "$CHAT_INSTRUCTIONS")
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

ORDER_ID=$(upsert_agent "aw-order-agent" "AdventureWorks Order Generation Agent" "$ORDER_INSTRUCTIONS")
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

PROMOTION_ID=$(upsert_agent "aw-promotion-agent" "AdventureWorks Promotion Agent" "$PROMOTION_INSTRUCTIONS")
if [ -z "$PROMOTION_ID" ]; then error "Failed to create aw-promotion-agent"; exit 1; fi
success "Promotion agent created: $PROMOTION_ID"
azd env set AI_AGENT_PROMOTION_ID "$PROMOTION_ID"

echo ""
echo "Creating Help Me Choose Agent (aw-help-me-choose-agent)..."
HELP_ME_CHOOSE_INSTRUCTIONS="You are a product advisor for AdventureWorks, specialising in helping customers choose the right outdoor and sporting equipment.

Given a customer's answers to preference questions:
1. Search the product catalogue using the available tools (search_products, find_complementary_products)
2. Match products to the customer's stated requirements (budget, experience level, intended use)
3. Return 3-5 best matching products

Be concise and specific. Explain clearly why each product suits the customer's needs.
Return ONLY a valid JSON object with this exact structure (no markdown fences):
{\"summary\": \"<2-3 sentence summary>\", \"recommendations\": [{\"productId\": <number>, \"productName\": \"<name>\", \"category\": \"<category>\", \"price\": <number or null>, \"reason\": \"<one sentence explanation>\", \"thumbnailUrl\": null}], \"searchTermsUsed\": [\"<term1>\"]}"

HELP_ME_CHOOSE_ID=$(upsert_agent "aw-help-me-choose-agent" "AdventureWorks Help Me Choose Agent" "$HELP_ME_CHOOSE_INSTRUCTIONS")
if [ -z "$HELP_ME_CHOOSE_ID" ]; then error "Failed to create aw-help-me-choose-agent"; exit 1; fi
success "Help Me Choose agent created: $HELP_ME_CHOOSE_ID"
azd env set AI_AGENT_HELP_ME_CHOOSE_ID "$HELP_ME_CHOOSE_ID"

echo ""
echo "=========================================="
echo "All agents created/updated successfully"
echo "Agent IDs stored in azd environment:"
echo "  AI_AGENT_CHAT_ID           = $CHAT_ID"
echo "  AI_AGENT_ORDER_ID          = $ORDER_ID"
echo "  AI_AGENT_PROMOTION_ID      = $PROMOTION_ID"
echo "  AI_AGENT_HELP_ME_CHOOSE_ID = $HELP_ME_CHOOSE_ID"
echo "=========================================="
