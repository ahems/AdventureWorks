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
#   bash scripts/utilities/agents/admin-chat-agent.sh
#   bash scripts/utilities/agents/admin-order-agent.sh
#   bash scripts/utilities/agents/admin-promotion-agent.sh
#   bash scripts/utilities/agents/admin-cart-recovery-agent.sh
#   bash scripts/utilities/agents/admin-customer-agent.sh
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
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

source "$SCRIPT_DIR/agents/lib/common.sh"

info "Configuring Azure AI agents..."

# ── Set up shared project connections once ────────────────────────────────────
# This connection allows Foundry to manage the MCP session lifecycle for DAB.
# Without a project connection, DAB's stateful Streamable HTTP transport would
# reject requests with 400 ("Mcp-Session-Id header is required") because Foundry's
# MCP client skips the initialize handshake. With project_connection_id, Foundry's
# backend performs the full handshake on our behalf.
setup_shared_connections

# Export flag so each agent script skips the duplicate connection upserts
export FOUNDRY_CONNECTIONS_READY=1

# Workflow agents must follow their base agents because their YAML definitions
# reference those agents by name.
agent_scripts=(
    eshop-chat-agent
    admin-chat-agent
    admin-order-agent
    admin-promotion-agent
    admin-cart-recovery-agent
    admin-review-agent
    admin-customer-agent
    admin-product-content-agent
    manufacturing-content-agent
    admin-translation-agent
    admin-review-batch-agent
    admin-review-analysis-agent
    admin-email-content-agent
    admin-catalog-suggestion-agent
    eshop-help-me-choose-agent
    eshop-workflow-agent
    admin-promotion-workflow-agent
    admin-order-workflow-agent
)

for agent_script in "${agent_scripts[@]}"; do
    if ! agent_output=$(bash "$SCRIPT_DIR/agents/$agent_script.sh" 2>&1); then
        printf '%s\n' "$agent_output" >&2
        error "Could not configure $agent_script."
        exit 1
    fi
done

# NOTE: manufacturing-agent is a Foundry Hosted Agent deployed via:
#   cd manufacturing-agent/mcp-tools && azd deploy
# It is no longer a kind:prompt agent managed by this script.

success "Configured ${#agent_scripts[@]} Azure AI agents."
