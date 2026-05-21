#!/bin/bash
# Post-deployment script for API Functions (Flex Consumption)
# Injects Foundry agent IDs created by create-foundry-agents.sh into the Function App

set -euo pipefail

color_cyan() { echo -e "\033[36m$1\033[0m"; }
color_green() { echo -e "\033[32m$1\033[0m"; }
color_yellow() { echo -e "\033[33m$1\033[0m"; }
color_red() { echo -e "\033[31m$1\033[0m"; }

get_azd_value() {
  local name=$1
  local raw exit_code first_line

  raw=$(azd env get-value "$name" 2>&1 || true)
  exit_code=$?

  if [[ $exit_code -ne 0 ]] || \
     [[ "$raw" =~ [Ee][Rr][Rr][Oo][Rr].*not\ found ]] || \
     [[ "$raw" =~ [Nn]o\ value\ found ]] || \
     [[ -z "$raw" ]]; then
    echo ""
    return
  fi

  # Use only first line; azd may append warnings to stdout
  first_line=$(echo "$raw" | head -n1)
  first_line="${first_line%% WARNING*}"
  echo "$first_line" | xargs
}

color_cyan "Injecting Foundry agent IDs into API Functions (Flex Consumption)..."

# ── Read agent IDs from azd environment ────────────────────────────────────────
chat_id=$(get_azd_value "AI_AGENT_CHAT_ID")
order_id=$(get_azd_value "AI_AGENT_ORDER_ID")
promotion_id=$(get_azd_value "AI_AGENT_PROMOTION_ID")
help_me_choose_id=$(get_azd_value "AI_AGENT_HELP_ME_CHOOSE_ID")
workflow_chat_id=$(get_azd_value "AI_AGENT_WORKFLOW_CHAT_ID")
workflow_promotion_id=$(get_azd_value "AI_AGENT_WORKFLOW_PROMOTION_ID")
workflow_order_id=$(get_azd_value "AI_AGENT_WORKFLOW_ORDER_ID")
workflow_help_me_choose_id=$(get_azd_value "AI_AGENT_WORKFLOW_HELP_ME_CHOOSE_ID")
cart_recovery_id=$(get_azd_value "AI_AGENT_CART_RECOVERY_ID")
product_content_id=$(get_azd_value "AI_AGENT_PRODUCT_CONTENT_ID")
customer_id=$(get_azd_value "AI_AGENT_CUSTOMER_ID")
mcp_service_url=$(get_azd_value "MCP_SERVICE_URL")

if [[ -z "$chat_id" ]] || [[ -z "$order_id" ]] || [[ -z "$promotion_id" ]] || [[ -z "$help_me_choose_id" ]] || [[ -z "$cart_recovery_id" ]] || [[ -z "$product_content_id" ]]; then
  color_yellow "Warning: One or more agent IDs not found in azd environment."
  color_yellow "Run 'bash scripts/utilities/create-foundry-agents.sh' to create the agents, then retry."
  exit 0
fi

functions_service_name=$(get_azd_value "SERVICE_API_FUNCTIONS_NAME")
resource_group_name=$(get_azd_value "AZURE_RESOURCE_GROUP")

if [[ -z "$functions_service_name" ]] || [[ -z "$resource_group_name" ]]; then
  color_yellow "Warning: SERVICE_API_FUNCTIONS_NAME or AZURE_RESOURCE_GROUP not found."
  exit 0
fi

# ── Update the Function App with the new agent IDs ────────────────────────────
if az functionapp config appsettings set \
  --name "$functions_service_name" \
  --resource-group "$resource_group_name" \
  --settings \
    "AI_AGENT_CHAT_ID=$chat_id" \
    "AI_AGENT_ORDER_ID=$order_id" \
    "AI_AGENT_PROMOTION_ID=$promotion_id" \
    "AI_AGENT_HELP_ME_CHOOSE_ID=$help_me_choose_id" \
    "AI_AGENT_WORKFLOW_CHAT_ID=${workflow_chat_id:-}" \
    "AI_AGENT_WORKFLOW_PROMOTION_ID=${workflow_promotion_id:-}" \
    "AI_AGENT_WORKFLOW_ORDER_ID=${workflow_order_id:-}" \
    "AI_AGENT_WORKFLOW_HELP_ME_CHOOSE_ID=${workflow_help_me_choose_id:-}" \
    "AI_AGENT_CART_RECOVERY_ID=$cart_recovery_id" \
    "AI_AGENT_PRODUCT_CONTENT_ID=$product_content_id" \
    ${customer_id:+"AI_AGENT_CUSTOMER_ID=$customer_id"} \
    ${mcp_service_url:+"MCP_SERVICE_URL=$mcp_service_url"} \
  --output none; then
  color_green "✓ Successfully injected agent IDs into $functions_service_name"
  echo "  AI_AGENT_CHAT_ID                      = $chat_id"
  echo "  AI_AGENT_ORDER_ID                     = $order_id"
  echo "  AI_AGENT_PROMOTION_ID                 = $promotion_id"
  echo "  AI_AGENT_HELP_ME_CHOOSE_ID            = $help_me_choose_id"
  [[ -n "$workflow_chat_id" ]] && echo "  AI_AGENT_WORKFLOW_CHAT_ID             = $workflow_chat_id" || true
  [[ -n "$workflow_promotion_id" ]] && echo "  AI_AGENT_WORKFLOW_PROMOTION_ID        = $workflow_promotion_id" || true
  [[ -n "$workflow_order_id" ]] && echo "  AI_AGENT_WORKFLOW_ORDER_ID            = $workflow_order_id" || true
  [[ -n "$workflow_help_me_choose_id" ]] && echo "  AI_AGENT_WORKFLOW_HELP_ME_CHOOSE_ID   = $workflow_help_me_choose_id" || true
  echo "  AI_AGENT_CART_RECOVERY_ID             = $cart_recovery_id"
  echo "  AI_AGENT_PRODUCT_CONTENT_ID           = $product_content_id"
  [[ -n "$customer_id" ]] && echo "  AI_AGENT_CUSTOMER_ID                  = $customer_id" || true
  [[ -n "$mcp_service_url" ]] && echo "  MCP_SERVICE_URL                       = $mcp_service_url" || true
else
  color_red "✗ Failed to update Function App settings."
  exit 1
fi
