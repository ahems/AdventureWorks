#!/bin/bash

# Test script for AI Chat Feature (via Functions API) and MCP Server Tools
# This script validates the complete AI Chat integration and all MCP tools
# Tests against Azure-deployed services

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get Azure environment variables
echo -e "${BLUE}Loading Azure environment variables...${NC}"
eval $(azd env get-values)

# Validate required environment variables
if [ -z "$API_URL" ] || [ -z "$API_FUNCTIONS_URL" ] || [ -z "$API_MCP_URL" ]; then
    echo -e "${RED}Error: Required Azure URLs not found in environment${NC}"
    echo "Please ensure you have deployed the application with 'azd up'"
    exit 1
fi

# Remove trailing slashes and set up URLs
DAB_API_URL="${API_URL%/}"
FUNCTIONS_API_URL="${API_FUNCTIONS_URL}"
MCP_SERVER_URL="${API_MCP_URL}"

echo -e "${BLUE}Testing against:${NC}"
echo "  DAB API: $DAB_API_URL"
echo "  Functions API: $FUNCTIONS_API_URL"
echo "  MCP Server: $MCP_SERVER_URL"
echo ""

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0
FAILED_TESTS=()

# Helper function to run a test
run_test() {
    local test_name="$1"
    local test_command="$2"
    
    echo -e "${BLUE}Testing: ${test_name}${NC}"
    
    if eval "$test_command"; then
        echo -e "${GREEN}✓ PASSED: ${test_name}${NC}"
        ((TESTS_PASSED++))
        echo ""
        return 0
    else
        echo -e "${RED}✗ FAILED: ${test_name}${NC}"
        ((TESTS_FAILED++))
        FAILED_TESTS+=("$test_name")
        echo ""
        return 1
    fi
}

# Helper function to validate JSON response
validate_json() {
    local response="$1"
    echo "$response" | jq . > /dev/null 2>&1
    return $?
}

# Helper function to check if response contains expected field
check_field() {
    local response="$1"
    local field="$2"
    echo "$response" | jq -e "$field" > /dev/null 2>&1
}

echo -e "${YELLOW}=====================================${NC}"
echo -e "${YELLOW}STEP 1: Get Test CustomerID from DAB${NC}"
echo -e "${YELLOW}=====================================${NC}"
echo ""

# Get the most recently added customer (should be ID 30119)
echo -e "${BLUE}Fetching most recent customer from DAB API...${NC}"
CUSTOMER_QUERY='query { customers(orderBy: { CustomerID: DESC }, first: 1) { items { CustomerID PersonID } } }'
CUSTOMER_RESPONSE=$(curl -s -X POST "$DAB_API_URL" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$CUSTOMER_QUERY\"}")

if ! validate_json "$CUSTOMER_RESPONSE"; then
    echo -e "${RED}Failed to get valid JSON response from DAB API${NC}"
    echo "Response: $CUSTOMER_RESPONSE"
    exit 1
fi

CUSTOMER_ID=$(echo "$CUSTOMER_RESPONSE" | jq -r '.data.customers.items[0].CustomerID')
PERSON_ID=$(echo "$CUSTOMER_RESPONSE" | jq -r '.data.customers.items[0].PersonID')

if [ -z "$CUSTOMER_ID" ] || [ "$CUSTOMER_ID" = "null" ]; then
    echo -e "${RED}Failed to retrieve CustomerID from DAB API${NC}"
    echo "Response: $CUSTOMER_RESPONSE"
    exit 1
fi

echo -e "${GREEN}✓ Retrieved Customer ID: $CUSTOMER_ID (Person ID: $PERSON_ID)${NC}"
echo ""

# Get a product ID for testing
echo -e "${BLUE}Fetching a test product from DAB API...${NC}"
PRODUCT_QUERY='query { products(first: 1, filter: { FinishedGoodsFlag: { eq: true } }) { items { ProductID Name ListPrice } } }'
PRODUCT_RESPONSE=$(curl -s -X POST "$DAB_API_URL" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$PRODUCT_QUERY\"}")

PRODUCT_ID=$(echo "$PRODUCT_RESPONSE" | jq -r '.data.products.items[0].ProductID')
PRODUCT_NAME=$(echo "$PRODUCT_RESPONSE" | jq -r '.data.products.items[0].Name')
PRODUCT_PRICE=$(echo "$PRODUCT_RESPONSE" | jq -r '.data.products.items[0].ListPrice')

echo -e "${GREEN}✓ Retrieved Product: $PRODUCT_NAME (ID: $PRODUCT_ID, Price: \$$PRODUCT_PRICE)${NC}"
echo ""

echo -e "${YELLOW}=====================================${NC}"
echo -e "${YELLOW}STEP 2: Test MCP Server Tools${NC}"
echo -e "${YELLOW}=====================================${NC}"
echo ""

# Test 1: GetCustomerOrders
run_test "MCP Tool: GetCustomerOrders" '
    RESPONSE=$(curl -s -X POST "$MCP_SERVER_URL/api/mcp/call" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"GetCustomerOrders\", \"arguments\": {\"customerId\": $CUSTOMER_ID}}")
    validate_json "$RESPONSE" && echo "$RESPONSE" | jq .
'

# Test 2: SearchProducts
run_test "MCP Tool: SearchProducts" '
    RESPONSE=$(curl -s -X POST "$MCP_SERVER_URL/api/mcp/call" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"SearchProducts\", \"arguments\": {\"searchTerm\": \"bike\"}}")
    validate_json "$RESPONSE" && echo "$RESPONSE" | jq -r ".content[0].text" | head -20
'

# Test 3: GetProductDetails
run_test "MCP Tool: GetProductDetails" '
    RESPONSE=$(curl -s -X POST "$MCP_SERVER_URL/api/mcp/call" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"GetProductDetails\", \"arguments\": {\"productId\": $PRODUCT_ID}}")
    validate_json "$RESPONSE" && echo "$RESPONSE" | jq -r ".content[0].text"
'

# Test 4: FindComplementaryProducts
run_test "MCP Tool: FindComplementaryProducts" '
    RESPONSE=$(curl -s -X POST "$MCP_SERVER_URL/api/mcp/call" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"FindComplementaryProducts\", \"arguments\": {\"productId\": $PRODUCT_ID, \"limit\": 3}}")
    validate_json "$RESPONSE" && echo "$RESPONSE" | jq -r ".content[0].text"
'

# Test 5: GetPersonalizedRecommendations
run_test "MCP Tool: GetPersonalizedRecommendations" '
    RESPONSE=$(curl -s -X POST "$MCP_SERVER_URL/api/mcp/call" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"GetPersonalizedRecommendations\", \"arguments\": {\"customerId\": $CUSTOMER_ID, \"limit\": 3}}")
    validate_json "$RESPONSE" && echo "$RESPONSE" | jq -r ".content[0].text"
'

# Test 6: AnalyzeProductReviews
run_test "MCP Tool: AnalyzeProductReviews" '
    RESPONSE=$(curl -s -X POST "$MCP_SERVER_URL/api/mcp/call" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"AnalyzeProductReviews\", \"arguments\": {\"productId\": $PRODUCT_ID}}")
    validate_json "$RESPONSE" && echo "$RESPONSE" | jq -r ".content[0].text"
'

# Test 7: CheckInventoryAvailability
run_test "MCP Tool: CheckInventoryAvailability" '
    RESPONSE=$(curl -s -X POST "$MCP_SERVER_URL/api/mcp/call" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"CheckInventoryAvailability\", \"arguments\": {\"productId\": $PRODUCT_ID}}")
    validate_json "$RESPONSE" && echo "$RESPONSE" | jq -r ".content[0].text"
'

# Test 8: GetOrderDetails (if customer has orders)
echo -e "${BLUE}Checking if customer has orders...${NC}"
ORDERS_QUERY="query { salesOrderHeaders(filter: { CustomerID: { eq: $CUSTOMER_ID } }, first: 1, orderBy: { OrderDate: DESC }) { items { SalesOrderID OrderDate TotalDue } } }"
ORDERS_RESPONSE=$(curl -s -X POST "$DAB_API_URL" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$ORDERS_QUERY\"}")

ORDER_ID=$(echo "$ORDERS_RESPONSE" | jq -r '.data.salesOrderHeaders.items[0].SalesOrderID // empty')

if [ -n "$ORDER_ID" ] && [ "$ORDER_ID" != "null" ]; then
    echo -e "${GREEN}Found order ID: $ORDER_ID${NC}"
    run_test "MCP Tool: GetOrderDetails" '
        RESPONSE=$(curl -s -X POST "$MCP_SERVER_URL/api/mcp/call" \
            -H "Content-Type: application/json" \
            -d "{\"name\": \"GetOrderDetails\", \"arguments\": {\"orderId\": $ORDER_ID, \"customerId\": $CUSTOMER_ID}}")
        validate_json "$RESPONSE" && echo "$RESPONSE" | jq -r ".content[0].text" | head -30
    '
else
    echo -e "${YELLOW}Customer has no orders, skipping GetOrderDetails test${NC}"
    echo ""
fi

echo -e "${YELLOW}=====================================${NC}"
echo -e "${YELLOW}STEP 3: Test AI Agent Functions${NC}"
echo -e "${YELLOW}=====================================${NC}"
echo ""

# Test 9: Agent Status Endpoint
run_test "AI Agent: Status Check" '
    RESPONSE=$(curl -s -X GET "$FUNCTIONS_API_URL/api/agent/status")
    validate_json "$RESPONSE" && 
    check_field "$RESPONSE" ".status" &&
    echo "$RESPONSE" | jq .
'

# Test 10: AI Chat - Simple greeting
run_test "AI Chat: Simple Greeting" '
    RESPONSE=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"Hello! I need help.\", \"customerId\": $CUSTOMER_ID}")
    validate_json "$RESPONSE" &&
    check_field "$RESPONSE" ".response" &&
    echo "$RESPONSE" | jq -r ".response" | head -20 &&
    echo "" &&
    echo -e "${BLUE}Suggested Questions:${NC}" &&
    echo "$RESPONSE" | jq -r ".suggestedQuestions[]"
'

# Test 11: AI Chat - Order inquiry (triggers get_customer_orders tool)
run_test "AI Chat: Order Inquiry (Tool: get_customer_orders)" '
    RESPONSE=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"Show me my recent orders\", \"customerId\": $CUSTOMER_ID}")
    validate_json "$RESPONSE" &&
    check_field "$RESPONSE" ".response" &&
    echo -e "${BLUE}Response:${NC}" &&
    echo "$RESPONSE" | jq -r ".response" | head -30 &&
    echo "" &&
    echo -e "${BLUE}Tools Used:${NC}" &&
    echo "$RESPONSE" | jq -r ".toolsUsed[]" &&
    echo "" &&
    echo -e "${BLUE}Suggested Questions:${NC}" &&
    echo "$RESPONSE" | jq -r ".suggestedQuestions[]"
'

# Test 12: AI Chat - Product search (triggers search_products tool)
run_test "AI Chat: Product Search (Tool: search_products)" '
    RESPONSE=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"Find me some mountain bikes\", \"customerId\": $CUSTOMER_ID}")
    validate_json "$RESPONSE" &&
    check_field "$RESPONSE" ".response" &&
    echo -e "${BLUE}Response:${NC}" &&
    echo "$RESPONSE" | jq -r ".response" | head -30 &&
    echo "" &&
    echo -e "${BLUE}Tools Used:${NC}" &&
    echo "$RESPONSE" | jq -r ".toolsUsed[]" &&
    echo "" &&
    echo -e "${BLUE}Suggested Questions:${NC}" &&
    echo "$RESPONSE" | jq -r ".suggestedQuestions[]"
'

# Test 13: AI Chat - Product details (triggers get_product_details tool)
run_test "AI Chat: Product Details (Tool: get_product_details)" '
    RESPONSE=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"Tell me about product ID $PRODUCT_ID\", \"customerId\": $CUSTOMER_ID}")
    validate_json "$RESPONSE" &&
    check_field "$RESPONSE" ".response" &&
    echo -e "${BLUE}Response:${NC}" &&
    echo "$RESPONSE" | jq -r ".response" | head -30 &&
    echo "" &&
    echo -e "${BLUE}Tools Used:${NC}" &&
    echo "$RESPONSE" | jq -r ".toolsUsed[]"
'

# Test 14: AI Chat - Recommendations (triggers get_personalized_recommendations tool)
run_test "AI Chat: Personalized Recommendations (Tool: get_personalized_recommendations)" '
    RESPONSE=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"What products would you recommend for me?\", \"customerId\": $CUSTOMER_ID}")
    validate_json "$RESPONSE" &&
    check_field "$RESPONSE" ".response" &&
    echo -e "${BLUE}Response:${NC}" &&
    echo "$RESPONSE" | jq -r ".response" | head -30 &&
    echo "" &&
    echo -e "${BLUE}Tools Used:${NC}" &&
    echo "$RESPONSE" | jq -r ".toolsUsed[]"
'

# Test 15: AI Chat - Inventory check (triggers check_inventory_availability tool)
run_test "AI Chat: Inventory Check (Tool: check_inventory_availability)" '
    RESPONSE=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"Is product $PRODUCT_ID in stock?\", \"customerId\": $CUSTOMER_ID}")
    validate_json "$RESPONSE" &&
    check_field "$RESPONSE" ".response" &&
    echo -e "${BLUE}Response:${NC}" &&
    echo "$RESPONSE" | jq -r ".response" | head -30 &&
    echo "" &&
    echo -e "${BLUE}Tools Used:${NC}" &&
    echo "$RESPONSE" | jq -r ".toolsUsed[]"
'

# Test 16: AI Chat - Multi-turn conversation with context
run_test "AI Chat: Multi-turn Conversation with Context" '
    # First message
    RESPONSE1=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"Search for helmets\", \"customerId\": $CUSTOMER_ID}")
    
    if ! validate_json "$RESPONSE1"; then
        echo "Failed on first message"
        false
        return
    fi
    
    # Build conversation history
    HISTORY=$(jq -n --arg msg1 "Search for helmets" --argjson resp1 "$RESPONSE1" "[
        {\"role\": \"user\", \"content\": \$msg1},
        {\"role\": \"assistant\", \"content\": \$resp1.response}
    ]")
    
    # Second message with context
    RESPONSE2=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"Tell me more about the first one\", \"conversationHistory\": $HISTORY, \"customerId\": $CUSTOMER_ID}")
    
    validate_json "$RESPONSE2" &&
    check_field "$RESPONSE2" ".response" &&
    echo -e "${BLUE}Conversation:${NC}" &&
    echo "User: Search for helmets" &&
    echo "Assistant: (searched products)" &&
    echo "User: Tell me more about the first one" &&
    echo "Assistant: $(echo "$RESPONSE2" | jq -r ".response" | head -20)"
'

# Test 17: AI Chat - Reviews analysis (triggers analyze_product_reviews tool)
run_test "AI Chat: Product Reviews (Tool: analyze_product_reviews)" '
    RESPONSE=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"What do customers say about product $PRODUCT_ID?\", \"customerId\": $CUSTOMER_ID}")
    validate_json "$RESPONSE" &&
    check_field "$RESPONSE" ".response" &&
    echo -e "${BLUE}Response:${NC}" &&
    echo "$RESPONSE" | jq -r ".response" | head -30 &&
    echo "" &&
    echo -e "${BLUE}Tools Used:${NC}" &&
    echo "$RESPONSE" | jq -r ".toolsUsed[]"
'

# Test 18: AI Chat - Complementary products (triggers find_complementary_products tool)
run_test "AI Chat: Product Suggestions (Tool: find_complementary_products)" '
    RESPONSE=$(curl -s -X POST "$FUNCTIONS_API_URL/api/agent/chat" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"What goes well with product $PRODUCT_ID?\", \"customerId\": $CUSTOMER_ID}")
    validate_json "$RESPONSE" &&
    check_field "$RESPONSE" ".response" &&
    echo -e "${BLUE}Response:${NC}" &&
    echo "$RESPONSE" | jq -r ".response" | head -30 &&
    echo "" &&
    echo -e "${BLUE}Tools Used:${NC}" &&
    echo "$RESPONSE" | jq -r ".toolsUsed[]"
'

echo -e "${YELLOW}=====================================${NC}"
echo -e "${YELLOW}Test Summary${NC}"
echo -e "${YELLOW}=====================================${NC}"
echo ""
echo -e "Total Tests: $((TESTS_PASSED + TESTS_FAILED))"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"

if [ $TESTS_FAILED -gt 0 ]; then
    echo ""
    echo -e "${RED}Failed Tests:${NC}"
    for test in "${FAILED_TESTS[@]}"; do
        echo -e "  - $test"
    done
    echo ""
    exit 1
else
    echo ""
    echo -e "${GREEN}🎉 All tests passed!${NC}"
    echo ""
    exit 0
fi
