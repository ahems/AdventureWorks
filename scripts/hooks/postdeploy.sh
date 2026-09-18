#!/bin/bash
# Root post-deploy hook. The hosted Manufacturing agent publishes its endpoint
# into azd state only after its service deployment completes.

set -euo pipefail

get_azd_value() {
  local name=$1
  local raw first_line

  raw=$(azd env get-value "$name" 2>&1 || true)
  if [[ "$raw" =~ [Ee][Rr][Rr][Oo][Rr].*not\ found ]] || \
     [[ "$raw" =~ [Nn]o\ value\ found ]] || \
     [[ -z "$raw" ]]; then
    echo ""
    return
  fi

  first_line=$(echo "$raw" | head -n1)
  first_line="${first_line%% WARNING*}"
  echo "$first_line" | xargs
}

manufacturing_endpoint=$(get_azd_value "AGENT_MANUFACTURING_AGENT_RESPONSES_ENDPOINT")

if [[ -z "$manufacturing_endpoint" ]]; then
  echo "Warning: hosted Manufacturing agent endpoint was not published by azd."
else
  azd env set "MANUFACTURING_AGENT_ENDPOINT" "$manufacturing_endpoint" >/dev/null
  echo "Published MANUFACTURING_AGENT_ENDPOINT from the hosted agent deployment."
fi

# Run after every service has deployed so the Functions app receives the newly
# published hosted-agent endpoint as well as the other agent settings.
bash scripts/hooks/api-functions-postdeploy.sh