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
#   SMOKE_BODY_MAX        max bytes of body/headers *echoed* on failure (default 4000). This
#                         caps DISPLAY only — JSON is always parsed from the full body, so a
#                         large document is never truncated before extraction/validation.
#   SMOKE_PARSE_MAX       max bytes of body captured for JSON parsing (default 1048576)
#   SMOKE_AI_TIMEOUT      per-attempt max seconds for the AI agent endpoints (default 120).
#                         A real Azure OpenAI agent turn (Generate Promotion) can take tens of
#                         seconds, so it gets a longer budget than the plain-HTTP checks.
#   SMOKE_DEMO_USER       seeded demo admin email used by the authenticated OAuth login flow
#                         (default demo.admin@adventureworks.com — seeded by
#                         seed-job/seed-database.ps1; override if the seed values changed)
#   SMOKE_DEMO_PASS       password for SMOKE_DEMO_USER (default is the documented demo password
#                         already committed in seed-job/seed-database.ps1 — NOT a real secret)
set -u

TIMEOUT="${SMOKE_TIMEOUT:-60}"
CONNECT_TIMEOUT="${SMOKE_CONNECT_TIMEOUT:-15}"
RETRIES="${SMOKE_RETRIES:-2}"
RETRY_DELAY="${SMOKE_RETRY_DELAY:-3}"
BODY_MAX="${SMOKE_BODY_MAX:-4000}"
PARSE_MAX="${SMOKE_PARSE_MAX:-1048576}"
AI_TIMEOUT="${SMOKE_AI_TIMEOUT:-120}"

passes=0
fails=0

# Populated by do_request; initialised so 'set -u' is safe before the first request.
# R_BODY is the display-truncated body (<= BODY_MAX); R_BODY_FULL is the full body used for
# JSON parsing (<= PARSE_MAX) — the two were conflated before, which truncated metadata to
# invalid JSON and made jwks_uri un-parseable even though it was present.
R_CODE="000"; R_EXIT=0; R_TIME="?"; R_BODY=""; R_BODY_FULL=""; R_HDRS=""; R_ERR=""; R_ATTEMPTS=1

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
# Sets globals: R_CODE R_EXIT R_TIME R_BODY R_BODY_FULL R_HDRS R_ERR R_ATTEMPTS
# Retries transient failures (cold starts) up to SMOKE_RETRIES times.
do_request() {
    local method="$1" url="$2"
    shift 2
    R_CODE="000"
    R_EXIT=0
    R_TIME="?"
    R_BODY=""
    R_BODY_FULL=""
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
        # Capture the full body for parsing, then derive the display-truncated view from it.
        # Parsing must never see a truncated (invalid-JSON) body — that was the jwks_uri bug.
        R_BODY_FULL=$(head -c "$PARSE_MAX" "$bf" 2>/dev/null)
        R_BODY=$(printf '%s' "$R_BODY_FULL" | head -c "$BODY_MAX")
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

# ---- JSON assertion helper ---------------------------------------------------
# Usage: check_json LABEL JSON PREDICATE
#   PREDICATE is a Python boolean expression over `d` (the parsed JSON document). A small set
#   of safe builtins (len/any/all/str/bool/int/isinstance/dict/list/set/sorted) is provided;
#   __builtins__ is otherwise stripped. The expression is a fixed literal authored in this
#   script — never user input — so eval here is controlled. Prints PASS, or FAIL with the
#   reason, predicate and body.
check_json() {
    local label="$1" json="$2" expr="$3" out rc
    out=$(printf '%s' "$json" | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception as e:
    print("response was not valid JSON: %s" % e)
    sys.exit(2)
safe = {"len": len, "any": any, "all": all, "str": str,
        "isinstance": isinstance, "dict": dict, "list": list,
        "set": set, "sorted": sorted, "bool": bool, "int": int}
try:
    ok = bool(eval(sys.argv[1], {"__builtins__": {}}, dict(safe, d=d)))
except Exception as e:
    print("predicate raised %s: %s" % (type(e).__name__, e))
    sys.exit(3)
sys.exit(0 if ok else 1)
' "$expr" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
        pass "$label"
    else
        fail "$label"
        [ -n "$out" ] && note "reason:     $out"
        note "predicate:  $expr"
        note "body:"
        blk "$(printf '%s' "$json" | head -c "$BODY_MAX")"
    fi
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

# ---- OAuth login-flow helpers (used by the authenticated-access section) ------
# python3 is already a hard dependency, so PKCE / JWT / SSE handling is done there rather than
# adding an openssl dependency.

# PKCE S256 pair (RFC 7636): sets PKCE_VERIFIER and PKCE_CHALLENGE.
gen_pkce() {
    local out
    out=$(python3 -c 'import secrets, hashlib, base64
v = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
c = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()
print(v + " " + c)') || return 1
    PKCE_VERIFIER="${out%% *}"
    PKCE_CHALLENGE="${out##* }"
}

# Opaque anti-forgery 'state' value.
rand_state() { python3 -c 'import secrets; print(secrets.token_urlsafe(16))'; }

# Percent-decode stdin (for an authorization code read out of a Location header).
urldecode() { python3 -c 'import sys, urllib.parse as u; sys.stdout.write(u.unquote(sys.stdin.read()))'; }

# Decode the (unverified) JWT payload for claim inspection. The resource server verifies the
# signature for real; here we only read public, non-sensitive claims for display/assertions.
jwt_payload() {
    python3 -c 'import sys, base64, json
t = sys.stdin.read().strip()
p = t.split(".")
if len(p) < 2:
    sys.exit(1)
seg = p[1] + "=" * (-len(p[1]) % 4)
try:
    raw = base64.urlsafe_b64decode(seg)
    json.loads(raw)            # validate it is JSON
    sys.stdout.write(raw.decode("utf-8", "replace"))
except Exception:
    sys.exit(1)'
}

# Unwrap an MCP Streamable-HTTP response (SSE 'data:' frames OR a plain JSON body) into the
# single JSON-RPC message object carrying result/error. Prints nothing + exits 1 if none found.
mcp_unwrap() {
    python3 -c 'import sys, json
raw = sys.stdin.read()
cands = [l.strip()[5:].strip() for l in raw.splitlines() if l.strip().startswith("data:")]
cands.append(raw.strip())
for c in cands:
    if not c:
        continue
    try:
        o = json.loads(c)
    except Exception:
        continue
    if isinstance(o, dict) and ("result" in o or "error" in o):
        print(json.dumps(o))
        sys.exit(0)
sys.exit(1)'
}

# First value (CR-stripped) of a response header from the most recent do_request (R_HDRS).
header_value() { printf '%s' "$R_HDRS" | grep -i "^$1:" | head -1 | sed "s/^[^:]*:[[:space:]]*//" | tr -d '\r'; }

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

# Seeded demo admin used by the authenticated OAuth login flow. Defaults to the documented demo
# values committed in seed-job/seed-database.ps1 (BusinessEntityID 99001, PersonType 'EM', which
# resolves to role 'operations-admin' / category 'employee'). Override via SMOKE_DEMO_USER /
# SMOKE_DEMO_PASS. This is a demonstration credential, never a real secret.
DEMO_USER="${SMOKE_DEMO_USER:-demo.admin@adventureworks.com}"
DEMO_PASS="${SMOKE_DEMO_PASS:-Admin1234!}"
# First-party PUBLIC client (PKCE, loopback redirect) always registered at deploy time, so the
# login flow is deployment-independent — no secret and no hard-coded Azure hostname.
OAUTH_CLIENT="mcp-inspector"
OAUTH_REDIRECT="http://localhost:6274/oauth/callback"

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
printf "  %-24s %s\n" "SMOKE_DEMO_USER"       "${DEMO_USER:-(EMPTY)}  (OAuth login flow; password hidden)"

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

# 1) Protected-resource metadata (RFC 9728) — reachable AND advertises the resource, its
#    authorization server(s), the mcp.access scope and bearer-in-header token delivery.
url="$mcp_base/.well-known/oauth-protected-resource"
do_request GET "$url"
if [ "$R_CODE" = "200" ]; then
    pass "protected-resource metadata ($R_CODE)"
    check_json "protected-resource: resource + AS + mcp.access + bearer header" "$R_BODY_FULL" \
        "bool(d.get('resource')) and len(d.get('authorization_servers') or []) > 0 and 'mcp.access' in (d.get('scopes_supported') or []) and 'header' in (d.get('bearer_methods_supported') or [])"
else
    fail "protected-resource metadata ($R_CODE)"
    diag "$url"
fi

# 2) Authorization-server metadata. OAuth/MCP clients discover the AS via RFC 8414 at
#    /.well-known/oauth-authorization-server; /.well-known/openid-configuration is the OIDC
#    compatibility alias. Both are served by OpenIddict. Fetch the RFC 8414 document for
#    content validation and keep its FULL body (not the display-truncated copy) for JWKS.
as_url="$mcp_base/.well-known/oauth-authorization-server"
do_request GET "$as_url"
as_meta="$R_BODY_FULL"
as_code="$R_CODE"
if [ "$R_CODE" = "200" ]; then
    pass "authz-server metadata — RFC 8414 ($R_CODE)"
else
    fail "authz-server metadata — RFC 8414 ($R_CODE)"
    diag "$as_url"
    if [ "$R_CODE" = "400" ]; then
        note "hint: OpenIddict returns 400 here when it rejects the request scheme/host/issuer"
        note "      (e.g. reached over http behind a proxy without X-Forwarded-Proto honoured,"
        note "      a Host it doesn't trust, or an Issuer mismatch). The body above names it."
    fi
fi

# OIDC compatibility alias — reachability check (serves the same document). If the RFC 8414
# path somehow failed but this one works, fall back to it for the content/JWKS checks.
oidc_url="$mcp_base/.well-known/openid-configuration"
do_request GET "$oidc_url"
if [ "$R_CODE" = "200" ]; then
    pass "authz-server metadata — OIDC alias ($R_CODE)"
    if [ "$as_code" != "200" ]; then
        as_meta="$R_BODY_FULL"
        as_code="200"
    fi
else
    fail "authz-server metadata — OIDC alias ($R_CODE)"
    diag "$oidc_url"
fi

# Content-validate the AS metadata document (whichever alias served it).
if [ "$as_code" = "200" ]; then
    check_json "AS metadata: issuer + endpoints are HTTPS" "$as_meta" \
        "d['issuer'].startswith('https://') and d['authorization_endpoint'].startswith('https://') and 'authorize' in d['authorization_endpoint'] and d['token_endpoint'].startswith('https://') and 'token' in d['token_endpoint'] and d['jwks_uri'].startswith('https://')"
    check_json "AS metadata: Authorization Code + PKCE S256 only (no 'plain')" "$as_meta" \
        "'code' in d['response_types_supported'] and 'authorization_code' in d['grant_types_supported'] and 'S256' in d['code_challenge_methods_supported'] and 'plain' not in d['code_challenge_methods_supported']"
    check_json "AS metadata: business scopes advertised (mcp.access, products.read)" "$as_meta" \
        "set(['mcp.access','products.read']).issubset(set(d.get('scopes_supported') or []))"
else
    fail "AS metadata content checks skipped"
    note "neither the RFC 8414 nor the OIDC metadata endpoint returned 200; fix those first."
fi

# 3) JWKS — extract the advertised jwks_uri from the FULL metadata body (never the truncated
#    display copy — that conflation was the original 'JWKS URI missing' bug), fetch it, and
#    assert only PUBLIC RSA key material is published (no private d/p/q components).
jwks=$(printf '%s' "$as_meta" | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("jwks_uri", ""))
except Exception:
    print("")' 2>/dev/null)
if [ -n "$jwks" ]; then
    do_request GET "$jwks"
    if [ "$R_CODE" = "200" ]; then
        pass "JWKS reachable ($R_CODE)"
        check_json "JWKS: public RSA key(s) only, no private material (d/p/q)" "$R_BODY_FULL" \
            "len(d.get('keys') or []) > 0 and all(k.get('kty') == 'RSA' and 'n' in k and 'e' in k and 'd' not in k and 'p' not in k and 'q' not in k for k in d['keys'])"
    else
        fail "JWKS ($R_CODE)"
        diag "$jwks"
    fi
else
    fail "JWKS URI missing from AS metadata"
    note "could not extract jwks_uri from authz-server metadata (RFC 8414 returned $as_code)."
    note "metadata body that was parsed:"
    blk "$(printf '%s' "$as_meta" | head -c "$BODY_MAX")"
    note "fix the authz-server metadata check above first; JWKS is advertised by it."
fi

echo
echo "=== MCP Authorization Enforcement ==="

# (a) Unauthenticated POST /mcp must be challenged with a 401 that points discovery clients at
#     the protected-resource metadata (RFC 9728 WWW-Authenticate). /mcp is POST-only, so a GET
#     matches the route but not the method and returns 405 at routing — before authorization
#     runs — so the 401 challenge only fires for POST. The status line is CR-stripped already.
url="$mcp_base/mcp"
do_request POST "$url" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
status_line=$(printf '%s' "$R_HDRS" | head -1)
if printf '%s' "$R_HDRS" | grep -qi 'WWW-Authenticate:.*resource_metadata'; then
    pass "/mcp unauthenticated → 401 challenge (${status_line:-?})"
else
    fail "/mcp unauthenticated challenge (${status_line:-no response})"
    diag "$url"
    note "expected: HTTP 401 with header 'WWW-Authenticate: Bearer resource_metadata=...'"
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

# (b) A malformed/forged bearer token must be REJECTED (401), proving the resource server
#     actually validates the token (signature/issuer/audience/lifetime) rather than merely
#     checking that *some* Authorization header is present.
forged_token="Bearer not-a-valid-token"  # obviously-synthetic, no real credential
do_request POST "$url" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "authorization: $forged_token" \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
if [ "$R_CODE" = "401" ]; then
    pass "/mcp forged bearer token → 401 rejected"
else
    fail "/mcp forged bearer token ($R_CODE)"
    diag "$url"
    note "expected: HTTP 401 — a malformed/forged bearer token must be rejected, not accepted."
    if [ "$R_CODE" = "200" ]; then
        note "hint: a bogus token was ACCEPTED (200). Token validation (signature/issuer/audience)"
        note "      is not enforced on /mcp — verify the OpenIddict validation handler + McpPolicy."
    fi
fi

echo
echo "=== OAuth Endpoint Policy ==="

# PKCE S256 challenge for the RFC 7636 sample verifier (dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk).
pkce_challenge="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

# (a) /authorize for an UNKNOWN client must be rejected outright (400) and must NOT redirect a
#     code back — the server cannot trust the redirect of an unregistered client. OpenIddict
#     validates the client before any passthrough, so this needs no login/user selection.
url="$mcp_base/authorize?client_id=__unregistered_smoke__&response_type=code&scope=mcp.access&state=smoke&code_challenge=$pkce_challenge&code_challenge_method=S256"
do_request GET "$url"
if [ "$R_CODE" = "400" ] && ! printf '%s' "$R_HDRS" | grep -qi '^location:.*code='; then
    pass "/authorize unknown client → 400 (no code issued)"
else
    fail "/authorize unknown client ($R_CODE)"
    diag "$url"
    note "expected: HTTP 400 and no redirect carrying 'code=' for an unregistered client."
    if printf '%s' "$R_HDRS" | grep -qi '^location:.*code='; then
        note "hint: the server REDIRECTED a code for an unknown client — client/redirect"
        note "      validation is not enforced before issuing the authorization code."
    fi
fi

# (b) /token with an unsupported grant_type must be rejected (400); only authorization_code is
#     enabled on this server. mcp-inspector is a first-party public client always registered at
#     deploy time, so this logical id is deployment-independent (not a secret, not a hostname).
do_request POST "$mcp_base/token" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data 'grant_type=client_credentials&client_id=mcp-inspector'
if [ "$R_CODE" = "400" ] && printf '%s' "$R_BODY_FULL" | grep -qi 'error'; then
    pass "/token unsupported grant_type → 400"
else
    fail "/token unsupported grant_type ($R_CODE)"
    diag "$mcp_base/token"
    note "expected: HTTP 400 with an OAuth 'error' (unsupported_grant_type); only the"
    note "          authorization_code grant is enabled on this server."
fi

# (c) /token presenting a bogus authorization_code must fail (400 invalid_grant) — codes are
#     single-use, signed and PKCE-bound, so an unknown code is never exchangeable for a token.
do_request POST "$mcp_base/token" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data 'grant_type=authorization_code&code=not-a-real-code&client_id=mcp-inspector&redirect_uri=http%3A%2F%2Flocalhost%3A6274%2Foauth%2Fcallback&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
if [ "$R_CODE" = "400" ] && printf '%s' "$R_BODY_FULL" | grep -qi 'invalid_grant\|error'; then
    pass "/token bogus authorization_code → 400 invalid_grant"
else
    fail "/token bogus authorization_code ($R_CODE)"
    diag "$mcp_base/token"
    note "expected: HTTP 400 invalid_grant — an unknown/forged code must never be exchanged."
fi

echo
echo "=== Authenticated Data Access (demo.admin) ==="
# End-to-end proof that a REAL seeded AdventureWorks user can complete the Authorization Code +
# PKCE (S256) flow and that the issued, resource-bound JWT lets that user READ seeded data via
# MCP — while tool-level authorization still DENIES tools outside the user's role. The demo admin
# is seeded by seed-job/seed-database.ps1 (BusinessEntityID 99001, PersonType 'EM'); with no
# department history it resolves to role 'operations-admin' (category 'employee'). The loopback
# redirect is never followed — only the authorization code in the 302 Location is read.
ACCESS_TOKEN=""
PKCE_VERIFIER=""
PKCE_CHALLENGE=""
auth_code=""
claims=""
if [ -z "$mcp_base" ]; then
    fail "authenticated data access skipped"
    note "API_MCP_URL is empty — cannot resolve the authorization-server base URL."
else
    # Audience the token must be bound to = the protected-resource metadata 'resource' value
    # (authoritative + deployment-derived — never a hard-coded aud).
    pr_resource=""
    do_request GET "$mcp_base/.well-known/oauth-protected-resource"
    if [ "$R_CODE" = "200" ]; then
        pr_resource=$(printf '%s' "$R_BODY_FULL" | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("resource", ""))
except Exception:
    print("")' 2>/dev/null)
    fi
    # demo.admin (operations-admin) owns exactly these scopes; request the set the user has so the
    # grant is non-empty and the token carries the business scopes the MCP checks below rely on.
    scope_req="mcp.access products.read sales.read customers.read customers.write orders.read inventory.read admin.read"

    # (a) NEGATIVE — wrong password must NOT establish a session: /login redirects back to
    #     /login?error=1 and sets no auth cookie. Proves credentials are actually verified.
    neg_jar=$(mktemp)
    do_request POST "$mcp_base/login" \
        -c "$neg_jar" \
        -H 'content-type: application/x-www-form-urlencoded' \
        --data-urlencode "username=$DEMO_USER" \
        --data-urlencode "password=not-the-password" \
        --data-urlencode "returnUrl=/"
    neg_loc=$(header_value location)
    if [ "$R_CODE" = "302" ] && printf '%s' "$neg_loc" | grep -q 'error=1' \
        && ! grep -q 'aw_mcp_login' "$neg_jar" 2>/dev/null; then
        pass "demo.admin wrong password → rejected (302 /login?error=1, no session)"
    else
        fail "demo.admin wrong password rejection ($R_CODE)"
        diag "$mcp_base/login"
        note "expected: 302 to /login?error=1 and NO aw_mcp_login cookie."
        note "location:   ${neg_loc:-(none)}"
    fi
    rm -f "$neg_jar"

    # (b) POSITIVE login — correct credentials establish the AdventureWorks session cookie.
    gen_pkce || note "WARNING: PKCE generation failed (python3/secrets unavailable)"
    state=$(rand_state)
    jar=$(mktemp)
    do_request POST "$mcp_base/login" \
        -c "$jar" \
        -H 'content-type: application/x-www-form-urlencoded' \
        --data-urlencode "username=$DEMO_USER" \
        --data-urlencode "password=$DEMO_PASS" \
        --data-urlencode "returnUrl=/"
    if [ "$R_CODE" = "302" ] && grep -q 'aw_mcp_login' "$jar" 2>/dev/null; then
        pass "demo.admin login → AdventureWorks session issued"
    else
        fail "demo.admin login ($R_CODE)"
        diag "$mcp_base/login"
        note "expected: 302 with an aw_mcp_login session cookie. Check SMOKE_DEMO_USER/PASS and"
        note "          that the demo admin user was seeded (seed-job/seed-database.ps1)."
    fi

    # (c) /authorize consent — Authorization Code + PKCE S256. Mirror the consent form: POST every
    #     OAuth parameter in the body (OpenIddict extracts POST authorization requests from the
    #     form) plus decision=allow, with the session cookie. The loopback redirect is not followed.
    if grep -q 'aw_mcp_login' "$jar" 2>/dev/null; then
        do_request POST "$mcp_base/authorize" \
            -b "$jar" \
            -H 'content-type: application/x-www-form-urlencoded' \
            --data-urlencode "client_id=$OAUTH_CLIENT" \
            --data-urlencode "response_type=code" \
            --data-urlencode "redirect_uri=$OAUTH_REDIRECT" \
            --data-urlencode "scope=$scope_req" \
            --data-urlencode "state=$state" \
            --data-urlencode "code_challenge=$PKCE_CHALLENGE" \
            --data-urlencode "code_challenge_method=S256" \
            --data-urlencode "decision=allow"
        loc=$(header_value location)
        ret_state=$(printf '%s' "$loc" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')
        raw_code=$(printf '%s' "$loc" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
        [ -n "$raw_code" ] && auth_code=$(printf '%s' "$raw_code" | urldecode)
        if [ "$R_CODE" = "302" ] && printf '%s' "$loc" | grep -q "^$OAUTH_REDIRECT" \
            && [ -n "$auth_code" ] && [ "$ret_state" = "$state" ]; then
            pass "/authorize consent (PKCE S256) → authorization code issued"
        else
            fail "/authorize consent ($R_CODE)"
            diag "$mcp_base/authorize"
            note "expected: 302 to $OAUTH_REDIRECT with code= and the original state echoed back."
            note "location:   ${loc:-(none)}"
            note "state:      echoed=${ret_state:-(none)} want=$state"
        fi
    else
        fail "/authorize consent skipped (no session)"
        note "the login step above did not establish a session cookie."
    fi

    # (d) /token — exchange the code (+ PKCE verifier) for a short-lived access token.
    if [ -n "$auth_code" ]; then
        do_request POST "$mcp_base/token" \
            -H 'content-type: application/x-www-form-urlencoded' \
            --data-urlencode "grant_type=authorization_code" \
            --data-urlencode "code=$auth_code" \
            --data-urlencode "client_id=$OAUTH_CLIENT" \
            --data-urlencode "redirect_uri=$OAUTH_REDIRECT" \
            --data-urlencode "code_verifier=$PKCE_VERIFIER"
        if [ "$R_CODE" = "200" ]; then
            ACCESS_TOKEN=$(printf '%s' "$R_BODY_FULL" | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("access_token", ""))
except Exception:
    print("")' 2>/dev/null)
        fi
        if [ -n "$ACCESS_TOKEN" ]; then
            pass "/token → access token issued (authorization_code + PKCE verifier)"
        else
            fail "/token exchange ($R_CODE)"
            diag "$mcp_base/token"
            note "expected: 200 JSON with an access_token (public client, PKCE verifier)."
        fi
    else
        fail "/token exchange skipped (no authorization code)"
    fi

    # (e) Inspect the issued JWT's public claims. Short-lived, resource-bound, and carrying only
    #     non-sensitive identity/authorization claims — never passwords, hashes, PII or payments.
    if [ -n "$ACCESS_TOKEN" ]; then
        claims=$(printf '%s' "$ACCESS_TOKEN" | jwt_payload)
    fi
    if [ -n "$claims" ]; then
        out=$(printf '%s' "$claims" | PR_RESOURCE="$pr_resource" OAUTH_CLIENT="$OAUTH_CLIENT" python3 -c '
import sys, json, os
d = json.load(sys.stdin)

def aslist(v):
    return v if isinstance(v, list) else ([] if v is None else [v])

res = os.environ.get("PR_RESOURCE", "")
client = os.environ.get("OAUTH_CLIENT", "")
errs = []
if not d.get("sub"):
    errs.append("missing sub")
if d.get("category") != "employee":
    errs.append("category=%r (want employee)" % d.get("category"))
if d.get("app") != client:
    errs.append("app=%r (want %s)" % (d.get("app"), client))
roles = set(aslist(d.get("roles"))) | set(aslist(d.get("role")))
if "operations-admin" not in roles:
    errs.append("roles=%s (want operations-admin)" % sorted(roles))
if res:
    if res not in aslist(d.get("aud")):
        errs.append("aud=%r (want %s)" % (d.get("aud"), res))
elif not d.get("aud"):
    errs.append("missing aud")
print("; ".join(errs))
sys.exit(1 if errs else 0)' 2>&1)
        rc=$?
        if [ "$rc" -eq 0 ]; then
            pass "access token claims: sub + category=employee + operations-admin + aud=resource"
        else
            fail "access token claims (identity/role/audience)"
            [ -n "$out" ] && note "reason:     $out"
        fi

        out=$(printf '%s' "$claims" | python3 -c '
import sys, json
d = json.load(sys.stdin)
sc = d.get("scope")
scopes = set(sc.split()) if isinstance(sc, str) else set(sc or [])
errs = []
need = set("mcp.access products.read sales.read admin.read".split())
missing = need - scopes
if missing:
    errs.append("missing scopes %s" % sorted(missing))
forbidden = set(["manufacturing.read", "manufacturing.write", "admin.write", "mcp.admin"]) & scopes
if forbidden:
    errs.append("unexpected scopes %s (demo.admin is operations-admin)" % sorted(forbidden))
life = int(d.get("exp", 0)) - int(d.get("iat", 0))
if not (0 < life <= 1800):
    errs.append("lifetime %ss (want 0 < exp-iat <= 1800)" % life)
leak = [k for k in ("password", "pwd", "hash", "passwordhash", "credit_card", "card", "pan", "ssn") if k in d]
if leak:
    errs.append("sensitive claim(s) present: %s" % leak)
print("; ".join(errs))
sys.exit(1 if errs else 0)' 2>&1)
        rc=$?
        if [ "$rc" -eq 0 ]; then
            pass "access token claims: scopes granted, none out-of-role, short-lived, no secrets"
        else
            fail "access token claims (scopes/lifetime/no-secrets)"
            [ -n "$out" ] && note "reason:     $out"
        fi
    elif [ -n "$ACCESS_TOKEN" ]; then
        fail "access token claims not decodable"
        note "the access token payload could not be base64url-decoded as JSON."
    fi

    # (f) Authenticated MCP tool call the role PERMITS: get_business_stats needs sales.read
    #     (InternalOnly) — demo.admin (employee) qualifies — and returns seeded business data.
    if [ -n "$ACCESS_TOKEN" ]; then
        do_request POST "$mcp_base/mcp" \
            -H 'content-type: application/json' \
            -H 'accept: application/json, text/event-stream' \
            -H "authorization: Bearer $ACCESS_TOKEN" \
            --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_business_stats","arguments":{}}}'
        if [ "$R_CODE" = "200" ]; then
            msg=$(printf '%s' "$R_BODY_FULL" | mcp_unwrap)
            if [ -n "$msg" ]; then
                check_json "MCP get_business_stats (sales.read) → seeded data returned" "$msg" \
                    "'result' in d and not d['result'].get('isError', False) and len(d['result'].get('content') or []) > 0 and any((c.get('text') or '') != '' for c in d['result']['content'])"
            else
                fail "MCP get_business_stats (unparseable MCP response)"
                diag "$mcp_base/mcp"
                note "response body:"
                blk "$R_BODY"
            fi
        else
            fail "MCP get_business_stats ($R_CODE)"
            diag "$mcp_base/mcp"
            note "expected: 200 JSON-RPC result — demo.admin has mcp.access + sales.read."
        fi

        # (g) Authenticated MCP tool call the role DENIES: get_manufacturing_status needs
        #     manufacturing.read, which operations-admin lacks. Tool-level authorization returns a
        #     JSON-RPC result with isError=true (a safe refusal) — not the data, and not a 500.
        do_request POST "$mcp_base/mcp" \
            -H 'content-type: application/json' \
            -H 'accept: application/json, text/event-stream' \
            -H "authorization: Bearer $ACCESS_TOKEN" \
            --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_manufacturing_status","arguments":{}}}'
        msg=$(printf '%s' "$R_BODY_FULL" | mcp_unwrap)
        if [ "$R_CODE" = "200" ] && [ -n "$msg" ] && printf '%s' "$msg" | python3 -c 'import sys, json
d = json.load(sys.stdin)
r = d.get("result") or {}
sys.exit(0 if r.get("isError") is True else 1)' 2>/dev/null; then
            pass "MCP get_manufacturing_status → denied by tool-level authz (isError)"
        else
            fail "MCP get_manufacturing_status denial (code=$R_CODE)"
            diag "$mcp_base/mcp"
            note "expected: 200 JSON-RPC result with isError=true — operations-admin lacks"
            note "          manufacturing.read, so the tool must be refused, not executed."
            [ -n "$msg" ] && { note "mcp message:"; blk "$(printf '%s' "$msg" | head -c "$BODY_MAX")"; }
        fi
    else
        fail "MCP authenticated tool calls skipped (no access token)"
        note "the token steps above must succeed first; these checks require the demo.admin token."
    fi
    rm -f "$jar"
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
echo "=== AI Agent Endpoints ==="
# 'Generate Promotion with AI' and 'Help Me Choose' are ANONYMOUS Azure Functions (no OAuth)
# whose backends authenticate to Azure OpenAI and Azure SQL via MANAGED IDENTITY. "Auth
# correctly" here means those managed-identity backends SUCCEED (HTTP 200) rather than failing
# (500) on a token/role error. catalog-meta exercises the SQL path (fast, deterministic) and
# GeneratePromotion exercises the Azure OpenAI agent path (a real model call — allow more time).
if [ -z "$func" ]; then
    fail "AI agent endpoints skipped"
    note "API_FUNCTIONS_URL is empty — cannot reach the Functions app."
else
    # (a) Help Me Choose catalog meta — SQL via managed identity (no AI). 200 proves DB auth.
    url="$func/api/helpme/catalog-meta"
    do_request GET "$url"
    if [ "$R_CODE" = "200" ]; then
        check_json "Help Me Choose catalog-meta (SQL via managed identity)" "$R_BODY_FULL" \
            "isinstance(d.get('colors'), list) and isinstance(d.get('bikeSizes'), list)"
    else
        fail "Help Me Choose catalog-meta ($R_CODE)"
        diag "$url"
        note "expected: 200 {colors:[...], bikeSizes:[...]}. A 500 here means the SQL managed-"
        note "          identity connection failed (check the Functions MI + SQL role grants)."
    fi

    # (b) Help Me Choose questions — Foundry agent path; returns 200 with a sessionId + questions.
    #     The handler degrades to static fallback questions if the model is unreachable, so this
    #     primarily proves the endpoint + serialization; catalog-meta / GeneratePromotion are the
    #     definitive managed-identity backend checks.
    url="$func/api/helpme/questions"
    do_request POST "$url" -H 'content-type: application/json' --data '{}'
    if [ "$R_CODE" = "200" ]; then
        check_json "Help Me Choose questions → sessionId + questions[]" "$R_BODY_FULL" \
            "bool(d.get('sessionId')) and isinstance(d.get('questions'), list) and len(d.get('questions') or []) > 0"
    else
        fail "Help Me Choose questions ($R_CODE)"
        diag "$url"
    fi

    # (c) Generate Promotion with AI — Azure OpenAI agent via managed identity. The service
    #     rethrows on failure, so 200 with a non-empty suggestion proves the model call authed.
    #     Allow extra time (SMOKE_AI_TIMEOUT) for the multi-step agent turn.
    url="$func/api/GeneratePromotion"
    _saved_timeout="$TIMEOUT"
    TIMEOUT="$AI_TIMEOUT"
    do_request POST "$url" -H 'content-type: application/json' \
        --data '{"PromotionType":"percentage","OfferCategory":"Customer"}'
    TIMEOUT="$_saved_timeout"
    if [ "$R_CODE" = "200" ]; then
        check_json "Generate Promotion with AI → suggestion (Azure OpenAI via managed identity)" "$R_BODY_FULL" \
            "bool(d.get('suggestion')) and len(str(d.get('suggestion'))) > 0"
    else
        fail "Generate Promotion with AI ($R_CODE)"
        diag "$url"
        note "expected: 200 {suggestion, threadId}. A 500 here means the Azure OpenAI managed-"
        note "          identity call failed (check the Functions MI role on the OpenAI account)."
    fi
fi

echo
echo "=== Summary ==="
printf "  %d passed, %d failed\n" "$passes" "$fails"
if [ "$fails" -ne 0 ]; then
    echo "  Re-run after addressing the diagnostics above. Tunables: SMOKE_TIMEOUT,"
    echo "  SMOKE_CONNECT_TIMEOUT, SMOKE_RETRIES, SMOKE_RETRY_DELAY, SMOKE_BODY_MAX,"
    echo "  SMOKE_PARSE_MAX, SMOKE_AI_TIMEOUT, SMOKE_DEMO_USER, SMOKE_DEMO_PASS."
    exit 1
fi
exit 0
