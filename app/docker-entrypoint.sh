#!/bin/sh
set -e

echo "Starting entrypoint script..."
echo "API_URL: ${API_URL}"
echo "API_FUNCTIONS_URL: ${API_FUNCTIONS_URL}"
echo "API_MCP_URL: ${API_MCP_URL}"

# Generate config.js with the API URLs from environment variables
cat > /usr/share/nginx/html/config.js << EOF
window.APP_CONFIG = {
  API_URL: "${API_URL}",
  API_FUNCTIONS_URL: "${API_FUNCTIONS_URL}",
  API_MCP_URL: "${API_MCP_URL}"
};
EOF

echo "Generated config.js:"
cat /usr/share/nginx/html/config.js

# Start nginx
exec nginx -g 'daemon off;'
