#!/bin/bash
set -euo pipefail

# Set environment variables for the SWA build process
# This ensures that when npm run build is called, the VITE_* variables are available

environment_args=()
if [[ -n "${AZURE_ENV_NAME:-}" ]]; then
  environment_args=(--environment "$AZURE_ENV_NAME")
fi

get_azd_value() {
  local name=$1 value
  if ! value=$(azd env get-value "$name" "${environment_args[@]}" --no-prompt 2>/dev/null); then
    echo "ERROR: Unable to read $name from the selected azd environment." >&2
    return 1
  fi
  value=${value%%$'\n'*}
  value=${value//$'\r'/}
  value=${value// /}
  if [[ -z "$value" ]]; then
    echo "ERROR: $name is empty in the selected azd environment." >&2
    return 1
  fi
  printf '%s' "$value"
}

API_URL=$(get_azd_value API_URL)
API_FUNC_URL=$(get_azd_value API_FUNCTIONS_URL)
API_MCP_URL=$(get_azd_value API_MCP_URL)
APPINSIGHTS_CONN_STR=$(get_azd_value APPINSIGHTS_CONNECTIONSTRING)

echo "Preparing the storefront build configuration..."

# Export for any subsequent commands (though azd may not pass these to SWA CLI)
export VITE_API_URL="$API_URL"
export VITE_API_FUNCTIONS_URL="$API_FUNC_URL"
export VITE_API_MCP_URL="$API_MCP_URL"
export VITE_APPINSIGHTS_CONNECTIONSTRING="$APPINSIGHTS_CONN_STR"

# Write to .env file that Vite will pick up during build
cat > app/.env.production << EOF
VITE_API_URL=$API_URL
VITE_API_FUNCTIONS_URL=$API_FUNC_URL
VITE_API_MCP_URL=$API_MCP_URL
VITE_APPINSIGHTS_CONNECTIONSTRING=$APPINSIGHTS_CONN_STR
EOF

# Clean dist to force fresh build
if [ -d "app/dist" ]; then
  rm -rf app/dist
fi

# Generate staticwebapp.config.json from template with dynamic Functions URL
sed "s|{{API_FUNCTIONS_URL}}|$API_FUNC_URL|g" app/staticwebapp.config.template.json > app/staticwebapp.config.json

echo "Storefront build configuration ready."
