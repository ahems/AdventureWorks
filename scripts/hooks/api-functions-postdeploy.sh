#!/bin/bash
# Post-deployment script for API Functions (Flex Consumption)
# Injects Foundry agent IDs created by create-foundry-agents.sh into the Function App

set -euo pipefail

color_cyan() { echo -e "\033[36m$1\033[0m"; }
color_green() { echo -e "\033[32m$1\033[0m"; }
color_red() { echo -e "\033[31m$1\033[0m"; }

environment_args=()
if [[ -n "${AZURE_ENV_NAME:-}" ]]; then
  environment_args=(--environment "$AZURE_ENV_NAME")
fi

get_azd_value() {
  local name=$1
  local raw first_line

  if ! raw=$(azd env get-value "$name" "${environment_args[@]}" --no-prompt 2>/dev/null); then
    return
  fi

  # Use only first line; azd may append warnings to stdout
  first_line=$(echo "$raw" | head -n1)
  first_line="${first_line%% WARNING*}"
  echo "$first_line" | xargs
}

color_cyan "Injecting Foundry agent IDs into API Functions (Flex Consumption)..."

# Keep the public Help-Me-Choose tool boundary in sync with its server code on
# targeted Functions deployments, not only during full provisioning.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
help_me_choose_script="$script_dir/../utilities/agents/eshop-help-me-choose-agent.sh"
if ! bash "$help_me_choose_script"; then
  color_red "✗ Failed to apply the Help-Me-Choose agent's managed-identity tool policy."
  exit 1
fi

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
review_id=$(get_azd_value "AI_AGENT_REVIEW_ID")
product_content_id=$(get_azd_value "AI_AGENT_PRODUCT_CONTENT_ID")
manufacturing_content_id=$(get_azd_value "AI_AGENT_MANUFACTURING_CONTENT_ID")
customer_id=$(get_azd_value "AI_AGENT_CUSTOMER_ID")
admin_chat_id=$(get_azd_value "AI_AGENT_ADMIN_CHAT_ID")
translation_id=$(get_azd_value "AI_AGENT_TRANSLATION_ID")
review_batch_id=$(get_azd_value "AI_AGENT_REVIEW_BATCH_ID")
review_analysis_id=$(get_azd_value "AI_AGENT_REVIEW_ANALYSIS_ID")
email_content_id=$(get_azd_value "AI_AGENT_EMAIL_CONTENT_ID")
catalog_suggestion_id=$(get_azd_value "AI_AGENT_CATALOG_SUGGESTION_ID")
mcp_service_url=$(get_azd_value "MCP_SERVICE_URL")
manufacturing_agent_endpoint=$(get_azd_value "MANUFACTURING_AGENT_ENDPOINT")
api_functions_url=$(get_azd_value "API_FUNCTIONS_URL")

if [[ -z "$chat_id" ]] || [[ -z "$order_id" ]] || [[ -z "$promotion_id" ]] || [[ -z "$help_me_choose_id" ]] || [[ -z "$cart_recovery_id" ]] || [[ -z "$product_content_id" ]]; then
  color_red "ERROR: One or more required agent IDs are missing from the selected azd environment."
  exit 1
fi

functions_service_name=$(get_azd_value "SERVICE_API_FUNCTIONS_NAME")
resource_group_name=$(get_azd_value "AZURE_RESOURCE_GROUP")
subscription_id=$(get_azd_value "AZURE_SUBSCRIPTION_ID")

if [[ -z "$functions_service_name" ]] || [[ -z "$resource_group_name" ]] || [[ -z "$subscription_id" ]]; then
  color_red "ERROR: Functions app, resource group and subscription are required in the selected azd environment."
  exit 1
fi

# ── Update the Function App with the new agent IDs ────────────────────────────
if az functionapp config appsettings set \
  --name "$functions_service_name" \
  --resource-group "$resource_group_name" \
  --subscription "$subscription_id" \
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
    ${review_id:+"AI_AGENT_REVIEW_ID=$review_id"} \
    "AI_AGENT_PRODUCT_CONTENT_ID=$product_content_id" \
    ${manufacturing_content_id:+"AI_AGENT_MANUFACTURING_CONTENT_ID=$manufacturing_content_id"} \
    ${customer_id:+"AI_AGENT_CUSTOMER_ID=$customer_id"} \
    ${admin_chat_id:+"AI_AGENT_ADMIN_CHAT_ID=$admin_chat_id"} \
    ${translation_id:+"AI_AGENT_TRANSLATION_ID=$translation_id"} \
    ${review_batch_id:+"AI_AGENT_REVIEW_BATCH_ID=$review_batch_id"} \
    ${review_analysis_id:+"AI_AGENT_REVIEW_ANALYSIS_ID=$review_analysis_id"} \
    ${email_content_id:+"AI_AGENT_EMAIL_CONTENT_ID=$email_content_id"} \
    ${catalog_suggestion_id:+"AI_AGENT_CATALOG_SUGGESTION_ID=$catalog_suggestion_id"} \
    ${mcp_service_url:+"MCP_SERVICE_URL=$mcp_service_url"} \
    ${manufacturing_agent_endpoint:+"MANUFACTURING_AGENT_ENDPOINT=$manufacturing_agent_endpoint"} \
    ${api_functions_url:+"API_FUNCTIONS_URL=$api_functions_url"} \
  --output none; then
  color_green "✓ Azure Functions configured with the demo's AI agents."
else
  color_red "✗ Failed to update Function App settings."
  exit 1
fi
