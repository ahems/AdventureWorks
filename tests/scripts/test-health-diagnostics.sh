#!/usr/bin/env bash
set -euo pipefail

functions_url="${API_FUNCTIONS_URL:-$(azd env get-value API_FUNCTIONS_URL)}"
mcp_url="${API_MCP_URL:-$(azd env get-value API_MCP_URL)}"
functions_url="${functions_url%/}"
mcp_base="${mcp_url%/}"
mcp_base="${mcp_base%/mcp}"
temporary_dir=$(mktemp -d)
trap 'rm -f "$temporary_dir/functions.json" "$temporary_dir/mcp.json" "$temporary_dir/live.json"; rmdir "$temporary_dir"' EXIT

curl --silent --show-error --fail --max-time 60 "$functions_url/api/health" \
  -o "$temporary_dir/live.json"
jq -e '.status == "healthy" and (.timestamp | type == "string")' "$temporary_dir/live.json" >/dev/null
test "$(curl --silent --show-error --fail --max-time 60 "$mcp_base/health")" = "Healthy"

for service in functions mcp; do
  if [[ "$service" == functions ]]; then
    endpoint="$functions_url/api/health/readiness"
  else
    endpoint="$mcp_base/ready"
  fi
  http_status=$(curl --silent --show-error --max-time 60 "$endpoint" \
    -o "$temporary_dir/$service.json" -w '%{http_code}')
  if [[ "$http_status" != 200 && "$http_status" != 503 ]]; then
    echo "$service readiness returned unexpected HTTP $http_status" >&2
    exit 1
  fi
  jq -e '
    (.status == "healthy" or .status == "unhealthy") and
    (.checkedAt | type == "string") and
    (.checks | type == "array") and
    (.checks | length > 0) and
    all(.checks[]; (.id | type == "string") and (.status | type == "string") and (.message | type == "string"))
  ' "$temporary_dir/$service.json" >/dev/null
  echo "$service readiness HTTP $http_status"
  jq -r '.checks[] | "\(.id): \(.status)"' "$temporary_dir/$service.json"
  if [[ "$http_status" != 200 ]]; then
    echo "$service has dependency failures; inspect Application Insights." >&2
    exit 1
  fi
done

jq -e '
  [.checks[] | select(.required)] as $required |
  ($required | length == 7) and all($required[]; .status == "healthy") and
  ([.checks[].id] | unique | length == 15)
' "$temporary_dir/functions.json" >/dev/null
jq -e '[.checks[].id] | sort == ["sql", "tasks"]' "$temporary_dir/mcp.json" >/dev/null
echo "Health diagnostics smoke test passed (read-only; no inference or mutations)."
