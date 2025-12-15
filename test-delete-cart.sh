#!/bin/bash

API_URL="https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql"

# First, let's add a test item to the cart
echo "Creating test cart item..."
CREATE_CART='{
  "query": "mutation { createShoppingCartItem(item: { ShoppingCartID: \"test-checkout-123\", ProductID: 707, Quantity: 2 }) { ShoppingCartItemID ShoppingCartID ProductID Quantity } }"
}'

CREATE_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$CREATE_CART")
echo "$CREATE_RESPONSE" | jq .

CART_ITEM_ID=$(echo "$CREATE_RESPONSE" | jq -r '.data.createShoppingCartItem.ShoppingCartItemID')
echo "Created cart item ID: $CART_ITEM_ID"

echo -e "\nDeleting cart item..."
DELETE_CART='{
  "query": "mutation { deleteShoppingCartItem(ShoppingCartItemID: '${CART_ITEM_ID}') { ShoppingCartItemID } }"
}'

curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$DELETE_CART" | jq .

echo -e "\n✓ Cart item deleted!"
