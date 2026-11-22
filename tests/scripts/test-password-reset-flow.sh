#!/bin/bash

# Password reset flow checks against the deployed Functions app.
#
# The reset token is only ever delivered by email (the request endpoint always answers
# 202 with a generic message), so the script runs in two phases:
#
#   1. Always: request a reset for TEST_EMAIL and for an unknown address and check both get
#      the same generic 202 with no token or link; check that a made-up token is rejected
#      by validate and complete; check the request validation.
#   2. Only when RESET_TOKEN is set: validate the emailed token, optionally confirm the
#      current password still works before completion (needs FUNCTIONS_TOKEN and
#      CURRENT_PASSWORD), complete the reset, confirm the token cannot be reused and, with
#      FUNCTIONS_TOKEN, confirm the new password verifies.
#
# Phase 2 needs a disposable storefront consumer (PersonType IN) whose address can receive
# mail. Reserved test domains such as @example.invalid are suppressed by the email service,
# so they never receive a link. Copy the token from the emailed
# {APP_URL}/reset-password?token=...&id=... link. Never use the canned admin or
# manufacturing logins.
#
# Usage:
#   TEST_EMAIL=<email> TEST_BUSINESS_ENTITY_ID=<id> \
#     [RESET_TOKEN=<token from email>] [NEW_PASSWORD=<new password>] \
#     [FUNCTIONS_TOKEN=<consumer Functions token>] [CURRENT_PASSWORD=<current password>] \
#     ./test-password-reset-flow.sh [function-url]

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -n "${1:-}" ]; then
    FUNCTION_URL="$1"
else
    FUNCTION_URL=$(azd env get-value API_FUNCTIONS_URL --no-prompt 2>/dev/null || true)
    if [ -z "$FUNCTION_URL" ]; then
        echo -e "${RED}Error: Could not determine Function URL${NC}"
        echo "Usage: ./test-password-reset-flow.sh [function-url]"
        exit 1
    fi
fi
FUNCTION_URL="${FUNCTION_URL%/}"

if [ -z "${TEST_EMAIL:-}" ] || [ -z "${TEST_BUSINESS_ENTITY_ID:-}" ]; then
    echo "Error: set TEST_EMAIL and TEST_BUSINESS_ENTITY_ID for a disposable storefront consumer"
    exit 1
fi

fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
pass() { echo -e "${GREEN}✓ $1${NC}"; }

# post PATH JSON [extra curl args...] -> sets HTTP_CODE and RESPONSE_BODY
post() {
    local path=$1 data=$2
    shift 2
    local raw
    raw=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}${path}" \
        -H "Content-Type: application/json" "$@" -d "$data")
    HTTP_CODE=$(echo "$raw" | grep "HTTP_CODE:" | cut -d':' -f2)
    RESPONSE_BODY=$(echo "$raw" | sed '/HTTP_CODE:/d')
}

json() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

echo "========================================="
echo "Testing Password Reset Flow"
echo "========================================="
echo "Function URL: $FUNCTION_URL"
echo "Business Entity ID: $TEST_BUSINESS_ENTITY_ID"
echo ""

echo -e "${YELLOW}Phase 1: generic request responses and token rejection${NC}"

post /api/password/reset/request "{\"email\": $(json "$TEST_EMAIL")}"
[ "$HTTP_CODE" == "202" ] || fail "Reset request: expected HTTP 202, got $HTTP_CODE"
KNOWN_BODY=$RESPONSE_BODY
if echo "$KNOWN_BODY" | grep -qiE '"(token|resetUrl|debug)"'; then
    fail "Reset request response must not contain a token or reset link"
fi
pass "Reset request returns 202 with no token or link"

post /api/password/reset/request '{"email": "nonexistent-reset-check@example.invalid"}'
[ "$HTTP_CODE" == "202" ] || fail "Unknown email: expected HTTP 202, got $HTTP_CODE"
[ "$RESPONSE_BODY" == "$KNOWN_BODY" ] || fail "Unknown email response differs from a known email response"
pass "Unknown email gets the identical generic response"

post /api/password/reset/request '{}'
[ "$HTTP_CODE" == "400" ] || fail "Missing email: expected HTTP 400, got $HTTP_CODE"
pass "Missing email rejected"

post /api/password/reset/validate "{\"businessEntityID\": $TEST_BUSINESS_ENTITY_ID, \"token\": \"INVALID-reset-token\"}"
echo "$RESPONSE_BODY" | grep -q '"isValid":false' || fail "Made-up token should not validate"
pass "Made-up token fails validation"

post /api/password/reset/complete "{\"businessEntityID\": $TEST_BUSINESS_ENTITY_ID, \"token\": \"INVALID-reset-token\", \"newPassword\": \"NotApplied123!\"}"
[ "$HTTP_CODE" == "401" ] || fail "Made-up token completion: expected HTTP 401, got $HTTP_CODE"
pass "Made-up token cannot complete a reset"

post /api/password/reset/complete "{\"businessEntityID\": $TEST_BUSINESS_ENTITY_ID, \"token\": \"INVALID-reset-token\", \"newPassword\": \"Short1!\"}"
[ "$HTTP_CODE" == "400" ] && echo "$RESPONSE_BODY" | grep -q "at least 8 characters" \
    || fail "Short password: expected HTTP 400"
pass "Short password rejected"
echo ""

if [ -z "${RESET_TOKEN:-}" ]; then
    echo -e "${YELLOW}Phase 2 skipped: set RESET_TOKEN to the token from the emailed link to test completion.${NC}"
    echo -e "${GREEN}Phase 1 passed.${NC}"
    exit 0
fi

echo -e "${YELLOW}Phase 2: complete the reset with the emailed token${NC}"
NEW_PASSWORD=${NEW_PASSWORD:-NewSecurePassword456!}

post /api/password/reset/validate "{\"businessEntityID\": $TEST_BUSINESS_ENTITY_ID, \"token\": $(json "$RESET_TOKEN")}"
echo "$RESPONSE_BODY" | grep -q '"isValid":true' || fail "Emailed token should validate (use the latest email; tokens expire after 1 hour)"
pass "Emailed token validates"

verify_password() {
    post /api/password/verify "{\"businessEntityID\": $TEST_BUSINESS_ENTITY_ID, \"password\": $(json "$1")}" \
        -H "Authorization: Bearer $FUNCTIONS_TOKEN"
    echo "$RESPONSE_BODY" | grep -q "\"isValid\":$2"
}

if [ -n "${FUNCTIONS_TOKEN:-}" ] && [ -n "${CURRENT_PASSWORD:-}" ]; then
    verify_password "$CURRENT_PASSWORD" true || fail "Current password must keep working until the reset completes"
    pass "Current password still works before completion"
fi

post /api/password/reset/complete "{\"businessEntityID\": $TEST_BUSINESS_ENTITY_ID, \"token\": $(json "$RESET_TOKEN"), \"newPassword\": $(json "$NEW_PASSWORD")}"
[ "$HTTP_CODE" == "200" ] || fail "Completion: expected HTTP 200, got $HTTP_CODE"
pass "Reset completed"

post /api/password/reset/complete "{\"businessEntityID\": $TEST_BUSINESS_ENTITY_ID, \"token\": $(json "$RESET_TOKEN"), \"newPassword\": \"AnotherPassword789!\"}"
[ "$HTTP_CODE" == "401" ] || fail "Token reuse: expected HTTP 401, got $HTTP_CODE"
pass "Token cannot be reused"

if [ -n "${FUNCTIONS_TOKEN:-}" ]; then
    verify_password "$NEW_PASSWORD" true || fail "New password should verify"
    pass "New password verifies"
    if [ -n "${CURRENT_PASSWORD:-}" ]; then
        verify_password "$CURRENT_PASSWORD" false || fail "Old password should no longer verify"
        pass "Old password rejected"
    fi
fi

echo ""
echo -e "${GREEN}All password reset checks passed.${NC}"
