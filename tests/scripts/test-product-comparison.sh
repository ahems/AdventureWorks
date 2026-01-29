#!/bin/bash

# Test script for product comparison functionality (anonymous users)
# Tests the GraphQL API endpoints used by the compare feature
# Usage: ./test-product-comparison.sh

set -e

# Get the API URL from environment or use default
API_URL="${API_URL:-https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql/}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 Testing Product Comparison Functionality (Anonymous Users)"
echo "================================================================"
echo "API URL: $API_URL"
echo ""

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0

# Helper function to run GraphQL query
run_query() {
    local query=$1
    local description=$2
    
    echo "📡 Testing: $description"
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        -d "{\"query\":$(echo "$query" | jq -Rs .)}")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)
    
    if [ "$HTTP_CODE" = "200" ]; then
        # Check if response has errors
        if echo "$BODY" | jq -e '.errors' > /dev/null 2>&1; then
            echo -e "${RED}❌ FAILED${NC} - GraphQL errors:"
            echo "$BODY" | jq '.errors'
            TESTS_FAILED=$((TESTS_FAILED + 1))
            return 1
        else
            echo -e "${GREEN}✅ PASSED${NC}"
            TESTS_PASSED=$((TESTS_PASSED + 1))
            return 0
        fi
    else
        echo -e "${RED}❌ FAILED${NC} - HTTP $HTTP_CODE"
        echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

# Test 1: Fetch products suitable for comparison (bikes from same category)
echo "📋 Test 1: Fetch Bike Products for Comparison"
echo "---------------------------------------------"
QUERY1='query {
  products(first: 10, filter: { ProductSubcategoryID: { eq: 1 } }) {
    items {
      ProductID
      Name
      ProductNumber
      ListPrice
      Color
      Size
      Weight
      ProductSubcategoryID
    }
  }
}'

if run_query "$QUERY1" "Fetch products from Mountain Bikes subcategory"; then
    PRODUCTS=$(echo "$BODY" | jq -c '.data.products.items[0:3]')
    PRODUCT_IDS=$(echo "$PRODUCTS" | jq -r '.[].ProductID')
    
    echo ""
    echo "Selected products for comparison:"
    echo "$PRODUCTS" | jq -r '.[] | "  • ID: \(.ProductID) - \(.Name) - $\(.ListPrice)"'
    
    # Save first 3 product IDs for subsequent tests
    PRODUCT_ID_1=$(echo "$PRODUCTS" | jq -r '.[0].ProductID')
    PRODUCT_ID_2=$(echo "$PRODUCTS" | jq -r '.[1].ProductID')
    PRODUCT_ID_3=$(echo "$PRODUCTS" | jq -r '.[2].ProductID')
else
    echo -e "${RED}Cannot proceed with comparison tests${NC}"
    exit 1
fi

echo ""

# Test 2: Fetch detailed info for first product
echo "📋 Test 2: Fetch Detailed Product Information"
echo "---------------------------------------------"
QUERY2="query {
  products(filter: { ProductID: { eq: $PRODUCT_ID_1 } }) {
    items {
      ProductID
      Name
      ProductNumber
      Color
      ListPrice
      Size
      Weight
      SellStartDate
      SellEndDate
      ProductSubcategoryID
      StandardCost
    }
  }
}"

run_query "$QUERY2" "Fetch detailed info for Product ID $PRODUCT_ID_1"
if [ $? -eq 0 ]; then
    echo ""
    echo "Product details:"
    echo "$BODY" | jq '.data.products.items[0]'
fi

echo ""

# Test 3: Fetch reviews for comparison products
echo "📋 Test 3: Fetch Product Reviews for Comparison"
echo "-----------------------------------------------"
QUERY3="query {
  productReviews(
    filter: {
      or: [
        { ProductID: { eq: $PRODUCT_ID_1 } }
        { ProductID: { eq: $PRODUCT_ID_2 } }
        { ProductID: { eq: $PRODUCT_ID_3 } }
      ]
    }
  ) {
    items {
      ProductReviewID
      ProductID
      ReviewerName
      Rating
      Comments
      ReviewDate
    }
  }
}"

run_query "$QUERY3" "Fetch reviews for all comparison products"
if [ $? -eq 0 ]; then
    echo ""
    echo "Review summary:"
    for PID in $PRODUCT_ID_1 $PRODUCT_ID_2 $PRODUCT_ID_3; do
        REVIEW_COUNT=$(echo "$BODY" | jq "[.data.productReviews.items[] | select(.ProductID == $PID)] | length")
        AVG_RATING=$(echo "$BODY" | jq "[.data.productReviews.items[] | select(.ProductID == $PID).Rating] | if length > 0 then (add / length) else 0 end")
        echo "  Product $PID: $REVIEW_COUNT reviews, Avg rating: $AVG_RATING"
    done
fi

echo ""

# Test 4: Fetch product photos for comparison
echo "📋 Test 4: Fetch Product Photos for Comparison"
echo "----------------------------------------------"
QUERY4="query {
  productProductPhotos(
    filter: {
      or: [
        { ProductID: { eq: $PRODUCT_ID_1 } }
        { ProductID: { eq: $PRODUCT_ID_2 } }
        { ProductID: { eq: $PRODUCT_ID_3 } }
      ]
    }
  ) {
    items {
      ProductID
      ProductPhotoID
      Primary
    }
  }
}"

run_query "$QUERY4" "Fetch photos for comparison products"
if [ $? -eq 0 ]; then
    echo ""
    echo "Photo availability:"
    for PID in $PRODUCT_ID_1 $PRODUCT_ID_2 $PRODUCT_ID_3; do
        PHOTO_COUNT=$(echo "$BODY" | jq "[.data.productProductPhotos.items[] | select(.ProductID == $PID)] | length")
        echo "  Product $PID: $PHOTO_COUNT photos available"
    done
fi

echo ""

# Test 5: Check product availability/inventory
echo "📋 Test 5: Check Product Inventory for Comparison"
echo "-------------------------------------------------"
QUERY5="query {
  productInventories(
    filter: {
      or: [
        { ProductID: { eq: $PRODUCT_ID_1 } }
        { ProductID: { eq: $PRODUCT_ID_2 } }
        { ProductID: { eq: $PRODUCT_ID_3 } }
      ]
    }
  ) {
    items {
      ProductID
      LocationID
      Quantity
      Bin
    }
  }
}"

run_query "$QUERY5" "Check inventory for comparison products"
if [ $? -eq 0 ]; then
    echo ""
    echo "Inventory summary:"
    for PID in $PRODUCT_ID_1 $PRODUCT_ID_2 $PRODUCT_ID_3; do
        TOTAL_QTY=$(echo "$BODY" | jq "[.data.productInventories.items[] | select(.ProductID == $PID).Quantity] | add // 0")
        LOCATION_COUNT=$(echo "$BODY" | jq "[.data.productInventories.items[] | select(.ProductID == $PID)] | length")
        echo "  Product $PID: $TOTAL_QTY total units across $LOCATION_COUNT locations"
    done
fi

echo ""

# Test 6: Test comparison limit (should support up to 3 products)
echo "📋 Test 6: Verify Comparison Supports Multiple Products"
echo "-------------------------------------------------------"
QUERY6="query {
  products(first: 4, filter: { ProductSubcategoryID: { eq: 2 } }) {
    items {
      ProductID
      Name
      ListPrice
    }
  }
}"

run_query "$QUERY6" "Fetch 4 products to test comparison limit"
if [ $? -eq 0 ]; then
    echo ""
    PRODUCT_COUNT=$(echo "$BODY" | jq '.data.products.items | length')
    echo "Fetched $PRODUCT_COUNT products"
    echo -e "${YELLOW}ℹ Note: Frontend enforces max 3 products in comparison${NC}"
fi

echo ""

# Test 7: Fetch products with special offers for comparison
echo "📋 Test 7: Fetch Special Offers"
echo "-------------------------------"
QUERY7='query {
  specialOffers(
    filter: {
      and: [
        { DiscountPct: { gt: 0 } }
        { Category: { neq: null } }
      ]
    }
    first: 5
  ) {
    items {
      SpecialOfferID
      Description
      DiscountPct
      Type
      Category
      StartDate
      EndDate
    }
  }
}'

run_query "$QUERY7" "Fetch active special offers"
if [ $? -eq 0 ]; then
    echo ""
    echo "Active special offers:"
    echo "$BODY" | jq -r '.data.specialOffers.items[] | "  • \(.Description): \(.DiscountPct * 100)% off"'
    
    # Get products associated with these offers
    OFFER_IDS=$(echo "$BODY" | jq -r '.data.specialOffers.items[].SpecialOfferID' | head -3 | paste -sd "," -)
    if [ -n "$OFFER_IDS" ]; then
        echo ""
        echo "Fetching products with these offers..."
        QUERY7B="query {
          specialOfferProducts(filter: { SpecialOfferID: { in: [$OFFER_IDS] } }) {
            items {
              SpecialOfferID
              ProductID
            }
          }
        }"
        
        RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
            -H "Content-Type: application/json" \
            -d "{\"query\":$(echo "$QUERY7B" | jq -Rs .)}")
        
        HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)
        BODY2=$(echo "$RESPONSE" | head -n -1)
        
        if [ "$HTTP_CODE" = "200" ]; then
            PRODUCT_COUNT=$(echo "$BODY2" | jq '.data.specialOfferProducts.items | length')
            echo "Found $PRODUCT_COUNT products with special offers"
        fi
    fi
fi

echo ""

# Test 8: Query products from different categories (edge case)
echo "📋 Test 8: Fetch Products Across Different Categories"
echo "------------------------------------------------------"
QUERY8='query {
  bikes: products(first: 1, filter: { ProductSubcategoryID: { eq: 1 } }) {
    items {
      ProductID
      Name
      ProductSubcategoryID
    }
  }
  clothing: products(first: 1, filter: { ProductSubcategoryID: { eq: 17 } }) {
    items {
      ProductID
      Name
      ProductSubcategoryID
    }
  }
  accessories: products(first: 1, filter: { ProductSubcategoryID: { eq: 29 } }) {
    items {
      ProductID
      Name
      ProductSubcategoryID
    }
  }
}'

run_query "$QUERY8" "Fetch products from different categories"
if [ $? -eq 0 ]; then
    echo ""
    echo -e "${YELLOW}ℹ Note: Users can compare products across categories${NC}"
    echo ""
    echo "Cross-category comparison example:"
    echo "$BODY" | jq -r '(.data.bikes.items[0] // empty | "  • Bike: \(.Name)"), 
                          (.data.clothing.items[0] // empty | "  • Clothing: \(.Name)"), 
                          (.data.accessories.items[0] // empty | "  • Accessory: \(.Name)")'
fi

echo ""
echo "================================================================"
echo "📊 Test Summary"
echo "================================================================"
echo -e "${GREEN}Tests Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Tests Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All product comparison tests passed!${NC}"
    echo ""
    echo "Key Features Verified:"
    echo "  ✓ Anonymous users can fetch products for comparison"
    echo "  ✓ Product details, reviews, photos, and inventory are accessible"
    echo "  ✓ Products can be compared across different categories"
    echo "  ✓ Discount information is available for comparison"
    echo "  ✓ Multiple products can be queried simultaneously"
    exit 0
else
    echo -e "${RED}❌ Some tests failed${NC}"
    exit 1
fi
