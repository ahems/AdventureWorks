#!/bin/bash

# Test order creation using GraphQL mutations
API_URL="https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql"
PERSON_ID=20779
ADDRESS_ID=32523

echo "Testing Order Creation Flow..."
echo "================================"

# Step 1: Check if Customer exists
echo -e "\n1. Checking for Customer record..."
CUSTOMER_QUERY='{
  "query": "query { customers(filter: { PersonID: { eq: '${PERSON_ID}' } }) { items { CustomerID PersonID AccountNumber } } }"
}'

CUSTOMER_RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$CUSTOMER_QUERY")

echo "Customer Response: $CUSTOMER_RESPONSE"
CUSTOMER_ID=$(echo $CUSTOMER_RESPONSE | jq -r '.data.customers.items[0].CustomerID // empty')

if [ -z "$CUSTOMER_ID" ]; then
  echo "✗ No customer found for PersonID ${PERSON_ID}"
  echo "Creating Customer..."
  
  CREATE_CUSTOMER='{
    "query": "mutation { createCustomer(item: { PersonID: '${PERSON_ID}', TerritoryID: 1, AccountNumber: \"AW000'${PERSON_ID}'\" }) { CustomerID PersonID AccountNumber } }"
  }'
  
  CREATE_RESPONSE=$(curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -d "$CREATE_CUSTOMER")
  
  echo "Create Response: $CREATE_RESPONSE"
  CUSTOMER_ID=$(echo $CREATE_RESPONSE | jq -r '.data.createCustomer.CustomerID')
  echo "✓ Created Customer with ID: ${CUSTOMER_ID}"
else
  echo "✓ Found Customer ID: ${CUSTOMER_ID}"
fi

# Step 2: Create SalesOrderHeader
echo -e "\n2. Creating SalesOrderHeader..."
CREATE_ORDER='{
  "query": "mutation { createSalesOrderHeader(item: { RevisionNumber: 1, OrderDate: \"2025-12-15T10:00:00Z\", DueDate: \"2025-12-22T10:00:00Z\", Status: 5, OnlineOrderFlag: true, CustomerID: '${CUSTOMER_ID}', BillToAddressID: '${ADDRESS_ID}', ShipToAddressID: '${ADDRESS_ID}', ShipMethodID: 5, SubTotal: 44.49, TaxAmt: 3.56, Freight: 8.99, TotalDue: 57.04 }) { SalesOrderID OrderDate TotalDue } }"
}'

ORDER_RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$CREATE_ORDER")

echo "Order Response: $ORDER_RESPONSE"
SALES_ORDER_ID=$(echo $ORDER_RESPONSE | jq -r '.data.createSalesOrderHeader.SalesOrderID')

if [ -z "$SALES_ORDER_ID" ] || [ "$SALES_ORDER_ID" = "null" ]; then
  echo "✗ Failed to create order"
  exit 1
fi

echo "✓ Created SalesOrderHeader ID: ${SALES_ORDER_ID}"

# Step 3: Add Order Line Items
echo -e "\n3. Adding Order Line Items..."

# Item 1: Sport-100 Helmet (ProductID 707)
CREATE_DETAIL_1='{
  "query": "mutation { createSalesOrderDetail(item: { SalesOrderID: '${SALES_ORDER_ID}', SpecialOfferID: 1, OrderQty: 1, ProductID: 707, UnitPrice: 34.99, UnitPriceDiscount: 0, LineTotal: 34.99 }) { SalesOrderDetailID ProductID UnitPrice } }"
}'

DETAIL_RESPONSE_1=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$CREATE_DETAIL_1")

echo "Detail 1 Response: $DETAIL_RESPONSE_1"

# Item 2: Mountain Bike Socks (ProductID 709)
CREATE_DETAIL_2='{
  "query": "mutation { createSalesOrderDetail(item: { SalesOrderID: '${SALES_ORDER_ID}', SpecialOfferID: 1, OrderQty: 2, ProductID: 709, UnitPrice: 9.50, UnitPriceDiscount: 0, LineTotal: 19.00 }) { SalesOrderDetailID ProductID UnitPrice } }"
}'

DETAIL_RESPONSE_2=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$CREATE_DETAIL_2")

echo "Detail 2 Response: $DETAIL_RESPONSE_2"

# Step 4: Update Product Stock (decrement inventory)
echo -e "\n4. Updating Product Inventory..."

# Get current stock for Product 707
STOCK_QUERY_707='{
  "query": "query { products(filter: { ProductID: { eq: 707 } }) { items { ProductID SafetyStockLevel ReorderPoint } } }"
}'

STOCK_RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$STOCK_QUERY_707")

echo "Current stock for 707: $STOCK_RESPONSE"

CURRENT_STOCK=$(echo $STOCK_RESPONSE | jq -r '.data.products.items[0].SafetyStockLevel')
NEW_STOCK=$((CURRENT_STOCK - 1))

echo "Decrementing stock from $CURRENT_STOCK to $NEW_STOCK"

UPDATE_STOCK='{
  "query": "mutation { updateProduct(ProductID: 707, item: { SafetyStockLevel: '${NEW_STOCK}' }) { ProductID SafetyStockLevel } }"
}'

UPDATE_RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$UPDATE_STOCK")

echo "Update Response: $UPDATE_RESPONSE"

echo -e "\n✓ Order Creation Complete!"
echo "Order ID: ${SALES_ORDER_ID}"
echo "Total: $57.04"
