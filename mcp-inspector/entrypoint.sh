#!/bin/sh
set -e

echo "Starting MCP Inspector..."
echo "API_MCP_URL: ${API_MCP_URL}"
echo "API_DAB_MCP_URL: ${API_DAB_MCP_URL}"
echo "MCP_PROXY_FULL_ADDRESS: ${MCP_PROXY_FULL_ADDRESS}"

# Write pre-configured MCP server list so both endpoints appear in the UI
mkdir -p /root/.mcp-inspector
cat > /root/.mcp-inspector/config.json << CONFIGEOF
{
  "mcpServers": {
    "AdventureWorks MCP": {
      "type": "streamable-http",
      "url": "${API_MCP_URL}"
    },
    "AdventureWorks DAB": {
      "type": "streamable-http",
      "url": "${API_DAB_MCP_URL}"
    }
  }
}
CONFIGEOF

echo "Generated MCP Inspector config:"
cat /root/.mcp-inspector/config.json

# Inspector core settings
export DANGEROUSLY_OMIT_AUTH=true
export MCP_AUTO_OPEN_ENABLED=false
export HOST=0.0.0.0
export CLIENT_PORT=6274
export SERVER_PORT=6277

# Tell the Inspector client JS where its proxy lives (nginx routes /proxy/ → port 6277)
export MCP_PROXY_FULL_ADDRESS="${MCP_PROXY_FULL_ADDRESS}"

# Fix DNS rebinding protection: even with auth disabled, the proxy validates the
# Origin header. Derive the public origin from MCP_PROXY_FULL_ADDRESS by stripping
# the /proxy suffix, then allow that origin explicitly.
if [ -n "${MCP_PROXY_FULL_ADDRESS}" ]; then
  INSPECTOR_ORIGIN=$(echo "${MCP_PROXY_FULL_ADDRESS}" | sed 's|/proxy$||' | sed 's|/proxy/$||')
  export ALLOWED_ORIGINS="${INSPECTOR_ORIGIN}"
  echo "ALLOWED_ORIGINS set to: ${ALLOWED_ORIGINS}"
fi

# Start MCP Inspector in the background
mcp-inspector &
INSPECTOR_PID=$!

echo "MCP Inspector started (PID $INSPECTOR_PID), waiting for it to be ready..."
# nc is not available in the image — poll /proc for the listening ports instead
i=0
while [ $i -lt 30 ]; do
  if grep -q ':187E ' /proc/net/tcp6 2>/dev/null && grep -q ':188D ' /proc/net/tcp6 2>/dev/null; then
    echo "Inspector ports ready (6274=0x187E, 6277=0x188D)."
    break
  fi
  sleep 1
  i=$((i + 1))
done

echo "Starting nginx..."
exec nginx -g 'daemon off;'
