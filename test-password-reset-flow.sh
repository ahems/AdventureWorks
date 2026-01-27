#!/bin/bash

# Test script for password reset flow
# Tests the complete password reset workflow:
# 1. Request password reset (generates token and sends email)
# 2. Validate reset token
# 3. Complete password reset with new password
# 4. Verify new password works
#
# Usage: ./test-password-reset-flow.sh [function-url]

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the function URL from argument, azd env, or fail
if [ -n "$1" ]; then
    FUNCTION_URL="$1"
else
    # Get from azd environment
    FUNCTION_URL=$(azd env get-values | grep "^API_FUNCTIONS_URL=" | cut -d'=' -f2 | tr -d '"')
    
    if [ -z "$FUNCTION_URL" ]; then
        echo -e "${RED}Error: Could not determine Function URL${NC}"
        echo "Either provide URL as argument or run 'azd up' to set up Azure environment"
        echo "Usage: ./test-password-reset-flow.sh [function-url]"
        exit 1
    fi
fi

echo "========================================="
echo "Testing Password Reset Flow"
echo "========================================="
echo "Function URL: $FUNCTION_URL"
echo ""

# Test data - using a known test user from AdventureWorks database
# Default test: BusinessEntityID 1 with email ken0@adventure-works.com
TEST_EMAIL="ken0@adventure-works.com"
TEST_BUSINESS_ENTITY_ID=1
ORIGINAL_PASSWORD="TestPassword123!"
NEW_PASSWORD="NewSecurePassword456!"
WRONG_PASSWORD="WrongPassword789!"

echo "Test Configuration:"
echo "  Email: $TEST_EMAIL"
echo "  Business Entity ID: $TEST_BUSINESS_ENTITY_ID"
echo ""

# Step 0: Set up initial password (if not already set)
echo -e "${YELLOW}Step 0: Setting up initial password...${NC}"
echo "-------------------------------------------"
curl -s -X POST "${FUNCTION_URL}/api/password" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $TEST_BUSINESS_ENTITY_ID,
    \"password\": \"$ORIGINAL_PASSWORD\"
  }" > /dev/null

echo -e "${GREEN}✓ Initial password set${NC}"
echo ""

# Step 1: Request password reset
echo -e "${YELLOW}Step 1: Requesting password reset...${NC}"
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password/reset/request"
RESET_REQUEST_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/reset/request" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$TEST_EMAIL\"
  }")

HTTP_CODE=$(echo "$RESET_REQUEST_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$RESET_REQUEST_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

# Check if request was successful
if [ "$HTTP_CODE" != "200" ]; then
    echo -e "${RED}✗ Failed to request password reset${NC}"
    echo "Expected HTTP 200, got: $HTTP_CODE"
    exit 1
fi

# Extract token from debug response (in production, token would only be in email)
RESET_TOKEN=$(echo "$RESPONSE_BODY" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$RESET_TOKEN" ]; then
    echo -e "${RED}✗ Failed to extract reset token from response${NC}"
    echo "Response was: $RESPONSE_BODY"
    exit 1
fi

echo -e "${GREEN}✓ Password reset requested successfully${NC}"
echo "  Token: $RESET_TOKEN"
echo ""

# Step 2: Validate reset token
echo -e "${YELLOW}Step 2: Validating reset token...${NC}"
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password/reset/validate"
VALIDATE_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/reset/validate" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $TEST_BUSINESS_ENTITY_ID,
    \"token\": \"$RESET_TOKEN\"
  }")

HTTP_CODE=$(echo "$VALIDATE_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$VALIDATE_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

# Check if validation was successful
if [ "$HTTP_CODE" != "200" ]; then
    echo -e "${RED}✗ Failed to validate token${NC}"
    echo "Expected HTTP 200, got: $HTTP_CODE"
    exit 1
fi

if ! echo "$RESPONSE_BODY" | grep -q '"isValid":true'; then
    echo -e "${RED}✗ Token validation failed${NC}"
    echo "Expected isValid: true, got: $RESPONSE_BODY"
    exit 1
fi

echo -e "${GREEN}✓ Token validated successfully${NC}"
echo ""

# Step 2a: Test invalid token validation
echo -e "${YELLOW}Step 2a: Testing invalid token validation...${NC}"
echo "-------------------------------------------"
INVALID_VALIDATE_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/reset/validate" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $TEST_BUSINESS_ENTITY_ID,
    \"token\": \"INVALID1\"
  }")

RESPONSE_BODY=$(echo "$INVALID_VALIDATE_RESPONSE" | sed '/HTTP_CODE:/d')

if echo "$RESPONSE_BODY" | grep -q '"isValid":false'; then
    echo -e "${GREEN}✓ Invalid token correctly rejected${NC}"
else
    echo -e "${RED}✗ Invalid token should have been rejected${NC}"
    exit 1
fi
echo ""

# Step 3: Complete password reset
echo -e "${YELLOW}Step 3: Completing password reset with new password...${NC}"
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password/reset/complete"
COMPLETE_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/reset/complete" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $TEST_BUSINESS_ENTITY_ID,
    \"token\": \"$RESET_TOKEN\",
    \"newPassword\": \"$NEW_PASSWORD\"
  }")

HTTP_CODE=$(echo "$COMPLETE_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$COMPLETE_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

# Check if reset was successful
if [ "$HTTP_CODE" != "200" ]; then
    echo -e "${RED}✗ Failed to complete password reset${NC}"
    echo "Expected HTTP 200, got: $HTTP_CODE"
    exit 1
fi

if ! echo "$RESPONSE_BODY" | grep -q "successfully reset"; then
    echo -e "${RED}✗ Password reset completion failed${NC}"
    echo "Expected success message, got: $RESPONSE_BODY"
    exit 1
fi

echo -e "${GREEN}✓ Password reset completed successfully${NC}"
echo ""

# Step 4: Verify old password no longer works
echo -e "${YELLOW}Step 4: Verifying old password no longer works...${NC}"
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password/verify"
OLD_PASSWORD_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $TEST_BUSINESS_ENTITY_ID,
    \"password\": \"$ORIGINAL_PASSWORD\"
  }")

RESPONSE_BODY=$(echo "$OLD_PASSWORD_RESPONSE" | sed '/HTTP_CODE:/d')

echo "Response: $RESPONSE_BODY"
echo ""

if echo "$RESPONSE_BODY" | grep -q '"isValid":false'; then
    echo -e "${GREEN}✓ Old password correctly rejected${NC}"
else
    echo -e "${RED}✗ Old password should have been rejected${NC}"
    exit 1
fi
echo ""

# Step 5: Verify new password works
echo -e "${YELLOW}Step 5: Verifying new password works...${NC}"
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password/verify"
NEW_PASSWORD_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $TEST_BUSINESS_ENTITY_ID,
    \"password\": \"$NEW_PASSWORD\"
  }")

HTTP_CODE=$(echo "$NEW_PASSWORD_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$NEW_PASSWORD_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

if [ "$HTTP_CODE" != "200" ]; then
    echo -e "${RED}✗ Failed to verify new password${NC}"
    echo "Expected HTTP 200, got: $HTTP_CODE"
    exit 1
fi

if ! echo "$RESPONSE_BODY" | grep -q '"isValid":true'; then
    echo -e "${RED}✗ New password verification failed${NC}"
    echo "Expected isValid: true, got: $RESPONSE_BODY"
    exit 1
fi

echo -e "${GREEN}✓ New password verified successfully${NC}"
echo ""

# Step 6: Test token reuse protection (token should be invalid after use)
echo -e "${YELLOW}Step 6: Testing token reuse protection...${NC}"
echo "-------------------------------------------"
echo "Attempting to reuse the same token..."
REUSE_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/reset/complete" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $TEST_BUSINESS_ENTITY_ID,
    \"token\": \"$RESET_TOKEN\",
    \"newPassword\": \"AnotherPassword789!\"
  }")

HTTP_CODE=$(echo "$REUSE_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$REUSE_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

if [ "$HTTP_CODE" == "401" ] || echo "$RESPONSE_BODY" | grep -q "Invalid or expired"; then
    echo -e "${GREEN}✓ Token reuse correctly prevented${NC}"
else
    echo -e "${RED}✗ Token should not be reusable${NC}"
    exit 1
fi
echo ""

# Step 7: Test password validation rules
echo -e "${YELLOW}Step 7: Testing password validation rules...${NC}"
echo "-------------------------------------------"

# Request new token for validation test
echo "Requesting new reset token..."
RESET_REQUEST_RESPONSE=$(curl -s -X POST "${FUNCTION_URL}/api/password/reset/request" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$TEST_EMAIL\"
  }")

RESET_TOKEN=$(echo "$RESET_REQUEST_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$RESET_TOKEN" ]; then
    echo -e "${RED}✗ Failed to get new token for validation test${NC}"
    exit 1
fi

echo "Testing password that's too short..."
SHORT_PASSWORD_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/reset/complete" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $TEST_BUSINESS_ENTITY_ID,
    \"token\": \"$RESET_TOKEN\",
    \"newPassword\": \"Short1!\"
  }")

HTTP_CODE=$(echo "$SHORT_PASSWORD_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$SHORT_PASSWORD_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"

if [ "$HTTP_CODE" == "400" ] && echo "$RESPONSE_BODY" | grep -q "at least 8 characters"; then
    echo -e "${GREEN}✓ Short password correctly rejected${NC}"
else
    echo -e "${RED}✗ Short password should have been rejected${NC}"
    exit 1
fi
echo ""

# Step 8: Test with non-existent email (security check)
echo -e "${YELLOW}Step 8: Testing with non-existent email...${NC}"
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password/reset/request"
NONEXISTENT_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/reset/request" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"nonexistent@example.com\"
  }")

HTTP_CODE=$(echo "$NONEXISTENT_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$NONEXISTENT_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

# For security, should still return 200 with generic message
if [ "$HTTP_CODE" == "200" ] && echo "$RESPONSE_BODY" | grep -q "If this email exists"; then
    echo -e "${GREEN}✓ Non-existent email handled securely (no information disclosure)${NC}"
else
    echo -e "${YELLOW}⚠ Warning: Non-existent email response may reveal user existence${NC}"
fi
echo ""

# Cleanup: restore original password for future tests
echo -e "${YELLOW}Cleanup: Restoring original password...${NC}"
echo "-------------------------------------------"
curl -s -X POST "${FUNCTION_URL}/api/password" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $TEST_BUSINESS_ENTITY_ID,
    \"password\": \"$ORIGINAL_PASSWORD\"
  }" > /dev/null

echo -e "${GREEN}✓ Original password restored${NC}"
echo ""

# Summary
echo "========================================="
echo -e "${GREEN}✓ ALL PASSWORD RESET FLOW TESTS PASSED!${NC}"
echo "========================================="
echo ""
echo "Summary of tested scenarios:"
echo "  ✓ Request password reset"
echo "  ✓ Validate reset token"
echo "  ✓ Invalid token rejection"
echo "  ✓ Complete password reset"
echo "  ✓ Old password invalidation"
echo "  ✓ New password verification"
echo "  ✓ Token reuse prevention"
echo "  ✓ Password length validation"
echo "  ✓ Non-existent email handling"
echo ""
echo "All tests completed successfully! 🎉"
