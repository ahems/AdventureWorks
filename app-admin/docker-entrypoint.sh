#!/bin/sh
set -e

echo "Starting entrypoint script..."
echo "API_URL: ${API_URL}"
echo "API_FUNCTIONS_URL: ${API_FUNCTIONS_URL}"
echo "API_MCP_URL: ${API_MCP_URL}"
echo "APP_URL: ${APP_URL}"
echo "MCP_INSPECTOR_URL: ${MCP_INSPECTOR_URL}"

# Generate config.js with the API URLs from environment variables
cat > /app/dist/config.js << CONFIGEOF
window.APP_CONFIG = {
  API_URL: "${API_URL}",
  API_FUNCTIONS_URL: "${API_FUNCTIONS_URL}",
  API_MCP_URL: "${API_MCP_URL}",
  APPINSIGHTS_CONNECTIONSTRING: "${APPINSIGHTS_CONNECTIONSTRING}",
  APP_URL: "${APP_URL}",
  MCP_INSPECTOR_URL: "${MCP_INSPECTOR_URL}"
};
CONFIGEOF

echo "Generated config.js:"
cat /app/dist/config.js

# Serve static files on port 80 with SPA fallback (--single handles /index.html fallback)
exec serve -s /app/dist -l 80 --no-clipboard
