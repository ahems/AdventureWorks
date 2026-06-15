#!/bin/sh
set -e

echo "Starting entrypoint script..."
echo "API_URL: ${API_URL}"
echo "API_FUNCTIONS_URL: ${API_FUNCTIONS_URL}"

# Strip /graphql (with optional trailing slash) from API_URL to get the DAB REST base
DAB_REST_BASE="$(echo "${API_URL}" | sed 's|/graphql/*$||')"
echo "DAB_REST_BASE: ${DAB_REST_BASE}"

# Generate config.js with the API URLs from environment variables
cat > /app/dist/config.js << CONFIGEOF
window.APP_CONFIG = {
  ODATA_BASE: "${DAB_REST_BASE}/api",
  MANUFACTURING_BASE: "${API_FUNCTIONS_URL}/api",
  API_URL: "${API_URL}",
  API_FUNCTIONS_URL: "${API_FUNCTIONS_URL}",
  APPINSIGHTS_CONNECTIONSTRING: "${APPINSIGHTS_CONNECTIONSTRING}"
};
CONFIGEOF

echo "Generated config.js:"
cat /app/dist/config.js

# Serve static files on port 80 with SPA fallback (--single handles /index.html fallback)
exec serve -s /app/dist -l 80 --no-clipboard
