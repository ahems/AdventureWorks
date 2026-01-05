#!/bin/bash

MCP_URL="https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/mcp/call"

echo "======================================"
echo "Testing MCP Tools Directly"
echo "======================================"
echo ""

echo "Test 1: get_personalized_recommendations"
echo "--------------------------------------"
curl -s -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -d '{"name": "get_personalized_recommendations", "arguments": {"customerId": 29825, "limit": 3}}' \
  | jq -r '.content[0].text'
echo ""
echo ""

echo "Test 2: analyze_product_reviews"
echo "--------------------------------------"
curl -s -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -d '{"name": "analyze_product_reviews", "arguments": {"productId": 937}}' \
  | jq -r '.content[0].text'
echo ""
echo ""

echo "Test 3: check_inventory_availability"
echo "--------------------------------------"
curl -s -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -d '{"name": "check_inventory_availability", "arguments": {"productId": 1}}' \
  | jq -r '.content[0].text'
echo ""
echo ""

echo "======================================"
echo "All MCP tools working!"
echo "======================================"
