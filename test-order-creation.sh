#!/bin/bash

# Test Order Creation via GraphQL API
# This tests creating a full order with order details and updating product inventory

API_URL="${API_URL:-http://localhost:5000/graphql}"

echo "Testing Order Creation Flow..."
echo "API URL: $API_URL"
echo ""

# Test data
CUSTOMER_ID=1
SHIP_TO_ADDRESS_ID=1086
BILL_TO_ADDRESS_ID=1086
SHIP_METHOD_ID=5
PRODUCT_ID=707  # Sport-100 Helmet, Red
ORDER_QTY=2
SPECIAL_OFFER_ID=1

# Step 1: Create SalesOrderHeader
echo "Step 1: Creating SalesOrderHeader..."
CREATE_ORDER_MUTATION=$(cat <<'EOF'
mutation CreateOrder {
  createSalesOrderHeader(
    item: {
      RevisionNumber: 1
      OrderDate: "2025-12-15T10:00:00Z"
      DueDate: "2025-12-22T10:00:00Z"
      ShipDate: "2025-12-16T10:00:00Z"
      Status: 1
      OnlineOrderFlag: true
      CustomerID: 1
      ShipToAddressID: 1086
      BillToAddressID: 1086
      ShipMethodID: 5
      SubTotal: 69.98
      TaxAmt: 5.60
      Freight: 8.99
      TotalDue: 84.57
    }
  ) {
    SalesOrderID
    OrderDate
    TotalDue
    Status
  }
}
EOF
)

ORDER_RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(echo "$CREATE_ORDER_MUTATION" | jq -Rs .)}")

echo "Response: $ORDER_RESPONSE"
SALES_ORDER_ID=$(echo "$ORDER_RESPONSE" | jq -r '.data.createSalesOrderHeader.SalesOrderID // empty')

if [ -z "$SALES_ORDER_ID" ]; then
  echo "❌ Failed to create SalesOrderHeader"
  echo "Error: $(echo "$ORDER_RESPONSE" | jq -r '.errors[0].message // "Unknown error"')"
  exit 1
fi

echo "✓ Created SalesOrderHeader with ID: $SALES_ORDER_ID"
echo ""

# Step 2: Get current product inventory
echo "Step 2: Checking current inventory for Product ID $PRODUCT_ID..."
GET_PRODUCT_QUERY=$(cat <<EOF
query GetProduct {
  products(filter: { ProductID: { eq: $PRODUCT_ID } }) {
    items {
      ProductID
      Name
      SafetyStockLevel
      ReorderPoint
    }
  }
}
EOF
)

PRODUCT_RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(echo "$GET_PRODUCT_QUERY" | jq -Rs .)}")

PRODUCT_NAME=$(echo "$PRODUCT_RESPONSE" | jq -r '.data.products.items[0].Name')
SAFETY_STOCK=$(echo "$PRODUCT_RESPONSE" | jq -r '.data.products.items[0].SafetyStockLevel')
REORDER_POINT=$(echo "$PRODUCT_RESPONSE" | jq -r '.data.products.items[0].ReorderPoint')

echo "Product: $PRODUCT_NAME"
echo "Current Safety Stock Level: $SAFETY_STOCK"
echo "Reorder Point: $REORDER_POINT"
echo ""

# Step 3: Create SalesOrderDetail
echo "Step 3: Creating SalesOrderDetail (Order Line Item)..."
CREATE_DETAIL_MUTATION=$(cat <<EOF
mutation CreateOrderDetail {
  createSalesOrderDetail(
    item: {
      SalesOrderID: $SALES_ORDER_ID
      OrderQty: $ORDER_QTY
      ProductID: $PRODUCT_ID
      SpecialOfferID: $SPECIAL_OFFER_ID
      UnitPrice: 34.99
      UnitPriceDiscount: 0.00
      LineTotal: 69.98
    }
  ) {
    SalesOrderID
    SalesOrderDetailID
    OrderQty
    ProductID
    UnitPrice
    LineTotal
  }
}
EOF
)

DETAIL_RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(echo "$CREATE_DETAIL_MUTATION" | jq -Rs .)}")

echo "Response: $DETAIL_RESPONSE"
DETAIL_ID=$(echo "$DETAIL_RESPONSE" | jq -r '.data.createSalesOrderDetail.SalesOrderDetailID // empty')

if [ -z "$DETAIL_ID" ]; then
  echo "❌ Failed to create SalesOrderDetail"
  echo "Error: $(echo "$DETAIL_RESPONSE" | jq -r '.errors[0].message // "Unknown error"')"
  exit 1
fi

echo "✓ Created SalesOrderDetail with ID: $DETAIL_ID"
echo ""

# Step 4: Update product inventory (decrement SafetyStockLevel)
NEW_STOCK=$((SAFETY_STOCK - ORDER_QTY))
echo "Step 4: Updating product inventory..."
echo "Decrementing SafetyStockLevel from $SAFETY_STOCK to $NEW_STOCK (qty ordered: $ORDER_QTY)"

UPDATE_PRODUCT_MUTATION=$(cat <<EOF
mutation UpdateProduct {
  updateProduct(
    ProductID: $PRODUCT_ID
    item: {
      SafetyStockLevel: $NEW_STOCK
    }
  ) {
    ProductID
    Name
    SafetyStockLevel
    ReorderPoint
  }
}
EOF
)

UPDATE_RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(echo "$UPDATE_PRODUCT_MUTATION" | jq -Rs .)}")

echo "Response: $UPDATE_RESPONSE"
UPDATED_STOCK=$(echo "$UPDATE_RESPONSE" | jq -r '.data.updateProduct.SafetyStockLevel // empty')

if [ -z "$UPDATED_STOCK" ]; then
  echo "❌ Failed to update product inventory"
  echo "Error: $(echo "$UPDATE_RESPONSE" | jq -r '.errors[0].message // "Unknown error"')"
  exit 1
fi

echo "✓ Updated SafetyStockLevel to: $UPDATED_STOCK"
echo ""

# Step 5: Delete cart items (if testing with ShoppingCartItem)
echo "Step 5: Simulating cart clearance (would delete ShoppingCartItems for this user)"
echo "Note: This would require knowing the ShoppingCartID and ShoppingCartItemID"
echo ""

echo "========================================="
echo "✓ Order Creation Test Complete!"
echo "========================================="
echo "Order ID: $SALES_ORDER_ID"
echo "Order Detail ID: $DETAIL_ID"
echo "Product: $PRODUCT_NAME (ID: $PRODUCT_ID)"
echo "Quantity Ordered: $ORDER_QTY"
echo "Stock Level: $SAFETY_STOCK → $UPDATED_STOCK"
echo "Total Due: \$84.57"
echo "========================================="
