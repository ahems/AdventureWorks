#!/bin/sh
set -eu

cd /inspector
node gateway.mjs &
gateway_pid=$!
trap 'kill "$gateway_pid" 2>/dev/null || true' EXIT INT TERM

ready=false
for attempt in $(seq 1 60); do
  kill -0 "$gateway_pid"
  if node --input-type=module -e '
    import http from "node:http";
    const origin = new URL(process.env.MCP_PROXY_FULL_ADDRESS).origin;
    const request = http.get("http://127.0.0.1:6274/health", {
      headers: { Host: new URL(origin).host }, timeout: 2000
    }, response => {
      response.resume();
      process.exit(response.statusCode === 200 ? 0 : 1);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => process.exit(1));
  ' 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || { echo "Inspector OAuth gateway did not become ready" >&2; exit 1; }
nginx -g 'daemon off;' &
nginx_pid=$!
trap 'kill "$gateway_pid" "$nginx_pid" 2>/dev/null || true' EXIT INT TERM
while kill -0 "$gateway_pid" 2>/dev/null && kill -0 "$nginx_pid" 2>/dev/null; do sleep 1; done
exit 1
