#!/usr/bin/env bash
# Smoke tests for the AdventureWorks MCP OAuth deployment + core app endpoints.
#
# Every check prints PASS/FAIL in an aligned column (unchanged). On FAILURE each
# check now also prints a diagnostic block so a problem can be understood from a
# single run without re-instrumenting the script:
#   - the exact URL that was requested (reveals empty / wrong azd values)
#   - the HTTP status code and request time
#   - curl's exit code translated to plain English (DNS vs refused vs timeout vs
#     TLS vs empty-URL — i.e. what an opaque "000" actually means)
#   - the response headers and body (e.g. the OpenIddict error that explains a
#     400 from the authorization-server metadata endpoint)
#
# The script exits 0 when all checks pass and 1 when any fail (matching the
# convention documented in tests/scripts/README.md).
#
# Tunables (env vars):
#   SMOKE_TIMEOUT         per-attempt max seconds (default 60; raised from 20 so a
#                         scaled-to-zero Container App cold start is not reported as failure)
#   SMOKE_CONNECT_TIMEOUT TCP connect timeout in seconds (default 15)
#   SMOKE_RETRIES         extra attempts on a transient failure — timeout, connection reset,
#                         DNS, or 000/408/429/5xx (default 2). Lets a single run absorb a cold
#                         start instead of needing a manual second run.
#   SMOKE_RETRY_DELAY     seconds between attempts (default 3)
#   SMOKE_BODY_MAX        max bytes of body/headers echoed on failure (default 1200)
set -u

TIMEOUT="${SMOKE_TIMEOUT:-60}"
CONNECT_TIMEOUT="${SMOKE_CONNECT_TIMEOUT:-15}"
RETRIES="${SMOKE_RETRIES:-2}"
RETRY_DELAY="${SMOKE_RETRY_DELAY:-3}"
BODY_MAX="${SMOKE_BODY_MAX:-1200}"

passes=0
fails=0

# Populated by do_request; initialised so 'set -u' is safe before the first request.
R_CODE="000"; R_EXIT=0; R_TIME="?"; R_BODY=""; R_HDRS=""; R_ERR=""; R_ATTEMPTS=1

# ---- dependency checks -------------------------------------------------------
missing=""
for bin in azd curl python3; do
    command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
done
if [ -n "$missing" ]; then
    echo "ERROR: required tool(s) not found:$missing" >&2
    echo "Install them and run 'azd auth login' + select an environment before re-running." >&2
    exit 2
fi

# ---- output helpers ----------------------------------------------------------
pass() {
    printf "%-52s %s\n" "$1" "PASS"
    passes=$((passes + 1))
    # Surface cold-start recovery so a slow-but-healthy service is still visible.
    [ "${R_ATTEMPTS:-1}" -gt 1 ] && note "(warmed up after $R_ATTEMPTS attempts — cold start absorbed)"
}
fail() { printf "%-52s %s\n" "$1" "FAIL"; fails=$((fails + 1)); }
note() { printf "      %s\n" "$1"; }   # single indented diagnostic line
blk() {                                 # indented multi-line block (or "(none)")
    if [ -z "$1" ]; then
        printf "        (none)\n"
    else
        printf '%s\n' "$1" | sed 's/^/        /'
    fi
}

# Translate a curl exit code into a human-readable cause. This is what turns an
# opaque "000" into an actionable message.
curl_hint() {
    case "$1" in
    0) echo "transport OK (server returned a non-2xx HTTP status)" ;;
    2) echo "curl initialisation failed / unknown option" ;;
    3) echo "URL malformed or EMPTY (the azd env value is almost certainly missing)" ;;
    5) echo "couldn't resolve proxy" ;;
    6) echo "couldn't resolve host via DNS — hostname is wrong or empty" ;;
    7) echo "failed to connect (connection refused / no route) — service down or wrong port" ;;
    22) echo "server returned HTTP >= 400 (with --fail)" ;;
    28) echo "timed out after ${TIMEOUT}s — service slow to respond, scaled-to-zero cold start, or unreachable" ;;
    35) echo "TLS handshake failed" ;;
    47) echo "too many redirects" ;;
    51) echo "the server's TLS certificate/fingerprint was not OK" ;;
    52) echo "empty reply from server (connected, but no HTTP response)" ;;
    56) echo "failure receiving network data (connection reset)" ;;
    60) echo "TLS certificate problem (untrusted, expired, or hostname mismatch)" ;;
    *) echo "curl exit $1 — see 'man curl' EXIT CODES" ;;
    esac
}

# Decide whether a result is worth retrying (cold-start / transient network blip) rather than
# a deterministic failure we want to surface immediately (e.g. a 400/401/404). Used by
# do_request to absorb scaled-to-zero Container App wake-ups within a single invocation.
_transient() {
    # $1 = curl exit code, $2 = http status
    case "$1" in
    6 | 7 | 28 | 35 | 52 | 56) return 0 ;; # DNS / refused / timeout / TLS / empty reply / reset
    esac
    case "$2" in
    000 | 408 | 429 | 500 | 502 | 503 | 504) return 0 ;;
    esac
    return 1
}

# ---- HTTP request wrapper ----------------------------------------------------
# Usage: do_request METHOD URL [extra curl args...]
# Sets globals: R_CODE R_EXIT R_TIME R_BODY R_HDRS R_ERR R_ATTEMPTS
# Retries transient failures (cold starts) up to SMOKE_RETRIES times.
do_request() {
    local method="$1" url="$2"
    shift 2
    R_CODE="000"
    R_EXIT=0
    R_TIME="?"
    R_BODY=""
    R_HDRS=""
    R_ERR=""
    R_ATTEMPTS=0
    if [ -z "$url" ]; then
        R_EXIT=3
        R_ERR="URL is empty (azd env value missing) — nothing was requested"
        R_ATTEMPTS=1
        return
    fi
    local bf hf ef out max
    max=$((RETRIES + 1))
    while :; do
        R_ATTEMPTS=$((R_ATTEMPTS + 1))
        bf=$(mktemp)
        hf=$(mktemp)
        ef=$(mktemp)
        out=$(curl -sS -X "$method" \
            -o "$bf" -D "$hf" \
            -w '%{http_code} %{time_total}' \
            --connect-timeout "$CONNECT_TIMEOUT" --max-time "$TIMEOUT" \
            "$@" "$url" 2>"$ef")
        R_EXIT=$?
        R_CODE="${out%% *}"
        [ -z "$R_CODE" ] && R_CODE="000"
        R_TIME="${out##* }"
        [ "$R_TIME" = "$out" ] && R_TIME="?"
        R_BODY=$(head -c "$BODY_MAX" "$bf" 2>/dev/null)
        R_HDRS=$(tr -d '\r' <"$hf" | head -c "$BODY_MAX")
        R_ERR=$(tr -d '\r' <"$ef")
        rm -f "$bf" "$hf" "$ef"
        if [ "$R_ATTEMPTS" -lt "$max" ] && _transient "$R_EXIT" "$R_CODE"; then
            sleep "$RETRY_DELAY"
            continue
        fi
        break
    done
}

# Print a standard failure diagnostic block for the most recent do_request.
diag() {
    local url="$1"
    note "url:        ${url:-(empty)}"
    note "http_code:  $R_CODE   time: ${R_TIME}s   curl_exit: $R_EXIT   attempts: $R_ATTEMPTS"
    note "cause:      $(curl_hint "$R_EXIT")"
    if [ -n "$R_ERR" ]; then
        note "curl_stderr:"
        blk "$R_ERR"
    fi
    if [ -n "$R_BODY" ]; then
        note "body:"
        blk "$R_BODY"
    fi
}

# ---- resolve configuration from azd env -------------------------------------
getv() { azd env get-value "$1" 2>/dev/null; }

env_name=$(getv AZURE_ENV_NAME)

mcp=$(getv API_MCP_URL)
mcp_base=${mcp%/mcp}
api=$(getv API_URL)
func=$(getv API_FUNCTIONS_URL)
app=$(getv APP_URL)
admin=$(getv APP_ADMIN_URL)
mfg=$(getv APP_MANUFACTURING_URL)
insp=$(getv MCP_INSPECTOR_URL)

echo
echo "=== Resolved configuration ${env_name:+(env: $env_name)} ==="
printf "  %-24s %s\n" "API_MCP_URL"           "${mcp:-(EMPTY)}"
printf "  %-24s %s\n" "  mcp_base (derived)"  "${mcp_base:-(EMPTY)}"
printf "  %-24s %s\n" "API_URL"               "${api:-(EMPTY)}"
printf "  %-24s %s\n" "API_FUNCTIONS_URL"     "${func:-(EMPTY)}"
printf "  %-24s %s\n" "APP_URL"               "${app:-(EMPTY)}"
printf "  %-24s %s\n" "APP_ADMIN_URL"         "${admin:-(EMPTY)}"
printf "  %-24s %s\n" "APP_MANUFACTURING_URL" "${mfg:-(EMPTY)}"
printf "  %-24s %s\n" "MCP_INSPECTOR_URL"     "${insp:-(EMPTY)}"

empties=""
for pair in \
    "API_MCP_URL=$mcp" "API_URL=$api" "API_FUNCTIONS_URL=$func" \
    "APP_URL=$app" "APP_ADMIN_URL=$admin" \
    "APP_MANUFACTURING_URL=$mfg" "MCP_INSPECTOR_URL=$insp"; do
    [ -z "${pair#*=}" ] && empties="$empties ${pair%%=*}"
done
if [ -n "$empties" ]; then
    echo
    echo "  WARNING: empty azd value(s):$empties"
    echo "  Empty values below will fail with http_code 000 / curl_exit 3. Refresh the"
    echo "  environment outputs and re-run:"
    echo "      azd env refresh"
fi

echo
echo "=== MCP OAuth Discovery ==="

# 1) Protected-resource metadata (RFC 9728).
url="$mcp_base/.well-known/oauth-protected-resource"
do_request GET "$url"
if [ "$R_CODE" = "200" ]; then
    pass "protected-resource metadata ($R_CODE)"
else
    fail "protected-resource metadata ($R_CODE)"
    diag "$url"
fi

# 2) Authorization-server metadata (RFC 8414 / OIDC). Keep the body for JWKS.
url="$mcp_base/.well-known/openid-configuration"
do_request GET "$url"
META_BODY="$R_BODY"
META_CODE="$R_CODE"
if [ "$R_CODE" = "200" ]; then
    pass "authz-server metadata ($R_CODE)"
else
    fail "authz-server metadata ($R_CODE)"
    diag "$url"
    if [ "$R_CODE" = "400" ]; then
        note "hint: OpenIddict returns 400 here when it rejects the request host/issuer"
        note "      (e.g. reached over http instead of https, a Host header it doesn't"
        note "      trust, or an Issuer mismatch). The body above holds the OpenIddict"
        note "      error_description that names the exact reason."
    fi
fi

# 3) JWKS — extract jwks_uri from the metadata fetched above, then fetch it.
jwks=$(printf '%s' "$META_BODY" | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("jwks_uri", ""))
except Exception:
    print("")' 2>/dev/null)
if [ -n "$jwks" ]; then
    do_request GET "$jwks"
    if [ "$R_CODE" = "200" ]; then
        pass "JWKS reachable ($R_CODE)"
    else
        fail "JWKS ($R_CODE)"
        diag "$jwks"
    fi
else
    fail "JWKS URI missing from OIDC metadata"
    note "could not extract jwks_uri from authz-server metadata (that check returned $META_CODE)."
    note "metadata body that was parsed:"
    blk "$META_BODY"
    note "fix the authz-server metadata check above first; JWKS is advertised by it."
fi

echo
echo "=== MCP Challenge ==="

# MCP must challenge unauthenticated calls with a 401 that points discovery clients at the
# protected-resource metadata (RFC 9728 WWW-Authenticate). The /mcp Streamable HTTP endpoint
# is POST-only, so it must be probed with POST: a GET matches the route but not the method and
# returns 405 at routing — before authorization runs — so the 401 challenge never fires. An
# unauthenticated POST (no bearer token) reaches the authorization policy and is rejected with
# the challenge regardless of the JSON-RPC body. The status line is CR-stripped by do_request.
url="$mcp_base/mcp"
do_request POST "$url" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
status_line=$(printf '%s' "$R_HDRS" | head -1)
if printf '%s' "$R_HDRS" | grep -qi 'WWW-Authenticate:.*resource_metadata'; then
    pass "/mcp 401 challenge (${status_line:-?})"
else
    fail "/mcp challenge (${status_line:-no response})"
    diag "$url"
    note "expected: HTTP 401 with header 'WWW-Authenticate: ****** resource_metadata=...'"
    note "response headers received:"
    blk "$R_HDRS"
    case "$R_CODE" in
    405)
        note "hint: 405 means the method was rejected at routing. /mcp is POST-only and this"
        note "      probe already uses POST, so a 405 now implies the MCP transport is not"
        note "      mapped at this path (check app.MapMcp(\"/mcp\")) or an ingress path rewrite." ;;
    401)
        note "hint: got 401 but no resource_metadata challenge — the WWW-Authenticate hook in"
        note "      UseMcpAuthorization did not attach the header (check the /mcp OnStarting hook)." ;;
    200)
        note "hint: an unauthenticated call unexpectedly SUCCEEDED (200). /mcp must require the"
        note "      mcp.access scope — verify .RequireAuthorization(McpPolicy) on the endpoint." ;;
    esac
fi

echo
echo "=== Application Endpoints ==="

# 3) DAB GraphQL.
do_request POST "$api" -H 'content-type: application/json' --data '{"query":"{ __typename }"}'
if [ "$R_CODE" = "200" ]; then
    pass "GraphQL API ($R_CODE)"
else
    fail "GraphQL API ($R_CODE)"
    diag "$api"
fi

# 4) Functions health.
url="$func/api/health"
do_request GET "$url"
if [ "$R_CODE" = "200" ]; then
    pass "Functions /api/health ($R_CODE)"
else
    fail "Functions /api/health ($R_CODE)"
    diag "$url"
fi

# 5) Frontends.
for pair in \
    "e-shop=$app" \
    "admin=$admin" \
    "manufacturing=$mfg" \
    "mcp-inspector=$insp"; do
    name=${pair%%=*}
    url=${pair#*=}
    do_request GET "$url"
    if [ "$R_CODE" = "200" ]; then
        pass "frontend $name ($R_CODE)"
    else
        fail "frontend $name ($R_CODE)"
        diag "$url"
    fi
done

echo
echo "=== Summary ==="
printf "  %d passed, %d failed\n" "$passes" "$fails"
if [ "$fails" -ne 0 ]; then
    echo "  Re-run after addressing the diagnostics above. Tunables: SMOKE_TIMEOUT,"
    echo "  SMOKE_CONNECT_TIMEOUT, SMOKE_RETRIES, SMOKE_RETRY_DELAY, SMOKE_BODY_MAX."
    exit 1
fi
exit 0
