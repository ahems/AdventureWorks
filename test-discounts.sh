#!/bin/bash

API_URL="https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql/"

echo "Testing Special Offer Integration"
echo "=================================="
echo ""

# Test 1: Get Customer Special Offers
echo "Test 1: Fetching Customer Special Offers..."
OFFERS=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ specialOffers(filter: { Category: { eq: \"Customer\" } }) { items { SpecialOfferID Description DiscountPct Category } } }"}')

echo "$OFFERS" | jq -r '.data.specialOffers.items[] | "Offer \(.SpecialOfferID): \(.Description) - \(.DiscountPct * 100)% off"'
echo ""

# Extract offer IDs
OFFER_IDS=$(echo "$OFFERS" | jq -r '.data.specialOffers.items[].SpecialOfferID' | tr '\n' ',' | sed 's/,$//')
echo "Offer IDs: $OFFER_IDS"
echo ""

# Test 2: Get Products with Special Offers
echo "Test 2: Fetching Products with Customer Special Offers..."
PRODUCTS_WITH_OFFERS=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ specialOfferProducts(filter: { SpecialOfferID: { in: [$OFFER_IDS] } }) { items { SpecialOfferID ProductID } } }\"}")

echo "$PRODUCTS_WITH_OFFERS" | jq -r '.data.specialOfferProducts.items[] | "Product \(.ProductID) has Special Offer \(.SpecialOfferID)"'
echo ""

# Test 3: Verify product details for one discounted product
echo "Test 3: Fetching details for Product 928 (Mountain Tire - should have 50% off)..."
PRODUCT_928=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ products(filter: { ProductID: { eq: 928 } }) { items { ProductID Name ListPrice ProductNumber } } }"}')

echo "$PRODUCT_928" | jq '.data.products.items[0]'
echo ""

# Test 4: Verify product 935 (Pedal - should have 50% off)
echo "Test 4: Fetching details for Product 935 (Pedal - should have 50% off)..."
PRODUCT_935=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ products(filter: { ProductID: { eq: 935 } }) { items { ProductID Name ListPrice ProductNumber } } }"}')

echo "$PRODUCT_935" | jq '.data.products.items[0]'
echo ""

echo "=================================="
echo "Summary:"
echo "- Customer Special Offers: 2 (Mountain Tire Sale & Half-Price Pedal Sale)"
echo "- Products with discounts: Multiple products (928-930 for tires, 935-941 for pedals)"
echo "- Discount percentage: 50% off"
echo ""
echo "The app should now display these discounts automatically!"
echo "Visit: https://todoapp-app-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/"
