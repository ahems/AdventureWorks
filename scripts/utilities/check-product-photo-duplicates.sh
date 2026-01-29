#!/bin/bash

# Check for duplicate ProductProductPhoto entries in the database
# This script queries the Azure SQL database to find products with duplicate photo mappings

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Product Photo Duplicate Checker                       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Get environment variables
API_URL=$(azd env get-value "VITE_API_URL" 2>/dev/null || echo "")

if [ -z "$API_URL" ]; then
    echo -e "${RED}❌ Error: Could not get API URL from azd environment${NC}"
    exit 1
fi

# Remove /graphql/ from the end if present
REST_API_URL="${API_URL%/graphql/}/api"

echo -e "${GREEN}Using REST API:${NC} $REST_API_URL"
echo ""

# Check specific products mentioned in the test output
PRODUCTS_TO_CHECK=(707 709 845 777)

echo -e "${BLUE}Checking products: ${PRODUCTS_TO_CHECK[*]}${NC}"
echo ""

for PRODUCT_ID in "${PRODUCTS_TO_CHECK[@]}"; do
    echo -e "${YELLOW}Product ID: ${PRODUCT_ID}${NC}"
    
    # Query the ProductProductPhoto table for this product
    RESPONSE=$(curl -s "${REST_API_URL}/ProductProductPhoto?\$filter=ProductID eq ${PRODUCT_ID}")
    
    # Count the number of photo mappings
    PHOTO_COUNT=$(echo "$RESPONSE" | jq '.value | length')
    
    if [ "$PHOTO_COUNT" -gt 4 ]; then
        echo -e "${RED}  ⚠️  Found ${PHOTO_COUNT} photo mappings (expected ≤4)${NC}"
        
        # Show the photo IDs
        PHOTO_IDS=$(echo "$RESPONSE" | jq -r '.value[] | .ProductPhotoID' | sort -n | uniq)
        UNIQUE_COUNT=$(echo "$PHOTO_IDS" | wc -l)
        
        echo -e "  Photo IDs: $(echo $PHOTO_IDS | tr '\n' ' ')"
        echo -e "  Unique photo IDs: ${UNIQUE_COUNT}"
        
        # Check for duplicates
        TOTAL_MAPPINGS=$(echo "$RESPONSE" | jq '.value | length')
        if [ "$TOTAL_MAPPINGS" -ne "$UNIQUE_COUNT" ]; then
            echo -e "${RED}  ❌ DUPLICATES DETECTED!${NC}"
            echo -e "  Total mappings: ${TOTAL_MAPPINGS}"
            echo -e "  Unique photos: ${UNIQUE_COUNT}"
            echo -e "  Duplicate count: $((TOTAL_MAPPINGS - UNIQUE_COUNT))"
            
            # Show which photo IDs are duplicated
            echo "$RESPONSE" | jq -r '.value[] | .ProductPhotoID' | sort | uniq -c | awk '$1 > 1 {print "    Photo ID " $2 " appears " $1 " times"}'
        else
            echo -e "${GREEN}  ✓ No duplicates (all photo IDs are unique)${NC}"
        fi
    elif [ "$PHOTO_COUNT" -gt 0 ]; then
        echo -e "${GREEN}  ✓ Found ${PHOTO_COUNT} photo mappings (normal)${NC}"
    else
        echo -e "${YELLOW}  ℹ️  No photos found${NC}"
    fi
    echo ""
done

echo -e "${BLUE}Searching for ANY products with duplicate photo mappings...${NC}"
echo ""

# Get all ProductProductPhoto mappings
ALL_MAPPINGS=$(curl -s "${REST_API_URL}/ProductProductPhoto?\$top=1000")

# Find products with more than 4 photos
PRODUCTS_WITH_MANY_PHOTOS=$(echo "$ALL_MAPPINGS" | jq -r '.value | group_by(.ProductID) | .[] | select(length > 4) | {ProductID: .[0].ProductID, Count: length} | "\(.ProductID):\(.Count)"')

if [ -n "$PRODUCTS_WITH_MANY_PHOTOS" ]; then
    echo -e "${RED}Products with > 4 photo mappings:${NC}"
    echo "$PRODUCTS_WITH_MANY_PHOTOS" | while read line; do
        PROD_ID=$(echo $line | cut -d: -f1)
        COUNT=$(echo $line | cut -d: -f2)
        echo -e "  Product ${PROD_ID}: ${COUNT} mappings"
    done
else
    echo -e "${GREEN}✓ No products found with > 4 photo mappings${NC}"
fi

echo ""
echo -e "${BLUE}Checking for duplicate ProductPhotoID within same ProductID...${NC}"

# Find actual duplicates (same ProductID + ProductPhotoID combination)
DUPLICATES=$(echo "$ALL_MAPPINGS" | jq -r '.value | group_by(.ProductID) | .[] | 
    group_by(.ProductPhotoID) | .[] | 
    select(length > 1) | 
    {ProductID: .[0].ProductID, ProductPhotoID: .[0].ProductPhotoID, Count: length} | 
    "\(.ProductID):\(.ProductPhotoID):\(.Count)"')

if [ -n "$DUPLICATES" ]; then
    echo -e "${RED}❌ DUPLICATES FOUND:${NC}"
    echo "$DUPLICATES" | while read line; do
        PROD_ID=$(echo $line | cut -d: -f1)
        PHOTO_ID=$(echo $line | cut -d: -f2)
        COUNT=$(echo $line | cut -d: -f3)
        echo -e "  ${RED}Product ${PROD_ID} -> Photo ${PHOTO_ID}: ${COUNT} duplicate entries${NC}"
    done
    echo ""
    echo -e "${YELLOW}Recommendation: Clean up duplicate entries in Production.ProductProductPhoto table${NC}"
else
    echo -e "${GREEN}✓ No duplicate ProductID+ProductPhotoID combinations found${NC}"
fi

echo ""
echo -e "${GREEN}✅ Check complete!${NC}"
