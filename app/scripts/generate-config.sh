#!/bin/bash
set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# App directory is parent of scripts directory
APP_DIR="$(dirname "$SCRIPT_DIR")"

# Generate config.js with environment variables by replacing placeholders
# This script is called during the build process to inject runtime configuration

API_URL="${VITE_API_URL:-}"
API_FUNCTIONS_URL="${VITE_API_FUNCTIONS_URL:-}"
API_MCP_URL="${VITE_API_MCP_URL:-}"
APPINSIGHTS_CONNECTIONSTRING="${VITE_APPINSIGHTS_CONNECTIONSTRING:-}"

echo "[Generate Config] Generating config.js with runtime configuration"
echo "[Generate Config] App dir: $APP_DIR"
echo "  API_URL: $API_URL"
echo "  API_FUNCTIONS_URL: $API_FUNCTIONS_URL"
echo "  API_MCP_URL: $API_MCP_URL"
echo "  APPINSIGHTS: $(if [ -n "$APPINSIGHTS_CONNECTIONSTRING" ]; then echo "***set***"; else echo "not set"; fi)"

# Create config.js directly with values
cat > "$APP_DIR/public/config.js" << EOF
// Runtime configuration
// Generated during build process
window.APP_CONFIG = {
  API_URL: '${API_URL}',
  API_FUNCTIONS_URL: '${API_FUNCTIONS_URL}',
  API_MCP_URL: '${API_MCP_URL}',
  APPINSIGHTS_CONNECTIONSTRING: '${APPINSIGHTS_CONNECTIONSTRING}'
};
EOF

echo "[Generate Config] config.js generated successfully"
cat "$APP_DIR/public/config.js"
