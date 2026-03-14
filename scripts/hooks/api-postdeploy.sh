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
  
  # Use only first line; azd may append warnings to stdout (e.g. "WARNING: your version of azd is out of date")
  first_line=$(echo "$raw" | head -n1)
  first_line="${first_line%% WARNING*}"
  echo "$first_line" | xargs
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

# Get current env vars and merge APP_URL so we don't replace/wipe other variables
current_env_json=$(az containerapp show \
  --name "$api_service_name" \
  --resource-group "$resource_group_name" \
  --query "properties.template.containers[0].env" -o json 2>/dev/null || echo "[]")
if [[ -z "$current_env_json" ]] || [[ "$current_env_json" == "[]" ]]; then
  color_yellow "Warning: Could not read current env vars; updating APP_URL only."
  set_env_args=("APP_URL=$app_url")
else
  set_env_args=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    name="${line%%=*}"
    value="${line#*=}"
    if [[ "$name" == "APP_URL" ]]; then
      value="$app_url"
    fi
    set_env_args+=("$name=$value")
  done < <(echo "$current_env_json" | jq -r '.[] | select(.value != null) | "\(.name)=\(.value)"' 2>/dev/null)
  if ! printf '%s\n' "${set_env_args[@]}" | grep -q '^APP_URL='; then
    set_env_args+=("APP_URL=$app_url")
  fi
fi

if az containerapp update \
  --name "$api_service_name" \
  --resource-group "$resource_group_name" \
  --set-env-vars "${set_env_args[@]}" \
  --output none; then
  color_green "✓ Successfully updated APP_URL for CORS (value: $app_url)"
else
  color_red "✗ Failed to update Container App environment variables."
  exit 1
fi
