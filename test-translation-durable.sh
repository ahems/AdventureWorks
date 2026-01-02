#!/bin/bash

# Test script for the Durable Functions Translation API
# Tests translation of a small JSON file to verify the orchestration works

set -e

# Get the Azure Function URL from azd environment
echo "Retrieving Azure Function URL from azd environment..."
FUNCTION_APP_URL=$(azd env get-values | grep "^VITE_API_FUNCTIONS_URL=" | cut -d'=' -f2 | tr -d '"' | tr -d '\r')

if [ -z "$FUNCTION_APP_URL" ]; then
  echo "Error: Could not find VITE_API_FUNCTIONS_URL in azd environment."
  exit 1
fi

FUNCTION_URL="${FUNCTION_APP_URL}/api/TranslateLanguageFile_HttpStart"

echo "Function URL: $FUNCTION_URL"
echo ""

# Create test payload
TEST_PAYLOAD='{
  "languageData": {
    "test": {
      "greeting": "Hello World",
      "farewell": "Goodbye",
      "welcome": "Welcome to AdventureWorks"
    },
    "buttons": {
      "submit": "Submit",
      "cancel": "Cancel"
    }
  },
  "targetLanguage": "es"
}'

echo "Starting translation orchestration..."
echo "Payload:"
echo "$TEST_PAYLOAD" | jq '.'
echo ""

# Start orchestration
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$FUNCTION_URL" \
  -H "Content-Type: application/json" \
  -d "$TEST_PAYLOAD")

HTTP_STATUS=$(echo "$RESPONSE" | tail -n 1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_STATUS"
echo ""
echo "Debug - Full response body:"
echo "$RESPONSE_BODY" | jq '.'
echo ""

if [ "$HTTP_STATUS" -ne 202 ]; then
  echo "❌ Failed to start orchestration"
  exit 1
fi

# Get status URL
STATUS_URL=$(echo "$RESPONSE_BODY" | jq -r '.statusUrl')
INSTANCE_ID=$(echo "$RESPONSE_BODY" | jq -r '.id')

echo "✅ Orchestration started"
echo "Instance ID: $INSTANCE_ID"
echo "Status URL: $STATUS_URL"
echo ""

if [ "$STATUS_URL" = "null" ] || [ -z "$STATUS_URL" ]; then
  echo "❌ Error: Status URL is missing from response"
  echo "This indicates the new function code hasn't been deployed yet."
  echo "Please run: azd deploy api-functions"
  exit 1
fi

# Poll for completion
echo "Polling for completion (max 2 minutes)..."
MAX_ATTEMPTS=24  # 2 minutes (5 seconds per attempt)
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  sleep 5
  ATTEMPT=$((ATTEMPT + 1))
  
  echo "[$ATTEMPT/$MAX_ATTEMPTS] Checking status..."
  
  STATUS_RESPONSE=$(curl -s "$STATUS_URL")
  
  # Debug: show first poll response
  if [ $ATTEMPT -eq 1 ]; then
    echo "Debug - First status response:"
    echo "$STATUS_RESPONSE"
    echo ""
    echo "Debug - Parsed as JSON:"
    echo "$STATUS_RESPONSE" | jq '.' 2>/dev/null || echo "Not valid JSON"
    echo ""
    
    # Also check HTTP status code
    HTTP_CODE=$(curl -s -w "%{http_code}" -o /dev/null "$STATUS_URL")
    echo "Debug - HTTP Status Code: $HTTP_CODE"
    echo ""
  fi
  
  RUNTIME_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.runtimeStatus' 2>/dev/null)
  
  case "$RUNTIME_STATUS" in
    "Completed")
      echo ""
      echo "✅ Translation completed!"
      echo ""
      echo "Result:"
      echo "$STATUS_RESPONSE" | jq -r '.output' | jq '.'
      echo ""
      echo "Full response:"
      echo "$STATUS_RESPONSE" | jq '.'
      exit 0
      ;;
    "Failed")
      echo ""
      echo "❌ Orchestration failed"
      echo "$STATUS_RESPONSE" | jq '.'
      exit 1
      ;;
    "Running"|"Pending")
      echo "   Status: $RUNTIME_STATUS"
      ;;
    *)
      echo "   Unknown status: $RUNTIME_STATUS"
      ;;
  esac
done

echo ""
echo "❌ Timeout waiting for orchestration to complete"
echo ""
echo "Last status:"
curl -s "$STATUS_URL" | jq '.'

exit 1
