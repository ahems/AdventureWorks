#!/bin/bash

API_URL="https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql"
SHOPPING_CART_ID="test-user-123"

echo "Step 1: Get current cart items..."
GET_CART='{
  "query": "query { shoppingCartItems(filter: { ShoppingCartID: { eq: \"'${SHOPPING_CART_ID}'\" } }) { items { ShoppingCartItemID ProductID Quantity } } }"
}'

CART_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$GET_CART")
echo "$CART_RESPONSE" | jq .

echo -e "\nStep 2: Get current stock for Product 707..."
GET_STOCK='{
  "query": "query { products(filter: { ProductID: { eq: 707 } }) { items { ProductID Name SafetyStockLevel } } }"
}'

STOCK_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$GET_STOCK")
echo "$STOCK_RESPONSE" | jq .

CURRENT_STOCK=$(echo "$STOCK_RESPONSE" | jq -r '.data.products.items[0].SafetyStockLevel')
echo "Current SafetyStockLevel: $CURRENT_STOCK"

echo -e "\nStep 3: Update stock (decrement by 1)..."
NEW_STOCK=$((CURRENT_STOCK - 1))
UPDATE_STOCK='{
  "query": "mutation { updateProduct(ProductID: 707, item: { SafetyStockLevel: '${NEW_STOCK}' }) { ProductID SafetyStockLevel } }"
}'

curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$UPDATE_STOCK" | jq .

echo -e "\n✓ Stock update complete!"
