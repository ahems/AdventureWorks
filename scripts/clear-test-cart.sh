#!/bin/bash

# Script to clear shopping cart items for testing
# This removes all items from the shopping cart for BusinessEntityID 20791

set -e

# API endpoint
API_URL="${API_URL:-https://av-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io}"

echo "=========================================="
echo "Clearing Shopping Cart via API"
echo "=========================================="
echo ""
echo "API URL: $API_URL"
echo "User: adamhems@yahoo.com (BusinessEntityID: 20791)"
echo ""

# Shopping cart ID is the BusinessEntityID as a string
SHOPPING_CART_ID="20791"

# Get all cart items for this user
echo "Fetching cart items..."
CART_ITEMS=$(curl -s "$API_URL/graphql" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"{ shoppingCartItems(filter: { ShoppingCartID: { eq: \\\"$SHOPPING_CART_ID\\\" } }) { items { ShoppingCartItemID ProductID Quantity } } }\"}")

# Extract cart item IDs
ITEM_IDS=$(echo "$CART_ITEMS" | jq -r '.data.shoppingCartItems.items[].ShoppingCartItemID' 2>/dev/null)

if [ -z "$ITEM_IDS" ]; then
    echo "Cart is already empty or could not fetch items."
    exit 0
fi

# Delete each item
echo "Deleting cart items..."
for ITEM_ID in $ITEM_IDS; do
    echo "  Deleting item $ITEM_ID..."
    HTTP_CODE=$(curl -s -w "%{http_code}" -X DELETE \
        "$API_URL/api/ShoppingCartItem/ShoppingCartItemID/$ITEM_ID" \
        -o /dev/null)
    
    if [ "$HTTP_CODE" -eq 204 ] || [ "$HTTP_CODE" -eq 200 ]; then
        echo "  ✓ Deleted item $ITEM_ID"
    else
        echo "  ✗ Failed to delete item $ITEM_ID (HTTP $HTTP_CODE)"
    fi
done

echo ""
echo "=========================================="
echo "Shopping cart cleared!"
echo "=========================================="
echo ""
