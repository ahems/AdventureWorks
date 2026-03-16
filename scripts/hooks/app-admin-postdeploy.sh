#!/bin/bash
# Post-deployment script for Admin Static Web App
# Updates the Static Web App configuration with API_MCP_URL

set -euo pipefail

color_cyan() { echo -e "\033[36m$1\033[0m"; }
color_green() { echo -e "\033[32m$1\033[0m"; }
color_yellow() { echo -e "\033[33m$1\033[0m"; }

get_azd_value() {
  local name=$1
  local raw first_line

  raw=$(azd env get-value "$name" 2>&1 || true)

  if [[ "$raw" =~ [Ee][Rr][Rr][Oo][Rr].*not\ found ]] || \
     [[ "$raw" =~ [Nn]o\ value\ found ]] || \
     [[ -z "$raw" ]]; then
    echo ""
    return
  fi

  first_line=$(echo "$raw" | head -n1)
  first_line="${first_line%% WARNING*}"
  echo "$first_line" | xargs
}

color_cyan "Configuring Admin Static Web App settings..."

swa_service_name=$(get_azd_value "SERVICE_APP_ADMIN_NAME")
api_mcp_url=$(get_azd_value "API_MCP_URL")
resource_group_name=$(get_azd_value "AZURE_RESOURCE_GROUP")

if [[ -z "$swa_service_name" ]] || [[ -z "$api_mcp_url" ]] || [[ -z "$resource_group_name" ]]; then
  color_yellow "Warning: Required environment variables not found. Skipping Admin Static Web App configuration."
  exit 0
fi

if az staticwebapp appsettings set \
  --name "$swa_service_name" \
  --resource-group "$resource_group_name" \
  --setting-names "API_MCP_URL=$api_mcp_url" \
  --output none 2>/dev/null; then
  color_green "✓ Successfully updated Admin SWA API_MCP_URL setting (value: $api_mcp_url)"
else
  color_yellow "Warning: Failed to update Admin Static Web App settings."
  exit 0
fi
