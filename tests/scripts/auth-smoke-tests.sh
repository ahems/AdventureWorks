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
# Tunables (env vars): SMOKE_TIMEOUT (default 20s), SMOKE_CONNECT_TIMEOUT (10s),
# SMOKE_BODY_MAX (max bytes of body/headers echoed, default 1200).
set -u

TIMEOUT="${SMOKE_TIMEOUT:-20}"
CONNECT_TIMEOUT="${SMOKE_CONNECT_TIMEOUT:-10}"
BODY_MAX="${SMOKE_BODY_MAX:-1200}"

passes=0
fails=0

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
pass() { printf "%-52s %s\n" "$1" "PASS"; passes=$((passes + 1)); }
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

# ---- HTTP request wrapper ----------------------------------------------------
# Usage: do_request METHOD URL [extra curl args...]
# Sets globals: R_CODE R_EXIT R_TIME R_BODY R_HDRS R_ERR
do_request() {
    local method="$1" url="$2"
    shift 2
    R_CODE="000"
    R_EXIT=0
    R_TIME="?"
    R_BODY=""
    R_HDRS=""
    R_ERR=""
    if [ -z "$url" ]; then
        R_EXIT=3
        R_ERR="URL is empty (azd env value missing) — nothing was requested"
        return
    fi
    local bf hf ef out
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
}

# Print a standard failure diagnostic block for the most recent do_request.
diag() {
    local url="$1"
    note "url:        ${url:-(empty)}"
    note "http_code:  $R_CODE   time: ${R_TIME}s   curl_exit: $R_EXIT"
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

# MCP must challenge unauthenticated calls with a 401 that points discovery
# clients at the protected-resource metadata (RFC 9728 WWW-Authenticate). The
# status line is CR-stripped by do_request so it no longer corrupts the output.
url="$mcp_base/mcp"
do_request GET "$url"
status_line=$(printf '%s' "$R_HDRS" | head -1)
if printf '%s' "$R_HDRS" | grep -qi 'WWW-Authenticate:.*resource_metadata'; then
    pass "/mcp 401 challenge (${status_line:-?})"
else
    fail "/mcp challenge (${status_line:-no response})"
    diag "$url"
    note "expected: HTTP 401 with header 'WWW-Authenticate: ****** resource_metadata=...'"
    note "response headers received:"
    blk "$R_HDRS"
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
    echo "  SMOKE_CONNECT_TIMEOUT, SMOKE_BODY_MAX."
    exit 1
fi
exit 0
