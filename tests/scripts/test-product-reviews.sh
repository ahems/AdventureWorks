#!/bin/bash

# Test script for product review functionality
# Usage: ./test-product-reviews.sh [api-url]

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the API URL from argument or azd env
if [ -n "$1" ]; then
    API_URL="$1"
else
    # Get from azd environment
    API_URL=$(azd env get-values | grep "^API_URL=" | cut -d'=' -f2 | tr -d '"')
    
    if [ -z "$API_URL" ]; then
        echo -e "${RED}Error: Could not determine API URL${NC}"
        echo "Either provide URL as argument or run 'azd up' to set up Azure environment"
        echo "Usage: ./test-product-reviews.sh [api-url]"
        exit 1
    fi
fi

# Remove /graphql suffix if present and get base REST API URL
REST_API_URL=$(echo "$API_URL" | sed 's|/graphql||')

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}Testing Product Review Functionality${NC}"
echo -e "${BLUE}=========================================${NC}"
echo -e "API URL: ${REST_API_URL}"
echo ""

# Test data
TEST_PRODUCT_ID=680
TEST_REVIEWER_NAME="Test User $(date +%s)"
TEST_EMAIL="test-$(date +%s)@example.com"
TEST_RATING=4
TEST_COMMENT="This is an automated test review. Great product quality and excellent value for money. Would definitely recommend!"
TEST_USER_ID=$((1000 + RANDOM % 9000))

echo -e "${YELLOW}Test Configuration:${NC}"
echo "  Product ID: $TEST_PRODUCT_ID"
echo "  Reviewer: $TEST_REVIEWER_NAME"
echo "  Email: $TEST_EMAIL"
echo "  Rating: $TEST_RATING/5"
echo "  User ID: $TEST_USER_ID"
echo ""

# Test 1: Get existing reviews for the product
echo -e "${BLUE}Test 1: Fetching existing reviews for product $TEST_PRODUCT_ID${NC}"
echo "-------------------------------------------"
echo "Request: GET ${REST_API_URL}/api/ProductReview?\$filter=ProductID eq ${TEST_PRODUCT_ID}"

GET_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
  "${REST_API_URL}/api/ProductReview?\$filter=ProductID%20eq%20${TEST_PRODUCT_ID}")

HTTP_CODE=$(echo "$GET_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$GET_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
    REVIEW_COUNT=$(echo "$RESPONSE_BODY" | jq -r '.value | length' 2>/dev/null || echo "0")
    echo -e "${GREEN}✓ Successfully fetched reviews (Count: $REVIEW_COUNT)${NC}"
else
    echo -e "${RED}✗ Failed to fetch reviews${NC}"
fi
echo ""

# Test 2: Add a new review
echo -e "${BLUE}Test 2: Adding a new product review${NC}"
echo "-------------------------------------------"
echo "Request: POST ${REST_API_URL}/api/ProductReview"

REVIEW_DATA=$(cat <<EOF
{
  "ProductID": ${TEST_PRODUCT_ID},
  "ReviewerName": "${TEST_REVIEWER_NAME}",
  "ReviewDate": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "EmailAddress": "${TEST_EMAIL}",
  "Rating": ${TEST_RATING},
  "Comments": "${TEST_COMMENT}",
  "HelpfulVotes": 0,
  "UserID": ${TEST_USER_ID}
}
EOF
)

echo "Request Body:"
echo "$REVIEW_DATA" | jq '.'
echo ""

POST_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
  "${REST_API_URL}/api/ProductReview" \
  -H "Content-Type: application/json" \
  -d "$REVIEW_DATA")

HTTP_CODE=$(echo "$POST_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$POST_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"
echo ""

if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
    NEW_REVIEW_ID=$(echo "$RESPONSE_BODY" | jq -r '.value[0].ProductReviewID // .ProductReviewID // empty' 2>/dev/null)
    echo -e "${GREEN}✓ Successfully added review (Review ID: $NEW_REVIEW_ID)${NC}"
    
    # Test 3: Verify the review was added by fetching it
    if [ -n "$NEW_REVIEW_ID" ]; then
        echo ""
        echo -e "${BLUE}Test 3: Verifying the newly added review${NC}"
        echo "-------------------------------------------"
        echo "Request: GET ${REST_API_URL}/api/ProductReview/${NEW_REVIEW_ID}"
        
        VERIFY_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
          "${REST_API_URL}/api/ProductReview/${NEW_REVIEW_ID}")
        
        HTTP_CODE=$(echo "$VERIFY_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
        RESPONSE_BODY=$(echo "$VERIFY_RESPONSE" | sed '/HTTP_CODE:/d')
        
        echo "HTTP Status: $HTTP_CODE"
        echo "Response: $RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"
        echo ""
        
        if [ "$HTTP_CODE" = "200" ]; then
            FETCHED_RATING=$(echo "$RESPONSE_BODY" | jq -r '.value[0].Rating // .Rating // empty' 2>/dev/null)
            FETCHED_COMMENT=$(echo "$RESPONSE_BODY" | jq -r '.value[0].Comments // .Comments // empty' 2>/dev/null)
            
            if [ "$FETCHED_RATING" = "$TEST_RATING" ]; then
                echo -e "${GREEN}✓ Rating verified: $FETCHED_RATING/5${NC}"
            else
                echo -e "${RED}✗ Rating mismatch: Expected $TEST_RATING, got $FETCHED_RATING${NC}"
            fi
            
            if [[ "$FETCHED_COMMENT" == *"automated test"* ]]; then
                echo -e "${GREEN}✓ Comment verified${NC}"
            else
                echo -e "${RED}✗ Comment verification failed${NC}"
            fi
        else
            echo -e "${RED}✗ Failed to verify review${NC}"
        fi
    fi
else
    echo -e "${RED}✗ Failed to add review${NC}"
    echo -e "${YELLOW}Note: This may be expected if the API requires authentication${NC}"
fi

echo ""

# Test 4: Update helpful votes (PATCH)
if [ -n "$NEW_REVIEW_ID" ]; then
    echo -e "${BLUE}Test 4: Updating helpful votes count${NC}"
    echo "-------------------------------------------"
    echo "Request: PATCH ${REST_API_URL}/api/ProductReview/${NEW_REVIEW_ID}"
    
    PATCH_DATA='{"HelpfulVotes": 5}'
    
    PATCH_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X PATCH \
      "${REST_API_URL}/api/ProductReview/${NEW_REVIEW_ID}" \
      -H "Content-Type: application/json" \
      -d "$PATCH_DATA")
    
    HTTP_CODE=$(echo "$PATCH_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
    RESPONSE_BODY=$(echo "$PATCH_RESPONSE" | sed '/HTTP_CODE:/d')
    
    echo "HTTP Status: $HTTP_CODE"
    echo "Response: $RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"
    echo ""
    
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
        echo -e "${GREEN}✓ Successfully updated helpful votes${NC}"
    else
        echo -e "${RED}✗ Failed to update helpful votes${NC}"
        echo -e "${YELLOW}Note: PATCH may require authentication or special permissions${NC}"
    fi
    echo ""
fi

# Test 5: Test GraphQL query for reviews
echo -e "${BLUE}Test 5: Fetching reviews via GraphQL${NC}"
echo "-------------------------------------------"

GRAPHQL_URL="${API_URL%/api*}/graphql"
echo "Request: POST ${GRAPHQL_URL}"

GRAPHQL_QUERY=$(cat <<'EOF'
{
  "query": "query GetProductReviews($productId: Int!) { productReviews(filter: { ProductID: { eq: $productId } }) { items { ProductReviewID ProductID ReviewerName Rating Comments ReviewDate HelpfulVotes } } }",
  "variables": {
    "productId": 680
  }
}
EOF
)

echo "Query:"
echo "$GRAPHQL_QUERY" | jq '.'
echo ""

GRAPHQL_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
  "${GRAPHQL_URL}" \
  -H "Content-Type: application/json" \
  -d "$GRAPHQL_QUERY")

HTTP_CODE=$(echo "$GRAPHQL_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)
RESPONSE_BODY=$(echo "$GRAPHQL_RESPONSE" | sed '/HTTP_CODE:/d')

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
    REVIEW_COUNT=$(echo "$RESPONSE_BODY" | jq -r '.data.productReviews.items | length' 2>/dev/null || echo "0")
    echo -e "${GREEN}✓ GraphQL query successful (Reviews: $REVIEW_COUNT)${NC}"
else
    echo -e "${RED}✗ GraphQL query failed${NC}"
fi
echo ""

# Summary
echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}Test Summary${NC}"
echo -e "${BLUE}=========================================${NC}"
echo -e "${GREEN}Tests completed!${NC}"
echo ""
echo "Review the output above for detailed results."
echo "Some operations may require authentication or specific permissions."
echo ""
echo -e "${YELLOW}Note: To clean up test data, you may want to delete the test review${NC}"
if [ -n "$NEW_REVIEW_ID" ]; then
    echo "Review ID to delete: $NEW_REVIEW_ID"
    echo "DELETE command: curl -X DELETE \"${REST_API_URL}/api/ProductReview/${NEW_REVIEW_ID}\""
fi
