#!/usr/bin/env bash
# =============================================================================
# create-foundry-agents.sh
# Orchestrator: creates or updates all AdventureWorks AI agents in Azure AI Foundry.
#
# Usage:
#   bash scripts/utilities/create-foundry-agents.sh
#
# To deploy a single agent without running all, run its script directly:
#   bash scripts/utilities/agents/eshop-chat-agent.sh
#   bash scripts/utilities/agents/admin-order-agent.sh
#   bash scripts/utilities/agents/admin-promotion-agent.sh
#   bash scripts/utilities/agents/eshop-help-me-choose-agent.sh
#   bash scripts/utilities/agents/eshop-workflow-agent.sh
#   bash scripts/utilities/agents/admin-promotion-workflow-agent.sh
#   bash scripts/utilities/agents/admin-order-workflow-agent.sh
#
# Prerequisites:
#   - azd environment populated (run after `azd provision`)
#   - az CLI authenticated (az login)
#   - AI_FOUNDRY_PROJECT_ENDPOINT in azd env
#   - MCP_SERVICE_URL in azd env
#   - API_URL in azd env
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

source "$SCRIPT_DIR/agents/lib/common.sh"

echo ""
echo "=========================================="
echo "Creating / Updating Azure AI Foundry Agents"
echo "=========================================="
echo ""
info "Project endpoint : $PROJECT_ENDPOINT"
info "MCP service URL  : $MCP_SERVICE_URL"
info "DAB MCP URL      : $DAB_MCP_URL"
info "Model deployment : $CHAT_GPT_DEPLOYMENT"
info "Embed deployment : $EMBEDDING_DEPLOYMENT"
info "App Insights     : ${APPINSIGHTS_CONNECTION_STRING:0:40}..."
echo ""

# ── Set up shared project connections once ────────────────────────────────────
# This connection allows Foundry to manage the MCP session lifecycle for DAB.
# Without a project connection, DAB's stateful Streamable HTTP transport would
# reject requests with 400 ("Mcp-Session-Id header is required") because Foundry's
# MCP client skips the initialize handshake. With project_connection_id, Foundry's
# backend performs the full handshake on our behalf.
setup_shared_connections

# Export flag so each agent script skips the duplicate connection upserts
export FOUNDRY_CONNECTIONS_READY=1

# ── Run each agent script ─────────────────────────────────────────────────────
bash "$SCRIPT_DIR/agents/eshop-chat-agent.sh"
echo ""
bash "$SCRIPT_DIR/agents/admin-order-agent.sh"
echo ""
bash "$SCRIPT_DIR/agents/admin-promotion-agent.sh"
echo ""
bash "$SCRIPT_DIR/agents/eshop-help-me-choose-agent.sh"
echo ""
# The workflow agents must be created AFTER their respective base agents because
# they reference the base agents by name in their YAML workflow definitions.
bash "$SCRIPT_DIR/agents/eshop-workflow-agent.sh"
echo ""
bash "$SCRIPT_DIR/agents/admin-promotion-workflow-agent.sh"
echo ""
bash "$SCRIPT_DIR/agents/admin-order-workflow-agent.sh"

echo ""
echo "=========================================="
echo "All agents created/updated successfully"
echo "Agent IDs stored in azd environment:"
echo "  AI_AGENT_CHAT_ID                   = $(get_azd_value AI_AGENT_CHAT_ID)"
echo "  AI_AGENT_ORDER_ID                  = $(get_azd_value AI_AGENT_ORDER_ID)"
echo "  AI_AGENT_PROMOTION_ID              = $(get_azd_value AI_AGENT_PROMOTION_ID)"
echo "  AI_AGENT_HELP_ME_CHOOSE_ID         = $(get_azd_value AI_AGENT_HELP_ME_CHOOSE_ID)"
echo "  AI_AGENT_WORKFLOW_CHAT_ID          = $(get_azd_value AI_AGENT_WORKFLOW_CHAT_ID)"
echo "  AI_AGENT_WORKFLOW_PROMOTION_ID     = $(get_azd_value AI_AGENT_WORKFLOW_PROMOTION_ID)"
echo "  AI_AGENT_WORKFLOW_ORDER_ID         = $(get_azd_value AI_AGENT_WORKFLOW_ORDER_ID)"
echo "==========================================="
