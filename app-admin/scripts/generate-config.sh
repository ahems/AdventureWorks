#!/bin/bash
set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# App directory is parent of scripts directory
APP_DIR="$(dirname "$SCRIPT_DIR")"

API_URL="${VITE_API_URL:-}"
API_FUNCTIONS_URL="${VITE_API_FUNCTIONS_URL:-}"
API_MCP_URL="${VITE_API_MCP_URL:-}"
APPINSIGHTS_CONNECTIONSTRING="${VITE_APPINSIGHTS_CONNECTIONSTRING:-}"
APP_URL="${VITE_APP_URL:-}"
APP_MANUFACTURING_URL="${VITE_APP_MANUFACTURING_URL:-}"

echo "[Generate Config] Generating config.js with runtime configuration"
echo "[Generate Config] App dir: $APP_DIR"
echo "  API_URL: $API_URL"
echo "  API_FUNCTIONS_URL: $API_FUNCTIONS_URL"
echo "  API_MCP_URL: $API_MCP_URL"
echo "  APPINSIGHTS: $(if [ -n "$APPINSIGHTS_CONNECTIONSTRING" ]; then echo "***set***"; else echo "not set"; fi)"
echo "  APP_URL: $APP_URL"
echo "  APP_MANUFACTURING_URL: $APP_MANUFACTURING_URL"

cat > "$APP_DIR/public/config.js" << EOF
// Runtime configuration
// Generated during build process
window.APP_CONFIG = {
  API_URL: '${API_URL}',
  API_FUNCTIONS_URL: '${API_FUNCTIONS_URL}',
  API_MCP_URL: '${API_MCP_URL}',
  APPINSIGHTS_CONNECTIONSTRING: '${APPINSIGHTS_CONNECTIONSTRING}',
  APP_URL: '${APP_URL}',
  APP_MANUFACTURING_URL: '${APP_MANUFACTURING_URL}'
};
EOF

echo "[Generate Config] config.js generated successfully"
cat "$APP_DIR/public/config.js"
