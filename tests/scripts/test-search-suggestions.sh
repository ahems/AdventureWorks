#!/bin/bash

# Test script for the new search suggestions endpoint
# Usage: ./test-search-suggestions.sh [query]

set -e

API_URL="${API_FUNCTIONS_URL:-$(azd env get-value API_FUNCTIONS_URL --no-prompt 2>/dev/null || true)}"
if [ -z "$API_URL" ]; then
  echo "Set API_FUNCTIONS_URL or select a deployed azd environment." >&2
  exit 1
fi

# Get query from argument or use default
QUERY="${1:-red bik}"

echo "🔍 Testing Search Suggestions Endpoint"
echo "========================================"
echo "API URL: $API_URL"
echo "Query: '$QUERY'"
echo ""

# Make the request
echo "📡 Sending request..."
RESPONSE=$(curl -s -w "\n%{http_code}" "${API_URL}/api/search/suggestions?q=$(echo "$QUERY" | jq -sRr @uri)")

# Extract HTTP status code (last line)
HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)
BODY=$(echo "$RESPONSE" | head -n -1)

echo ""
echo "HTTP Status: $HTTP_CODE"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Success! Suggestions returned:"
    echo "$BODY" | jq -r '.suggestions[]' | while read -r suggestion; do
        echo "  • $suggestion"
    done
    echo ""
    echo "Full response:"
    echo "$BODY" | jq .
else
    echo "❌ Error: Request failed"
    echo "$BODY" | jq . || echo "$BODY"
fi

echo ""
echo "📊 Test completed"
