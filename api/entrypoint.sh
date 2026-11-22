#!/usr/bin/env sh
set -eu

# Configurable wait parameters
MI_RESOURCE="${MI_RESOURCE:-https://database.windows.net}"
MI_INITIAL_DELAY_SECONDS="${MI_INITIAL_DELAY_SECONDS:-10}"
MI_PERIOD_SECONDS="${MI_PERIOD_SECONDS:-2}"
MI_FAILURE_THRESHOLD="${MI_FAILURE_THRESHOLD:-60}"
MI_CLIENT_ID="${MI_CLIENT_ID:-${AZURE_CLIENT_ID:-}}"

log() {
  echo "[entrypoint][$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

if [ -z "${DAB_MCP_ALLOWED_HOST:-}" ]; then
  if [ -n "${CONTAINER_APP_NAME:-}" ] && [ -n "${CONTAINER_APP_ENV_DNS_SUFFIX:-}" ]; then
    DAB_MCP_ALLOWED_HOST="${CONTAINER_APP_NAME}.${CONTAINER_APP_ENV_DNS_SUFFIX}"
  elif [ -n "${CONTAINER_APP_NAME:-}${CONTAINER_APP_ENV_DNS_SUFFIX:-}${IDENTITY_ENDPOINT:-}" ]; then
    log "Cannot configure MCP trusted host: Container Apps hostname metadata is incomplete."
    exit 1
  else
    DAB_MCP_ALLOWED_HOST=localhost
  fi
fi
case "$DAB_MCP_ALLOWED_HOST" in
  *[!a-zA-Z0-9.-]*|.*|*.|-*|*-|*..*)
    log "Invalid MCP trusted host: expected an exact hostname, not a wildcard, URL or port."
    exit 1
    ;;
esac
export DAB_MCP_ALLOWED_HOST
log "MCP transport trusts only the configured application hostname (plus DAB loopback defaults)."

wait_for_mi_token() {
  # If not running in Azure Container Apps with MI, skip the wait
  if [ -z "${IDENTITY_ENDPOINT:-}" ]; then
    log "IDENTITY_ENDPOINT not set; skipping MI wait."
    return 0
  fi

  log "Waiting for Managed Identity token availability..."
  if [ "${MI_INITIAL_DELAY_SECONDS}" -gt 0 ]; then
    log "Initial delay: ${MI_INITIAL_DELAY_SECONDS}s"
    sleep "${MI_INITIAL_DELAY_SECONDS}"
  fi

  i=1
  while [ "$i" -le "${MI_FAILURE_THRESHOLD}" ]; do
    mi_url="${IDENTITY_ENDPOINT}?resource=${MI_RESOURCE}&api-version=2019-08-01"
    if [ -n "${MI_CLIENT_ID}" ]; then
      mi_url="${mi_url}&client_id=${MI_CLIENT_ID}"
    fi

    status=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "X-Identity-Header: ${IDENTITY_HEADER:-}" \
      "$mi_url" || echo 000)

    if [ "$status" = "200" ]; then
      log "Managed Identity token endpoint is ready (HTTP 200)."
      return 0
    fi

    log "MI token not ready yet (status=$status). Attempt $i/${MI_FAILURE_THRESHOLD}; sleeping ${MI_PERIOD_SECONDS}s..."
    sleep "${MI_PERIOD_SECONDS}"
    i=$((i+1))
  done

  log "Timed out waiting for Managed Identity token after ${MI_FAILURE_THRESHOLD} attempts. Exiting."
  return 1
}

wait_for_mi_token

DB_INITIAL_DELAY="${DB_INITIAL_DELAY_SECONDS:-0}"
DB_RETRY_INITIAL="${DB_RETRY_INITIAL_SECONDS:-5}"
DB_RETRY_MAX="${DB_RETRY_MAX_SECONDS:-40}"
DB_START_DEADLINE="${DB_START_DEADLINE_SECONDS:-150}"

if [ "${DB_INITIAL_DELAY}" -gt 0 ]; then
  log "Database wait initial delay: ${DB_INITIAL_DELAY}s"
  sleep "${DB_INITIAL_DELAY}"
fi

# Run from the directory where dab-config.json resides
APP_DIR="${DAB_APP_DIR:-/App}"
cd "$APP_DIR"
if [ -f "$APP_DIR/Microsoft.DataApiBuilder.dll" ]; then
  set -- dotnet "$APP_DIR/Microsoft.DataApiBuilder.dll" start --config "$APP_DIR/dab-config.json"
else
  log "Microsoft.DataApiBuilder.dll not found; using 'dab start' (may fail if CLI isn't installed)"
  set -- dab start --config "$APP_DIR/dab-config.json"
fi

child=""
forward_signal() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 143
}
trap forward_signal TERM INT

# DAB exits at startup while the database is paused or the seed job has not created the
# schema yet. Retry with bounded exponential backoff inside the startup window, then exit
# non-zero so Container Apps restarts the replica.
started_at=$(date +%s)
delay="$DB_RETRY_INITIAL"
attempt=1
while :; do
  log "Starting Data API Builder (attempt $attempt)"
  "$@" &
  child=$!
  set +e
  wait "$child"
  status=$?
  set -e
  child=""

  elapsed=$(( $(date +%s) - started_at ))
  if [ "$status" -eq 0 ]; then
    log "Data API Builder exited cleanly."
    exit 0
  fi
  if [ $((elapsed + delay)) -ge "$DB_START_DEADLINE" ]; then
    log "Data API Builder exited with status $status after ${elapsed}s; not retrying (deadline ${DB_START_DEADLINE}s)."
    exit "$status"
  fi
  log "Data API Builder exited with status $status (database may not be ready); retrying in ${delay}s..."
  sleep "$delay"
  delay=$((delay * 2))
  if [ "$delay" -gt "$DB_RETRY_MAX" ]; then
    delay="$DB_RETRY_MAX"
  fi
  attempt=$((attempt + 1))
done
