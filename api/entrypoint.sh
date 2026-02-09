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

# Wait for database schema to be ready (seed job may still be running)
wait_for_database_schema() {
  DB_INITIAL_DELAY="${DB_INITIAL_DELAY_SECONDS:-0}"
  DB_PERIOD="${DB_PERIOD_SECONDS:-10}"
  DB_MAX_RETRIES="${DB_FAILURE_THRESHOLD:-50}"
  
  if [ "${DB_INITIAL_DELAY}" -gt 0 ]; then
    log "Database wait initial delay: ${DB_INITIAL_DELAY}s"
    sleep "${DB_INITIAL_DELAY}"
  fi

  # Simple approach: Add a configurable delay to allow seed job to complete
  # Container Apps will restart if DAB crashes, creating an effective retry loop
  # After several restarts (~6 minutes), the seed job completes and DAB starts successfully
  if [ "${DB_PERIOD}" -gt 0 ]; then
    log "Waiting ${DB_PERIOD}s before starting DAB to allow database seeding to complete..."
    sleep "${DB_PERIOD}"
  fi
  
  log "Database wait complete. Starting DAB (Container Apps will restart if schema not ready)."
}

wait_for_database_schema

# Start Data API Builder
# Ensure we run from /App where dab-config.json resides
cd /App
if [ -f "/App/Microsoft.DataApiBuilder.dll" ]; then
  log "Starting Data API Builder via dotnet runtime"
  exec dotnet /App/Microsoft.DataApiBuilder.dll start --config /App/dab-config.json
else
  log "Microsoft.DataApiBuilder.dll not found; attempting 'dab start' (may fail if CLI isn't installed)"
  exec dab start --config /App/dab-config.json
fi
