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

# --- Wire MCP OAuth redirect URIs onto the api-mcp container app -------------
# api-mcp (the self-contained OAuth authorization server) is provisioned BEFORE
# the frontend apps, so it cannot reference their URLs at provision time without
# a circular dependency. We set the exact per-client redirect URIs here, after
# every app has a stable deployed URL. The OAuth server appends /oauth/callback
# to a bare origin, but we pass the full callback path for clarity. Existing
# api-mcp env vars are preserved (--set-env-vars only adds/updates the named
# variables). This is idempotent across re-runs of azd up.
mcp_app_name=$(get_azd_value "SERVICE_API_MCP_NAME")
resource_group=$(get_azd_value "AZURE_RESOURCE_GROUP")
eshop_url=$(get_azd_value "APP_URL")
admin_url=$(get_azd_value "APP_ADMIN_URL")
manufacturing_url=$(get_azd_value "APP_MANUFACTURING_URL")
inspector_url=$(get_azd_value "MCP_INSPECTOR_URL")

if [[ -z "$mcp_app_name" || -z "$resource_group" ]]; then
  echo "Warning: api-mcp app name or resource group unavailable; skipping OAuth redirect URI wiring."
else
  redirect_env_pairs=()
  append_redirect() {
    local var_name=$1 base_url=$2
    [[ -z "$base_url" ]] && return
    base_url="${base_url%/}"
    case "$base_url" in
      */oauth/callback) : ;;
      *) base_url="${base_url}/oauth/callback" ;;
    esac
    redirect_env_pairs+=("${var_name}=${base_url}")
  }
  append_redirect "OAUTH_ESHOP_REDIRECT_URIS" "$eshop_url"
  append_redirect "OAUTH_ADMIN_REDIRECT_URIS" "$admin_url"
  append_redirect "OAUTH_MANUFACTURING_REDIRECT_URIS" "$manufacturing_url"
  append_redirect "OAUTH_INSPECTOR_REDIRECT_URIS" "$inspector_url"

  if [[ ${#redirect_env_pairs[@]} -gt 0 ]]; then
    echo "Wiring OAuth redirect URIs onto ${mcp_app_name}: ${redirect_env_pairs[*]}"
    az containerapp update \
      --name "$mcp_app_name" \
      --resource-group "$resource_group" \
      --set-env-vars "${redirect_env_pairs[@]}" \
      --output none
    echo "Updated api-mcp OAuth redirect URIs (a new revision was created)."
  else
    echo "Warning: no app URLs resolved; api-mcp OAuth clients will use development redirect URIs only."
  fi
fi

# Run after every service has deployed so the Functions app receives the newly
# published hosted-agent endpoint as well as the other agent settings.
bash scripts/hooks/api-functions-postdeploy.sh