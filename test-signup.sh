#!/bin/bash

# Test script to debug signup flow
API_URL="https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql"

echo "=== Testing Signup Flow ==="
echo ""

# Test data
BUSINESS_ENTITY_ID=99999
EMAIL="test-$(date +%s)@example.com"
FIRST_NAME="Test"
LAST_NAME="User"
PASSWORD_HASH="dGVzdGhhc2g="
PASSWORD_SALT="dGVzdHNhbHQ="

echo "Step 1: Create BusinessEntity"
echo "----------------------------"
# Generate UUID in bash (no uuidgen needed)
UUID=$(cat /proc/sys/kernel/random/uuid)
MODIFIED_DATE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

BUSINESS_ENTITY_RESULT=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation { createBusinessEntity(item: { rowguid: \\\"$UUID\\\", ModifiedDate: \\\"$MODIFIED_DATE\\\" }) { BusinessEntityID rowguid ModifiedDate } }\"
  }")

echo "$BUSINESS_ENTITY_RESULT" | jq '.'
BUSINESS_ENTITY_ID=$(echo "$BUSINESS_ENTITY_RESULT" | jq -r '.data.createBusinessEntity.BusinessEntityID')
echo "Created BusinessEntityID: $BUSINESS_ENTITY_ID"
echo ""

if [ "$BUSINESS_ENTITY_ID" = "null" ] || [ -z "$BUSINESS_ENTITY_ID" ]; then
  echo "❌ Failed to create BusinessEntity"
  exit 1
fi

echo "Step 2: Create Person"
echo "----------------------------"
UUID2=$(cat /proc/sys/kernel/random/uuid)
MODIFIED_DATE2=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

PERSON_RESULT=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation { createPerson(item: { BusinessEntityID: $BUSINESS_ENTITY_ID, PersonType: \\\"IN\\\", FirstName: \\\"$FIRST_NAME\\\", LastName: \\\"$LAST_NAME\\\", NameStyle: false, EmailPromotion: 0, rowguid: \\\"$UUID2\\\", ModifiedDate: \\\"$MODIFIED_DATE2\\\" }) { BusinessEntityID FirstName LastName } }\"
  }")

echo "$PERSON_RESULT" | jq '.'
echo ""

if echo "$PERSON_RESULT" | jq -e '.errors' > /dev/null; then
  echo "❌ Failed to create Person"
  exit 1
fi

echo "Step 3: Create EmailAddress (WITHOUT rowguid)"
echo "----------------------------"
EMAIL_RESULT=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation { createEmailAddress(item: { BusinessEntityID: $BUSINESS_ENTITY_ID, EmailAddress: \\\"$EMAIL\\\" }) { EmailAddressID BusinessEntityID EmailAddress } }\"
  }")

echo "$EMAIL_RESULT" | jq '.'
EMAIL_ADDRESS_ID=$(echo "$EMAIL_RESULT" | jq -r '.data.createEmailAddress.EmailAddressID')
echo "Created EmailAddressID: $EMAIL_ADDRESS_ID"
echo ""

if [ "$EMAIL_ADDRESS_ID" = "null" ] || [ -z "$EMAIL_ADDRESS_ID" ]; then
  echo "❌ Failed to create EmailAddress"
  exit 1
fi

echo "Step 4: Create Password"
echo "----------------------------"
PASSWORD_RESULT=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation { createPassword(item: { BusinessEntityID: $BUSINESS_ENTITY_ID, PasswordHash: \\\"$PASSWORD_HASH\\\", PasswordSalt: \\\"$PASSWORD_SALT\\\" }) { BusinessEntityID } }\"
  }")

echo "$PASSWORD_RESULT" | jq '.'
echo ""

if echo "$PASSWORD_RESULT" | jq -e '.errors' > /dev/null; then
  echo "❌ Failed to create Password"
  exit 1
fi

echo "Step 5: Create Customer"
echo "----------------------------"
ACCOUNT_NUMBER="AW$(printf "%08d" $BUSINESS_ENTITY_ID)"
CUSTOMER_RESULT=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation { createCustomer(item: { PersonID: $BUSINESS_ENTITY_ID, AccountNumber: \\\"$ACCOUNT_NUMBER\\\" }) { CustomerID PersonID AccountNumber } }\"
  }")

echo "$CUSTOMER_RESULT" | jq '.'
echo ""

if echo "$CUSTOMER_RESULT" | jq -e '.errors' > /dev/null; then
  echo "❌ Failed to create Customer"
  exit 1
fi

echo "✅ All steps completed successfully!"
echo ""
echo "Summary:"
echo "--------"
echo "BusinessEntityID: $BUSINESS_ENTITY_ID"
echo "Email: $EMAIL"
echo "EmailAddressID: $EMAIL_ADDRESS_ID"
