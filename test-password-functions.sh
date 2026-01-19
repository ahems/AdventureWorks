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
SET_RESPONSE=$(curl -s -X POST "${FUNCTION_URL}/api/password" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$TEST_PASSWORD\"
  }")

echo "Response: $SET_RESPONSE"
echo ""

# Check if set was successful
if echo "$SET_RESPONSE" | grep -q "successfully set"; then
    echo "✓ Password set successfully"
else
    echo "✗ Failed to set password"
    exit 1
fi

echo ""
echo "2. Verifying correct password..."
echo "-------------------------------------------"
VERIFY_RESPONSE=$(curl -s -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$TEST_PASSWORD\"
  }")

echo "Response: $VERIFY_RESPONSE"
echo ""

# Check if verification was successful
if echo "$VERIFY_RESPONSE" | grep -q '"isValid":true'; then
    echo "✓ Password verification successful (correct password)"
else
    echo "✗ Password verification failed (should have succeeded)"
    exit 1
fi

echo ""
echo "3. Verifying wrong password..."
echo "-------------------------------------------"
VERIFY_WRONG_RESPONSE=$(curl -s -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$WRONG_PASSWORD\"
  }")

echo "Response: $VERIFY_WRONG_RESPONSE"
echo ""

# Check if verification correctly failed
if echo "$VERIFY_WRONG_RESPONSE" | grep -q '"isValid":false'; then
    echo "✓ Password verification correctly rejected wrong password"
else
    echo "✗ Password verification should have failed"
    exit 1
fi

echo ""
echo "4. Testing password update (changing password)..."
echo "-------------------------------------------"
NEW_PASSWORD="NewPassword789!"
UPDATE_RESPONSE=$(curl -s -X POST "${FUNCTION_URL}/api/password" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$NEW_PASSWORD\"
  }")

echo "Response: $UPDATE_RESPONSE"
echo ""

# Verify old password no longer works
VERIFY_OLD_RESPONSE=$(curl -s -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$TEST_PASSWORD\"
  }")

if echo "$VERIFY_OLD_RESPONSE" | grep -q '"isValid":false'; then
    echo "✓ Old password correctly rejected after update"
else
    echo "✗ Old password should not work after update"
    exit 1
fi

# Verify new password works
VERIFY_NEW_RESPONSE=$(curl -s -X POST "${FUNCTION_URL}/api/password/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"$NEW_PASSWORD\"
  }")

if echo "$VERIFY_NEW_RESPONSE" | grep -q '"isValid":true'; then
    echo "✓ New password works after update"
else
    echo "✗ New password should work after update"
    exit 1
fi

echo ""
echo "5. Testing validation (password too short)..."
echo "-------------------------------------------"
SHORT_PASSWORD_RESPONSE=$(curl -s -X POST "${FUNCTION_URL}/api/password" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessEntityID\": $BUSINESS_ENTITY_ID,
    \"password\": \"short\"
  }")

echo "Response: $SHORT_PASSWORD_RESPONSE"
echo ""

if echo "$SHORT_PASSWORD_RESPONSE" | grep -q "at least 8 characters"; then
    echo "✓ Validation correctly rejected short password"
else
    echo "✗ Should have rejected password that's too short"
    exit 1
fi

echo ""
echo "========================================="
echo "All tests passed! ✓"
echo "========================================="
