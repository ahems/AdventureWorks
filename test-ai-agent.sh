#!/bin/bash

# Test AI Agent Endpoint
FUNCTION_URL="https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io"

echo "========================================="
echo "Testing AI Agent Endpoint"
echo "========================================="
echo ""

# Test 1: Agent Status
echo "1. Testing Agent Status Endpoint..."
echo "GET $FUNCTION_URL/api/agent/status"
echo ""
STATUS_RESPONSE=$(curl -s --max-time 30 "$FUNCTION_URL/api/agent/status")
if [ $? -eq 0 ] && [ ! -z "$STATUS_RESPONSE" ]; then
    echo "✅ Status endpoint responding"
    echo "$STATUS_RESPONSE" | jq .
else
    echo "⚠️  Status endpoint not responding yet (container may be cold starting)"
    echo "Response: $STATUS_RESPONSE"
fi
echo ""

# Test 2: Chat with Agent (Simple Query)
echo "2. Testing AI Agent Chat - Simple Product Query..."
echo "POST $FUNCTION_URL/api/agent/chat"
echo ""
CHAT_PAYLOAD='{
  "message": "What products do you have?",
  "conversationHistory": [],
  "customerId": null
}'

CHAT_RESPONSE=$(curl -s --max-time 60 \
  -X POST "$FUNCTION_URL/api/agent/chat" \
  -H "Content-Type: application/json" \
  -d "$CHAT_PAYLOAD")

if [ $? -eq 0 ] && [ ! -z "$CHAT_RESPONSE" ]; then
    echo "✅ Chat endpoint responding"
    echo "$CHAT_RESPONSE" | jq '.'
    
    # Extract suggested questions
    echo ""
    echo "Suggested Questions:"
    echo "$CHAT_RESPONSE" | jq -r '.suggestedQuestions[]?' 2>/dev/null || echo "(none)"
else
    echo "⚠️  Chat endpoint not responding yet"
    echo "Response: $CHAT_RESPONSE"
fi
echo ""

# Test 3: Chat with Customer Context
echo "3. Testing AI Agent Chat - With Customer Context..."
echo ""
CHAT_PAYLOAD_CUSTOMER='{
  "message": "Show me my recent orders",
  "conversationHistory": [],
  "customerId": 29825
}'

CHAT_RESPONSE_CUSTOMER=$(curl -s --max-time 60 \
  -X POST "$FUNCTION_URL/api/agent/chat" \
  -H "Content-Type: application/json" \
  -d "$CHAT_PAYLOAD_CUSTOMER")

if [ $? -eq 0 ] && [ ! -z "$CHAT_RESPONSE_CUSTOMER" ]; then
    echo "✅ Customer-specific chat responding"
    echo "$CHAT_RESPONSE_CUSTOMER" | jq '.'
else
    echo "⚠️  Customer chat not responding yet"
    echo "Response: $CHAT_RESPONSE_CUSTOMER"
fi
echo ""

echo "========================================="
echo "Test Complete"
echo "========================================="
echo ""
echo "Frontend URL: https://proud-flower-0e8bed00f.3.azurestaticapps.net"
echo "Functions URL: $FUNCTION_URL"
echo ""
echo "To test the UI:"
echo "1. Open the frontend URL in a browser"
echo "2. Click 'Sign In' (use test email: customer1@adventure-works.com)"
echo "3. Click the AI chat button in the bottom right"
echo "4. Try asking: 'Show me my orders' or 'Find bike helmets'"
