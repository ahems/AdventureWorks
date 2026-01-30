#!/bin/bash
# Post-deployment script for API Container App
# Updates the API Container App with the frontend URL for CORS configuration

set -euo pipefail

color_cyan() { echo -e "\033[36m$1\033[0m"; }
color_green() { echo -e "\033[32m$1\033[0m"; }
color_yellow() { echo -e "\033[33m$1\033[0m"; }
color_red() { echo -e "\033[31m$1\033[0m"; }

get_azd_value() {
  local name=$1
  local raw exit_code
  
  raw=$(azd env get-value "$name" 2>&1 || true)
  exit_code=$?
  
  if [[ $exit_code -ne 0 ]] || \
     [[ "$raw" =~ [Ee][Rr][Rr][Oo][Rr].*not\ found ]] || \
     [[ "$raw" =~ [Nn]o\ value\ found ]] || \
     [[ -z "$raw" ]]; then
    echo ""
    return
  fi
  
  echo "$raw" | xargs
}

color_cyan "Configuring API Container App CORS..."

# Get the frontend URL from azd environment
redirect_url=$(get_azd_value "APP_REDIRECT_URI")

if [[ -z "$redirect_url" ]]; then
  color_yellow "Warning: APP_REDIRECT_URI not found. Skipping CORS configuration."
  exit 0
fi

# Extract base URL from redirect URL (remove /getAToken suffix)
app_url="${redirect_url%/getAToken}"

api_service_name=$(get_azd_value "SERVICE_API_NAME")
resource_group_name=$(get_azd_value "AZURE_RESOURCE_GROUP")

if [[ -z "$api_service_name" ]] || [[ -z "$resource_group_name" ]]; then
  color_yellow "Warning: SERVICE_API_NAME or AZURE_RESOURCE_GROUP not found."
  exit 0
fi

# Update the Container App with APP_URL environment variable for CORS
if az containerapp update \
  --name "$api_service_name" \
  --resource-group "$resource_group_name" \
  --set-env-vars "APP_URL=$app_url" \
  --output none 2>/dev/null; then
  color_green "✓ Successfully updated APP_URL for CORS (value: $app_url)"
else
  color_red "✗ Failed to update Container App environment variables."
  exit 1
fi
