#!/bin/bash

# Test MCP tool directly
FUNCTION_URL="https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io"

echo "Testing MCP Server Direct Call"
echo "==============================="
echo ""

# Test get_customer_orders
echo "1. Testing get_customer_orders (customerId: 29825)"
curl -s -X POST "$FUNCTION_URL/api/mcp" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "get_customer_orders",
    "arguments": {
      "customerId": 29825
    }
  }' | jq '.' 2>/dev/null || echo "Failed to call MCP endpoint"

echo ""
echo "2. Testing search_products (searchTerm: 'bike')"
curl -s -X POST "$FUNCTION_URL/api/mcp" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "search_products",
    "arguments": {
      "searchTerm": "bike"
    }
  }' | jq '.' 2>/dev/null || echo "Failed to call MCP endpoint"
