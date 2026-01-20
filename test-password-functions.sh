#!/bin/bash

# Test script for password hashing functions
# Usage: ./test-password-functions.sh [function-url]

# Get the function URL from argument, azd env, or fail
if [ -n "$1" ]; then
    FUNCTION_URL="$1"
else
    # Get from azd environment
    FUNCTION_URL=$(azd env get-values | grep "^API_FUNCTIONS_URL=" | cut -d'=' -f2 | tr -d '"')
    
    if [ -z "$FUNCTION_URL" ]; then
        echo "Error: Could not determine Function URL"
        echo "Either provide URL as argument or run 'azd up' to set up Azure environment"
        echo "Usage: ./test-password-functions.sh [function-url]"
        exit 1
    fi
fi

echo "========================================="
echo "Testing Password Functions"
echo "========================================="
echo "Function URL: $FUNCTION_URL"
echo ""

# Test data
BUSINESS_ENTITY_ID=1
TEST_PASSWORD="TestPassword123!"
WRONG_PASSWORD="WrongPassword456!"

echo "1. Setting password for BusinessEntityID $BUSINESS_ENTITY_ID..."
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password"
SET_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$TEST_PASSWORD\"
  }")

HTTP_CODE=$(echo "$SET_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$SET_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

# Check if set was successful
if echo "$RESPONSE_BODY" | grep -q "successfully set"; then
    echo "✓ Password set successfully"
else
    echo "✗ Failed to set password"
    echo "Expected: Response containing 'successfully set'"
    echo "Got: $RESPONSE_BODY"
    echo "HTTP Status Code: $HTTP_CODE"
    exit 1
fi

echo ""
echo "2. Verifying correct password..."
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password/verify"
VERIFY_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$TEST_PASSWORD\"
  }")

HTTP_CODE=$(echo "$VERIFY_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$VERIFY_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

# Check if verification was successful
if echo "$RESPONSE_BODY" | grep -q '"isValid":true'; then
    echo "✓ Password verification successful (correct password)"
else
    echo "✗ Password verification failed (should have succeeded)"
    echo "Expected: Response containing '\"isValid\":true'"
    echo "Got: $RESPONSE_BODY"
    echo "HTTP Status Code: $HTTP_CODE"
    exit 1
fi

echo ""
echo "3. Verifying wrong password..."
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password/verify"
VERIFY_WRONG_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$WRONG_PASSWORD\"
  }")

HTTP_CODE=$(echo "$VERIFY_WRONG_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$VERIFY_WRONG_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

# Check if verification correctly failed
if echo "$RESPONSE_BODY" | grep -q '"isValid":false'; then
    echo "✓ Password verification correctly rejected wrong password"
else
    echo "✗ Password verification should have failed"
    echo "Expected: Response containing '\"isValid\":false'"
    echo "Got: $RESPONSE_BODY"
    echo "HTTP Status Code: $HTTP_CODE"
    exit 1
fi

echo ""
echo "4. Testing password update (changing password)..."
echo "-------------------------------------------"
NEW_PASSWORD="NewPassword789!"
echo "Request: POST ${FUNCTION_URL}/api/password (update)"
UPDATE_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$NEW_PASSWORD\"
  }")

HTTP_CODE=$(echo "$UPDATE_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$UPDATE_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

# Verify old password no longer works
VERIFY_OLD_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$TEST_PASSWORD\"
  }")

OLD_HTTP_CODE=$(echo "$VERIFY_OLD_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
OLD_RESPONSE_BODY=$(echo "$VERIFY_OLD_RESPONSE" | sed '/HTTP_CODE:/d')

if echo "$OLD_RESPONSE_BODY" | grep -q '"isValid":false'; then
    echo "✓ Old password correctly rejected after update"
else
    echo "✗ Old password should not work after update"
    echo "Expected: Response containing '\"isValid\":false'"
    echo "Got: $OLD_RESPONSE_BODY"
    echo "HTTP Status Code: $OLD_HTTP_CODE"
    exit 1
fi

# Verify new password works
VERIFY_NEW_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$NEW_PASSWORD\"
  }")

NEW_HTTP_CODE=$(echo "$VERIFY_NEW_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
NEW_RESPONSE_BODY=$(echo "$VERIFY_NEW_RESPONSE" | sed '/HTTP_CODE:/d')

if echo "$NEW_RESPONSE_BODY" | grep -q '"isValid":true'; then
    echo "✓ New password works after update"
else
    echo "✗ New password should work after update"
    echo "Expected: Response containing '\"isValid\":true'"
    echo "Got: $NEW_RESPONSE_BODY"
    echo "HTTP Status Code: $NEW_HTTP_CODE"
    exit 1
fi

echo ""
echo "5. Testing validation (password too short)..."
echo "-------------------------------------------"
echo "Request: POST ${FUNCTION_URL}/api/password (short password)"
SHORT_PASSWORD_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "${FUNCTION_URL}/api/password" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"short\"
  }")

HTTP_CODE=$(echo "$SHORT_PASSWORD_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$SHORT_PASSWORD_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
echo ""

if echo "$RESPONSE_BODY" | grep -q "at least 8 characters"; then
    echo "✓ Validation correctly rejected short password"
else
    echo "✗ Should have rejected password that's too short"
    echo "Expected: Response containing 'at least 8 characters'"
    echo "Got: $RESPONSE_BODY"
    echo "HTTP Status Code: $HTTP_CODE"
    exit 1
fi

echo ""
echo "========================================="
echo "All tests passed! ✓"
echo "========================================="
