#!/bin/bash
set -e

# Set environment variables for the SWA build process
# This ensures that when npm run build is called, the VITE_* variables are available

API_URL=$(azd env get-value API_URL 2>/dev/null | head -n1 | tr -d '\n\r ')
API_FUNC_URL=$(azd env get-value API_FUNCTIONS_URL 2>/dev/null | head -n1 | tr -d '\n\r ')
API_MCP_URL=$(azd env get-value API_MCP_URL 2>/dev/null | head -n1 | tr -d '\n\r ')
APPINSIGHTS_CONN_STR=$(azd env get-value APPINSIGHTS_CONNECTIONSTRING 2>/dev/null | head -n1 | tr -d '\n\r ')

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
