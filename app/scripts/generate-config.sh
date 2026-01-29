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

echo "[Generate Config] Replacing placeholders in config.js with runtime configuration"
echo "[Generate Config] App dir: $APP_DIR"
echo "  API_URL: $API_URL"
echo "  API_FUNCTIONS_URL: $API_FUNCTIONS_URL"
echo "  API_MCP_URL: $API_MCP_URL"
echo "  APPINSIGHTS: $(if [ -n "$APPINSIGHTS_CONNECTIONSTRING" ]; then echo "***set***"; else echo "not set"; fi)"

# Replace placeholders in config.js
sed -i "s|{{VITE_API_URL}}|${API_URL}|g" "$APP_DIR/public/config.js"
sed -i "s|{{VITE_API_FUNCTIONS_URL}}|${API_FUNCTIONS_URL}|g" "$APP_DIR/public/config.js"
sed -i "s|{{VITE_API_MCP_URL}}|${API_MCP_URL}|g" "$APP_DIR/public/config.js"
sed -i "s|{{VITE_APPINSIGHTS_CONNECTIONSTRING}}|${APPINSIGHTS_CONNECTIONSTRING}|g" "$APP_DIR/public/config.js"

echo "[Generate Config] config.js placeholders replaced successfully"
cat "$APP_DIR/public/config.js"
