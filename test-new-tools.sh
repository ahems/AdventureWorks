#!/bin/bash

API_URL="https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io"

echo "======================================"
echo "Testing New MCP Tools - AdventureWorks"
echo "======================================"
echo ""

echo "Test 1: Personalized Recommendations"
echo "--------------------------------------"
curl -s -X POST "$API_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "What products would you recommend for me based on my purchase history?", "customerId": 29825}' \
  | jq -r '{message: .message, toolsUsed: .toolsUsed}'
echo ""
echo ""

echo "Test 2: Product Review Analysis"
echo "--------------------------------------"
curl -s -X POST "$API_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "What are people saying about product 937? Are the reviews good?", "customerId": 29825}' \
  | jq -r '{message: .message, toolsUsed: .toolsUsed}'
echo ""
echo ""

echo "Test 3: Inventory Availability"
echo "--------------------------------------"
curl -s -X POST "$API_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "Is product 1 in stock? Where can I get it?", "customerId": 29825}' \
  | jq -r '{message: .message, toolsUsed: .toolsUsed}'
echo ""
echo ""

echo "======================================"
echo "All tests complete!"
echo "======================================"
