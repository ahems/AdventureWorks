#!/bin/bash

# Script to insert test shopping cart items for user testing via REST API
# This adds 3 products to the shopping cart for BusinessEntityID 20791 (adamhems@yahoo.com)

set -e

# API endpoint
API_URL="${API_URL:-https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io}"

echo "=========================================="
echo "Inserting Test Shopping Cart Items via API"
echo "=========================================="
echo ""
echo "API URL: $API_URL"
echo "User: adamhems@yahoo.com (BusinessEntityID: 20791)"
echo ""

# Shopping cart ID is the BusinessEntityID as a string
SHOPPING_CART_ID="20791"

# Function to insert a cart item
insert_cart_item() {
    local PRODUCT_ID=$1
    local QUANTITY=$2
    local PRODUCT_NAME=$3
    
    echo "Adding $PRODUCT_NAME (ProductID: $PRODUCT_ID, Quantity: $QUANTITY)..."
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
        "$API_URL/api/ShoppingCartItem" \
        -H "Content-Type: application/json" \
        -d "{
            \"ShoppingCartID\": \"$SHOPPING_CART_ID\",
            \"ProductID\": $PRODUCT_ID,
            \"Quantity\": $QUANTITY
        }")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" -eq 201 ] || [ "$HTTP_CODE" -eq 200 ]; then
        echo "✓ Successfully added $PRODUCT_NAME"
        echo ""
    else
        echo "✗ Failed to add $PRODUCT_NAME (HTTP $HTTP_CODE)"
        echo "Response: $BODY"
        echo ""
    fi
}

# Product 1: Sport-100 Helmet, Red (regular price, in stock)
# ProductID: 707, ListPrice: $34.99, Quantity: 1
insert_cart_item 707 1 "Sport-100 Helmet, Red"

# Product 2: HL Road Frame - Black, 58 (regular price, in stock)
# ProductID: 680, ListPrice: $1,431.50, Quantity: 1
insert_cart_item 680 1 "HL Road Frame - Black, 58"

# Product 3: HL Mountain Tire (ON SALE - 50% off via SpecialOfferID 4)
# ProductID: 930, ListPrice: $35.00, Sale Price: $17.50 (50% discount)
insert_cart_item 930 2 "HL Mountain Tire (ON SALE)"

echo "=========================================="
echo "Verifying cart contents via API..."
echo "=========================================="
echo ""

# Query the cart items using GraphQL
CART_RESPONSE=$(curl -s "$API_URL/graphql" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"{ shoppingCartItems(filter: { ShoppingCartID: { eq: \\\"$SHOPPING_CART_ID\\\" } }) { items { ShoppingCartItemID ProductID Quantity } } }\"}")

# Display cart summary
echo "Cart contents:"
if command -v jq &> /dev/null; then
    echo "$CART_RESPONSE" | jq -r '.data.shoppingCartItems.items[] | "  • ProductID \(.ProductID) - Qty: \(.Quantity)"'
else
    echo "$CART_RESPONSE"
fi

echo ""
echo "=========================================="
echo "Shopping cart setup complete!"
echo "=========================================="
echo ""
echo "Test cart should contain:"
echo "  1. Sport-100 Helmet, Red (\$34.99) x 1"
echo "  2. HL Road Frame - Black, 58 (\$1,431.50) x 1"  
echo "  3. HL Mountain Tire (\$35.00 -> \$17.50 with 50% discount) x 2"
echo ""
echo "You can now test the shopping cart in the app!"
echo ""
