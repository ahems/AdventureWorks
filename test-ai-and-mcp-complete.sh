#!/bin/bash
# Comprehensive Test Script for AI Chat Feature and MCP Server Tools
# Tests both the Functions API AI Agent endpoints and all MCP Server tools using Azure-deployed services
#
# IMPORTANT TEST FINDINGS:
# - MCP tools work correctly when called directly (Part 3) ✓
# - AI Chat fails to use MCP tools successfully (Part 4) ✗
# 
# ROOT CAUSE:
# The AIAgentService in api-functions/Services/AIAgentService.cs is configured to call
# the wrong MCP endpoint. It uses MCP_SERVICE_URL which points to:
#   - OLD: /api/mcp/call (REST API that no longer exists)
#   - NEW: Should use MCP_SERVICE_URL with /mcp endpoint and JSON-RPC 2.0 format
#
# TO FIX:
# 1. Update AIAgentService.cs CallMCPToolAsync() method to use JSON-RPC 2.0 format
# 2. Ensure MCP_SERVICE_URL includes /mcp endpoint in infrastructure
# 3. Change endpoint from /api/mcp/call to /mcp
# 4. Update request format to include jsonrpc, method: "tools/call", params, and id

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get Azure URLs from environment
echo -e "${BLUE}=== Loading Azure Environment Configuration ===${NC}"
eval $(azd env get-values | grep -E "(API_URL|API_FUNCTIONS_URL|MCP_SERVICE_URL)=")

# Strip trailing slash from API_URL if present
API_URL="${API_URL%/}"

echo -e "${GREEN}✓ API URL: ${API_URL}${NC}"
echo -e "${GREEN}✓ Functions URL: ${API_FUNCTIONS_URL}${NC}"
echo -e "${GREEN}✓ MCP URL: ${MCP_SERVICE_URL}${NC}"
echo ""

# Test counter
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Function to print test header
print_test_header() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Function to check test result
check_result() {
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ PASSED${NC}: $2"
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${RED}✗ FAILED${NC}: $2"
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
    echo ""
}

# Function to validate JSON response
validate_json() {
    if echo "$1" | jq empty 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

# ==============================================================================
# PART 1: GET TEST DATA FROM DAB API
# ==============================================================================

print_test_header "PART 1: Fetching Test Data from DAB API"

echo -e "${YELLOW}Fetching a customer with orders for testing...${NC}"
# DAB API paginates at 100 items - get a customer that has orders
# First, get a recent order and use its customer ID
ORDER_QUERY='query { salesOrderHeaders(filter: { Status: { eq: 5 } }, first: 1) { items { SalesOrderID CustomerID } } }'
ORDER_RESPONSE=$(curl -s -X POST "${API_URL}" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$ORDER_QUERY\"}")

echo "Response: $ORDER_RESPONSE"
CUSTOMER_ID=$(echo "$ORDER_RESPONSE" | jq -r '.data.salesOrderHeaders.items[0].CustomerID // empty')

if [ -n "$CUSTOMER_ID" ]; then
    check_result 0 "Retrieved customer ID: $CUSTOMER_ID (has completed orders)"
else
    echo -e "${RED}Failed to get customer ID, using default 29825${NC}"
    CUSTOMER_ID=29825
    check_result 1 "Failed to fetch customer from DAB API"
fi

echo -e "${YELLOW}Fetching a product for testing...${NC}"
PRODUCT_QUERY='query { products(first: 1, filter: { FinishedGoodsFlag: { eq: true } }) { items { ProductID Name } } }'
PRODUCT_RESPONSE=$(curl -s -X POST "${API_URL}" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$PRODUCT_QUERY\"}")

echo "Response: $PRODUCT_RESPONSE"
PRODUCT_ID=$(echo "$PRODUCT_RESPONSE" | jq -r '.data.products.items[0].ProductID // empty')
PRODUCT_NAME=$(echo "$PRODUCT_RESPONSE" | jq -r '.data.products.items[0].Name // empty')

if [ -n "$PRODUCT_ID" ]; then
    check_result 0 "Retrieved product: $PRODUCT_NAME (ID: $PRODUCT_ID)"
else
    echo -e "${RED}Failed to get product, using default ID 680${NC}"
    PRODUCT_ID=680
    PRODUCT_NAME="HL Road Frame - Black, 58"
    check_result 1 "Failed to fetch product from DAB API"
fi

echo -e "${YELLOW}Fetching an order for testing...${NC}"
# Get a shipped order with details for the customer
ORDER_QUERY="query { salesOrderHeaders(filter: { CustomerID: { eq: $CUSTOMER_ID }, Status: { eq: 5 } }, first: 1) { items { SalesOrderID OrderDate TotalDue } } }"
ORDER_RESPONSE=$(curl -s -X POST "${API_URL}" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$ORDER_QUERY\"}")

echo "Response: $ORDER_RESPONSE"
ORDER_ID=$(echo "$ORDER_RESPONSE" | jq -r '.data.salesOrderHeaders.items[0].SalesOrderID // empty')

if [ -n "$ORDER_ID" ]; then
    # Verify order has detail lines
    ORDER_DETAILS_QUERY="query { salesOrderDetails(filter: { SalesOrderID: { eq: $ORDER_ID } }, first: 1) { items { SalesOrderID } } }"
    ORDER_DETAILS_RESPONSE=$(curl -s -X POST "${API_URL}" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$ORDER_DETAILS_QUERY\"}")
    HAS_DETAILS=$(echo "$ORDER_DETAILS_RESPONSE" | jq -r '.data.salesOrderDetails.items[0].SalesOrderID // empty')
    
    if [ -n "$HAS_DETAILS" ]; then
        check_result 0 "Retrieved order ID: $ORDER_ID for customer $CUSTOMER_ID (has order details)"
    else
        echo -e "${YELLOW}Order has no details, using default order 43659${NC}"
        ORDER_ID=43659
        check_result 1 "Retrieved order but it has no detail lines"
    fi
else
    echo -e "${RED}Failed to get order, using default ID 43659${NC}"
    ORDER_ID=43659
    check_result 1 "Failed to fetch order from DAB API"
fi

# ==============================================================================
# PART 2: TEST AI AGENT ENDPOINTS (Functions API)
# ==============================================================================

print_test_header "PART 2: Testing AI Agent Functions API"

# Test 1: Agent Status
echo -e "${YELLOW}Test 2.1: Agent Status Endpoint${NC}"
STATUS_RESPONSE=$(curl -s -w "\n%{http_code}" "${API_FUNCTIONS_URL}/api/agent/status")
STATUS_BODY=$(echo "$STATUS_RESPONSE" | head -n -1)
STATUS_CODE=$(echo "$STATUS_RESPONSE" | tail -n 1)

echo "Status Code: $STATUS_CODE"
echo "Response: $STATUS_BODY"

if [ "$STATUS_CODE" = "200" ] && validate_json "$STATUS_BODY"; then
    STATUS=$(echo "$STATUS_BODY" | jq -r '.status // empty')
    if [ "$STATUS" = "operational" ]; then
        check_result 0 "Agent status is operational"
    else
        check_result 1 "Agent status is not operational: $STATUS"
    fi
else
    check_result 1 "Failed to get agent status (HTTP $STATUS_CODE)"
fi

# Test 2: Simple Chat Request
echo -e "${YELLOW}Test 2.2: Simple Chat Request${NC}"
CHAT_REQUEST=$(cat <<EOF
{
    "message": "Hello, can you help me?",
    "customerId": $CUSTOMER_ID,
    "conversationHistory": []
}
EOF
)

CHAT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_FUNCTIONS_URL}/api/agent/chat" \
    -H "Content-Type: application/json" \
    -d "$CHAT_REQUEST")

CHAT_BODY=$(echo "$CHAT_RESPONSE" | head -n -1)
CHAT_CODE=$(echo "$CHAT_RESPONSE" | tail -n 1)

echo "Status Code: $CHAT_CODE"
echo "Response (truncated): $(echo "$CHAT_BODY" | jq -c '.' 2>/dev/null | head -c 200)..."

if [ "$CHAT_CODE" = "200" ] && validate_json "$CHAT_BODY"; then
    CHAT_MESSAGE=$(echo "$CHAT_BODY" | jq -r '.Response // .message // .response // empty' | head -c 100)
    if [ -n "$CHAT_MESSAGE" ]; then
        check_result 0 "Chat responded: ${CHAT_MESSAGE}..."
    else
        check_result 1 "Chat returned 200 but no message in response"
    fi
else
    check_result 1 "Chat request failed (HTTP $CHAT_CODE)"
fi

# Test 3: Product Search Request
echo -e "${YELLOW}Test 2.3: Chat with Product Search Intent${NC}"
PRODUCT_SEARCH_REQUEST=$(cat <<EOF
{
    "message": "I'm looking for bikes. What do you have?",
    "customerId": $CUSTOMER_ID,
    "conversationHistory": []
}
EOF
)

PRODUCT_SEARCH_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_FUNCTIONS_URL}/api/agent/chat" \
    -H "Content-Type: application/json" \
    -d "$PRODUCT_SEARCH_REQUEST")

PRODUCT_SEARCH_BODY=$(echo "$PRODUCT_SEARCH_RESPONSE" | head -n -1)
PRODUCT_SEARCH_CODE=$(echo "$PRODUCT_SEARCH_RESPONSE" | tail -n 1)

echo "Status Code: $PRODUCT_SEARCH_CODE"
echo "Response (truncated): $(echo "$PRODUCT_SEARCH_BODY" | jq -c '.' 2>/dev/null | head -c 200)..."

if [ "$PRODUCT_SEARCH_CODE" = "200" ] && validate_json "$PRODUCT_SEARCH_BODY"; then
    check_result 0 "Product search chat completed successfully"
else
    check_result 1 "Product search chat failed (HTTP $PRODUCT_SEARCH_CODE)"
fi

# Test 4: Order Inquiry Request
echo -e "${YELLOW}Test 2.4: Chat with Order Inquiry${NC}"
ORDER_INQUIRY_REQUEST=$(cat <<EOF
{
    "message": "Can you show me my recent orders?",
    "customerId": $CUSTOMER_ID,
    "conversationHistory": []
}
EOF
)

ORDER_INQUIRY_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_FUNCTIONS_URL}/api/agent/chat" \
    -H "Content-Type: application/json" \
    -d "$ORDER_INQUIRY_REQUEST")

ORDER_INQUIRY_BODY=$(echo "$ORDER_INQUIRY_RESPONSE" | head -n -1)
ORDER_INQUIRY_CODE=$(echo "$ORDER_INQUIRY_RESPONSE" | tail -n 1)

echo "Status Code: $ORDER_INQUIRY_CODE"
echo "Response (truncated): $(echo "$ORDER_INQUIRY_BODY" | jq -c '.' 2>/dev/null | head -c 200)..."

if [ "$ORDER_INQUIRY_CODE" = "200" ] && validate_json "$ORDER_INQUIRY_BODY"; then
    check_result 0 "Order inquiry chat completed successfully"
else
    check_result 1 "Order inquiry chat failed (HTTP $ORDER_INQUIRY_CODE)"
fi

# ==============================================================================
# PART 3: TEST ALL MCP SERVER TOOLS
# ==============================================================================

print_test_header "PART 3: Testing MCP Server Tools (via SSE)"

# Helper function to test MCP tool via JSON-RPC 2.0
test_mcp_tool() {
    local tool_name="$1"
    local params="$2"
    local description="$3"
    
    echo -e "${YELLOW}Test 3.x: $description${NC}"
    
    # Create JSON-RPC 2.0 request for tool call
    local request=$(cat <<EOF
{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
        "name": "$tool_name",
        "arguments": $params
    },
    "id": $RANDOM
}
EOF
)
    
    echo "Tool: $tool_name"
    echo "Params: $params"
    
    # Call MCP server endpoint (returns SSE format with event: and data: lines)
    # Note: MCP_SERVICE_URL already includes /mcp endpoint
    local response=$(curl -s -X POST "${MCP_SERVICE_URL}" \
        -H "Content-Type: application/json" \
        -d "$request" | grep "^data:" | sed 's/^data: //')
    
    echo "Response (truncated): $(echo "$response" | head -c 300)..."
    
    if [ -n "$response" ] && echo "$response" | jq empty 2>/dev/null; then
        # Check for isError field first
        local is_error=$(echo "$response" | jq -r '.result.isError // false' 2>/dev/null)
        if [ "$is_error" = "true" ]; then
            local error_msg=$(echo "$response" | jq -r '.result.content[0].text // "Unknown error"' 2>/dev/null)
            echo "ERROR: $error_msg"
            check_result 1 "$description failed with error: $error_msg"
            return 1
        fi
        
        local result=$(echo "$response" | jq -r '.result.content[0].text // .result // empty' 2>/dev/null)
        if [ -n "$result" ]; then
            check_result 0 "$description completed successfully"
            return 0
        fi
    fi
    
    check_result 1 "$description failed - no valid response"
    return 1
}

# Test MCP Tool 1: get_customer_orders (snake_case!)
test_mcp_tool "get_customer_orders" \
    "{\"customerId\": $CUSTOMER_ID}" \
    "get_customer_orders - Fetch order history for customer $CUSTOMER_ID"

# Test MCP Tool 2: get_order_details
test_mcp_tool "get_order_details" \
    "{\"orderId\": $ORDER_ID}" \
    "get_order_details - Get details for order $ORDER_ID"

# Test MCP Tool 3: get_order_details with CustomerID validation
test_mcp_tool "get_order_details" \
    "{\"orderId\": $ORDER_ID, \"customerId\": $CUSTOMER_ID}" \
    "get_order_details - Get order $ORDER_ID with customer validation"

# Test MCP Tool 4: find_complementary_products
test_mcp_tool "find_complementary_products" \
    "{\"productId\": $PRODUCT_ID, \"limit\": 5}" \
    "find_complementary_products - Find products often bought with product $PRODUCT_ID"

# Test MCP Tool 5: search_products
test_mcp_tool "search_products" \
    "{\"searchTerm\": \"bike\"}" \
    "search_products - Search for bikes"

# Test MCP Tool 6: search_products with category
test_mcp_tool "search_products" \
    "{\"searchTerm\": \"helmet\", \"categoryId\": 1}" \
    "search_products - Search for helmets in specific category"

# Test MCP Tool 7: get_product_details
test_mcp_tool "get_product_details" \
    "{\"productId\": $PRODUCT_ID}" \
    "get_product_details - Get details for product $PRODUCT_ID"

# Test MCP Tool 8: get_personalized_recommendations
test_mcp_tool "get_personalized_recommendations" \
    "{\"customerId\": $CUSTOMER_ID, \"limit\": 5}" \
    "get_personalized_recommendations - Get personalized recommendations for customer $CUSTOMER_ID"

# Test MCP Tool 9: analyze_product_reviews
test_mcp_tool "analyze_product_reviews" \
    "{\"productId\": $PRODUCT_ID}" \
    "analyze_product_reviews - Analyze reviews for product $PRODUCT_ID"

# Test MCP Tool 10: check_inventory_availability
test_mcp_tool "check_inventory_availability" \
    "{\"productId\": $PRODUCT_ID}" \
    "check_inventory_availability - Check inventory for product $PRODUCT_ID"

# ==============================================================================
# PART 4: TEST MCP INTEGRATION IN AI CHAT
# ==============================================================================

print_test_header "PART 4: Testing AI Chat with MCP Tool Integration"

echo -e "${YELLOW}Test 4.1: Chat that should trigger GetCustomerOrders tool${NC}"
TOOL_TEST_REQUEST=$(cat <<EOF
{
    "message": "What orders have I placed recently?",
    "customerId": $CUSTOMER_ID,
    "conversationHistory": []
}
EOF
)

TOOL_TEST_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_FUNCTIONS_URL}/api/agent/chat" \
    -H "Content-Type: application/json" \
    -d "$TOOL_TEST_REQUEST")

TOOL_TEST_BODY=$(echo "$TOOL_TEST_RESPONSE" | head -n -1)
TOOL_TEST_CODE=$(echo "$TOOL_TEST_RESPONSE" | tail -n 1)

echo "Status Code: $TOOL_TEST_CODE"
echo "Response (truncated): $(echo "$TOOL_TEST_BODY" | jq -c '.' 2>/dev/null | head -c 300)..."

if [ "$TOOL_TEST_CODE" = "200" ] && validate_json "$TOOL_TEST_BODY"; then
    # Check if response mentions orders or order-related info
    RESPONSE_TEXT=$(echo "$TOOL_TEST_BODY" | jq -r '.Response // .message // .response // empty' | tr '[:upper:]' '[:lower:]')
    
    # Check for error indicators
    if echo "$RESPONSE_TEXT" | grep -qE "having trouble|issue with|couldn't|unable to|failed to|error occurred"; then
        check_result 1 "Chat with order query failed - AI reported: $(echo "$RESPONSE_TEXT" | head -c 100)..."
    elif echo "$RESPONSE_TEXT" | grep -qE "order|purchase|bought"; then
        check_result 0 "Chat with order query returned order-related information"
    else
        check_result 1 "Chat succeeded but didn't return order information"
    fi
else
    check_result 1 "Chat with order query failed (HTTP $TOOL_TEST_CODE)"
fi

echo -e "${YELLOW}Test 4.2: Chat that should trigger SearchProducts tool${NC}"
SEARCH_TEST_REQUEST=$(cat <<EOF
{
    "message": "Show me some mountain bikes",
    "customerId": $CUSTOMER_ID,
    "conversationHistory": []
}
EOF
)

SEARCH_TEST_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_FUNCTIONS_URL}/api/agent/chat" \
    -H "Content-Type: application/json" \
    -d "$SEARCH_TEST_REQUEST")

SEARCH_TEST_BODY=$(echo "$SEARCH_TEST_RESPONSE" | head -n -1)
SEARCH_TEST_CODE=$(echo "$SEARCH_TEST_RESPONSE" | tail -n 1)

echo "Status Code: $SEARCH_TEST_CODE"
echo "Response (truncated): $(echo "$SEARCH_TEST_BODY" | jq -c '.' 2>/dev/null | head -c 300)..."

if [ "$SEARCH_TEST_CODE" = "200" ] && validate_json "$SEARCH_TEST_BODY"; then
    SEARCH_RESPONSE_TEXT=$(echo "$SEARCH_TEST_BODY" | jq -r '.Response // .message // .response // empty' | tr '[:upper:]' '[:lower:]')
    
    # Check for error indicators
    if echo "$SEARCH_RESPONSE_TEXT" | grep -qE "having trouble|issue with|couldn't|unable to|failed to|error occurred|problem with accessing"; then
        check_result 1 "Chat with product search failed - AI reported: $(echo "$SEARCH_RESPONSE_TEXT" | head -c 100)..."
    else
        check_result 0 "Chat with product search completed successfully"
    fi
else
    check_result 1 "Chat with product search failed (HTTP $SEARCH_TEST_CODE)"
fi

echo -e "${YELLOW}Test 4.3: Chat that should trigger GetProductDetails tool${NC}"
DETAILS_TEST_REQUEST=$(cat <<EOF
{
    "message": "Tell me more about product $PRODUCT_ID",
    "customerId": $CUSTOMER_ID,
    "conversationHistory": []
}
EOF
)

DETAILS_TEST_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_FUNCTIONS_URL}/api/agent/chat" \
    -H "Content-Type: application/json" \
    -d "$DETAILS_TEST_REQUEST")

DETAILS_TEST_BODY=$(echo "$DETAILS_TEST_RESPONSE" | head -n -1)
DETAILS_TEST_CODE=$(echo "$DETAILS_TEST_RESPONSE" | tail -n 1)

echo "Status Code: $DETAILS_TEST_CODE"
echo "Response (truncated): $(echo "$DETAILS_TEST_BODY" | jq -c '.' 2>/dev/null | head -c 300)..."

if [ "$DETAILS_TEST_CODE" = "200" ] && validate_json "$DETAILS_TEST_BODY"; then
    DETAILS_RESPONSE_TEXT=$(echo "$DETAILS_TEST_BODY" | jq -r '.Response // .message // .response // empty' | tr '[:upper:]' '[:lower:]')
    
    # Check for error indicators
    if echo "$DETAILS_RESPONSE_TEXT" | grep -qE "couldn't find|unable to|failed to|error occurred|verify the product"; then
        check_result 1 "Chat with product details failed - AI reported: $(echo "$DETAILS_RESPONSE_TEXT" | head -c 100)..."
    else
        check_result 0 "Chat with product details query completed successfully"
    fi
else
    check_result 1 "Chat with product details query failed (HTTP $DETAILS_TEST_CODE)"
fi

# ==============================================================================
# TEST SUMMARY
# ==============================================================================

print_test_header "TEST SUMMARY"

echo -e "${BLUE}Total Tests: $TOTAL_TESTS${NC}"
echo -e "${GREEN}Passed: $PASSED_TESTS${NC}"
echo -e "${RED}Failed: $FAILED_TESTS${NC}"
echo ""

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}✓ ALL TESTS PASSED!${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 0
else
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}✗ SOME TESTS FAILED${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
fi
