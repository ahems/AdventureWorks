#!/usr/bin/env bash
set -u

mcp=$(azd env get-value API_MCP_URL)
mcp_base=${mcp%/mcp}

api=$(azd env get-value API_URL)
func=$(azd env get-value API_FUNCTIONS_URL)
app=$(azd env get-value APP_URL)
admin=$(azd env get-value APP_ADMIN_URL)
mfg=$(azd env get-value APP_MANUFACTURING_URL)
insp=$(azd env get-value MCP_INSPECTOR_URL)

P() {
    printf "%-52s %s\n" "$2" "$1"
}

code() {
    curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null
}

echo
echo "=== MCP OAuth Discovery ==="

# 1) MCP OAuth discovery (RFC 9728 / RFC 8414) + JWKS
c=$(code "$mcp_base/.well-known/oauth-protected-resource")
[ "$c" = "200" ] \
    && P PASS "protected-resource metadata ($c)" \
    || P FAIL "protected-resource metadata ($c)"

c=$(code "$mcp_base/.well-known/openid-configuration")
[ "$c" = "200" ] \
    && P PASS "authz-server metadata ($c)" \
    || P FAIL "authz-server metadata ($c)"

jwks=$(
    curl -sS --max-time 20 \
        "$mcp_base/.well-known/openid-configuration" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("jwks_uri",""))' \
    2>/dev/null
)

if [ -n "$jwks" ]; then
    c=$(code "$jwks")
    [ "$c" = "200" ] \
        && P PASS "JWKS reachable ($c)" \
        || P FAIL "JWKS ($c) uri=$jwks"
else
    P FAIL "JWKS URI missing from OIDC metadata"
fi

echo
echo "=== MCP Challenge ==="

# 2) MCP must challenge unauthenticated calls
hdr=$(curl -sS -D- -o /dev/null --max-time 20 "$mcp_base/mcp")
st=$(printf '%s' "$hdr" | head -1)

echo "$hdr" | grep -qi 'WWW-Authenticate:.*resource_metadata' \
    && P PASS "/mcp 401 challenge ($st)" \
    || P FAIL "/mcp challenge ($st)"

echo
echo "=== Application Endpoints ==="

# 3) DAB GraphQL
c=$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 20 \
    -X POST "$api" \
    -H 'content-type: application/json' \
    --data '{"query":"{ __typename }"}')

[ "$c" = "200" ] \
    && P PASS "GraphQL API ($c)" \
    || P FAIL "GraphQL API ($c)"

# 4) Functions health
c=$(code "$func/api/health")

[ "$c" = "200" ] \
    && P PASS "Functions /api/health ($c)" \
    || P FAIL "Functions health ($c)"

# 5) Frontends
for u in \
    "$app:e-shop" \
    "$admin:admin" \
    "$mfg:manufacturing" \
    "$insp:mcp-inspector"
do
    c=$(code "${u%%:*}")

    [ "$c" = "200" ] \
        && P PASS "frontend ${u##*:} ($c)" \
        || P FAIL "frontend ${u##*:} ($c)"
done
