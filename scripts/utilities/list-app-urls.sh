#!/usr/bin/env bash

# Print current deployed app URLs from azd environment values.
# Includes the Static Web App URL plus Container App endpoints.

set -euo pipefail

if ! command -v azd >/dev/null 2>&1; then
  echo "Error: azd CLI is not installed or not on PATH." >&2
  exit 1
fi

AZD_VALUES="$(azd env get-values 2>/dev/null || true)"
if [[ -z "${AZD_VALUES}" ]]; then
  echo "Error: Could not read azd environment values. Run 'azd env refresh' or select an environment." >&2
  exit 1
fi

get_env_value() {
  local key="$1"
  local line
  line="$(echo "${AZD_VALUES}" | grep -m 1 "^${key}=" || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  echo "${line}"
}

normalize_url() {
  local value="$1"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%/}"
  echo "${value}"
}

static_web_app_url=""

for key in APP_URL SERVICE_APP_URL WEB_APP_URL FRONTEND_URL; do
  value="$(get_env_value "${key}" || true)"
  if [[ -n "${value}" && "${value}" =~ ^https?:// ]]; then
    static_web_app_url="$(normalize_url "${value}")"
    break
  fi
done

if [[ -z "${static_web_app_url}" ]]; then
  redirect_uri="$(get_env_value "APP_REDIRECT_URI" || true)"
  if [[ -n "${redirect_uri}" && "${redirect_uri}" =~ ^https?:// ]]; then
    # Keep only scheme + host from redirect URI.
    static_web_app_url="$(echo "${redirect_uri}" | sed -E 's#^(https?://[^/]+).*$#\1#' | sed 's#/$##')"
  fi
fi

declare -A container_app_urls=()
for key in API_URL API_FUNCTIONS_URL API_MCP_URL FUNCTION_URL MCP_SERVICE_URL APP_ADMIN_URL MCP_INSPECTOR_URL MCP_INSPECTOR_APP_URL; do
  value="$(get_env_value "${key}" || true)"
  if [[ -n "${value}" && "${value}" =~ ^https?:// ]]; then
    url="$(normalize_url "${value}")"
    container_app_urls["${url}"]="${key}"
  fi
done

echo "App URLs from azd environment"
echo ""

if [[ -n "${static_web_app_url}" ]]; then
  echo "Static Web App"
  echo "- ${static_web_app_url}"
  echo ""
else
  echo "Static Web App"
  echo "- Not found in azd env values"
  echo ""
fi

echo "Container Apps"
if [[ ${#container_app_urls[@]} -eq 0 ]]; then
  echo "- Not found in azd env values"
else
  for url in "${!container_app_urls[@]}"; do
    echo "- ${url}"
  done | sort
fi
