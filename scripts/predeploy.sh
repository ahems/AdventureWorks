#!/bin/bash
set -e

# Set environment variables for the SWA build process
# This ensures that when npm run build is called, the VITE_* variables are available

API_URL=$(azd env get-value API_URL)
API_FUNC_URL=$(azd env get-value API_FUNCTIONS_URL)
APPINSIGHTS_CONN_STR=$(azd env get-value APPINSIGHTS_CONNECTIONSTRING)

echo "[PreDeploy] Setting environment variables for SWA build"
echo "  VITE_API_URL: $API_URL"
echo "  VITE_API_FUNCTIONS_URL: $API_FUNC_URL"
echo "  VITE_APPINSIGHTS_CONNECTIONSTRING: $(if [ -n "$APPINSIGHTS_CONN_STR" ]; then echo "***set***"; else echo "not set"; fi)"

# Export for any subsequent commands (though azd may not pass these to SWA CLI)
export VITE_API_URL="$API_URL"
export VITE_API_FUNCTIONS_URL="$API_FUNC_URL"
export VITE_APPINSIGHTS_CONNECTIONSTRING="$APPINSIGHTS_CONN_STR"

# Write to .env file that Vite will pick up during build
cat > app/.env.production << EOF
VITE_API_URL=$API_URL
VITE_API_FUNCTIONS_URL=$API_FUNC_URL
VITE_APPINSIGHTS_CONNECTIONSTRING=$APPINSIGHTS_CONN_STR
EOF

echo "[PreDeploy] Created app/.env.production with Azure URLs"

# Clean dist to force fresh build
if [ -d "app/dist" ]; then
  echo "[PreDeploy] Cleaning dist folder to force fresh build"
  rm -rf app/dist
fi

# Generate staticwebapp.config.json from template with dynamic Functions URL
echo "[PreDeploy] Generating staticwebapp.config.json with Functions URL: $API_FUNC_URL"
sed "s|{{API_FUNCTIONS_URL}}|$API_FUNC_URL|g" app/staticwebapp.config.template.json > app/staticwebapp.config.json

echo "[PreDeploy] Configuration completed"
