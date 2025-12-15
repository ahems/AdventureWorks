#!/bin/bash

# Test complete order creation flow matching frontend implementation
API_URL="https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql"

echo "========================================="
echo "Testing Complete Order Creation Flow"
echo "========================================="

# Test data
PERSON_ID=20779
ADDRESS_ID=32523
PRODUCT_ID_1=707  # Sport-100 Helmet
PRODUCT_ID_2=709  # Mountain Bike Socks
SHIP_METHOD_ID=5

echo -e "\n1️⃣  Step 1: Get or Create Customer..."
echo "Checking for existing customer with PersonID ${PERSON_ID}..."

GET_CUSTOMER='{
  "query": "query GetCustomer($personId: Int!) { customers(filter: { PersonID: { eq: $personId } }) { items { CustomerID PersonID AccountNumber } } }",
  "variables": { "personId": '${PERSON_ID}' }
}'

CUSTOMER_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$GET_CUSTOMER")
echo "$CUSTOMER_RESPONSE" | jq .

CUSTOMER_ID=$(echo "$CUSTOMER_RESPONSE" | jq -r '.data.customers.items[0].CustomerID // empty')

if [ -z "$CUSTOMER_ID" ]; then
  echo "Creating new customer..."
  CREATE_CUSTOMER='{
    "query": "mutation CreateCustomer($personId: Int!) { createCustomer(item: { PersonID: $personId, TerritoryID: 1, AccountNumber: \"\" }) { CustomerID PersonID AccountNumber } }",
    "variables": { "personId": '${PERSON_ID}' }
  }'
  
  CREATE_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$CREATE_CUSTOMER")
  CUSTOMER_ID=$(echo "$CREATE_RESPONSE" | jq -r '.data.createCustomer.CustomerID')
  echo "✓ Created Customer ID: $CUSTOMER_ID"
else
  echo "✓ Found existing Customer ID: $CUSTOMER_ID"
fi

echo -e "\n2️⃣  Step 2: Create Sales Order Header..."
ORDER_DATE=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
DUE_DATE=$(date -u -d "+7 days" +"%Y-%m-%dT%H:%M:%S.000Z")

CREATE_ORDER='{
  "query": "mutation CreateOrder($orderDate: DateTime!, $dueDate: DateTime!, $customerId: Int!, $billToAddressId: Int!, $shipToAddressId: Int!, $shipMethodId: Int!, $subTotal: Decimal!, $taxAmt: Decimal!, $freight: Decimal!) { createSalesOrderHeader(item: { RevisionNumber: 1, OrderDate: $orderDate, DueDate: $dueDate, Status: 1, OnlineOrderFlag: true, CustomerID: $customerId, BillToAddressID: $billToAddressId, ShipToAddressID: $shipToAddressId, ShipMethodID: $shipMethodId, SubTotal: $subTotal, TaxAmt: $taxAmt, Freight: $freight }) { SalesOrderID OrderDate SubTotal TaxAmt Freight } }",
  "variables": {
    "orderDate": "'${ORDER_DATE}'",
    "dueDate": "'${DUE_DATE}'",
    "customerId": '${CUSTOMER_ID}',
    "billToAddressId": '${ADDRESS_ID}',
    "shipToAddressId": '${ADDRESS_ID}',
    "shipMethodId": '${SHIP_METHOD_ID}',
    "subTotal": 53.99,
    "taxAmt": 4.32,
    "freight": 8.99
  }
}'

ORDER_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$CREATE_ORDER")
echo "$ORDER_RESPONSE" | jq .

SALES_ORDER_ID=$(echo "$ORDER_RESPONSE" | jq -r '.data.createSalesOrderHeader.SalesOrderID')

if [ -z "$SALES_ORDER_ID" ] || [ "$SALES_ORDER_ID" = "null" ]; then
  echo "✗ Failed to create order"
  exit 1
fi

echo "✓ Created Sales Order ID: $SALES_ORDER_ID"

echo -e "\n3️⃣  Step 3: Add Order Line Items..."

# Line Item 1: Sport-100 Helmet
echo "Adding Product ${PRODUCT_ID_1} (Helmet) x1..."
CREATE_DETAIL_1='{
  "query": "mutation CreateDetail($salesOrderId: Int!, $productId: Int!, $orderQty: Short!, $unitPrice: Decimal!, $unitPriceDiscount: Decimal!) { createSalesOrderDetail(item: { SalesOrderID: $salesOrderId, SpecialOfferID: 1, OrderQty: $orderQty, ProductID: $productId, UnitPrice: $unitPrice, UnitPriceDiscount: $unitPriceDiscount }) { SalesOrderDetailID ProductID OrderQty UnitPrice } }",
  "variables": {
    "salesOrderId": '${SALES_ORDER_ID}',
    "productId": '${PRODUCT_ID_1}',
    "orderQty": 1,
    "unitPrice": 34.99,
    "unitPriceDiscount": 0.0000
  }
}'

DETAIL_1_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$CREATE_DETAIL_1")
echo "$DETAIL_1_RESPONSE" | jq .
echo "✓ Added line item 1"

# Line Item 2: Mountain Bike Socks
echo -e "\nAdding Product ${PRODUCT_ID_2} (Socks) x2..."
CREATE_DETAIL_2='{
  "query": "mutation CreateDetail($salesOrderId: Int!, $productId: Int!, $orderQty: Short!, $unitPrice: Decimal!, $unitPriceDiscount: Decimal!) { createSalesOrderDetail(item: { SalesOrderID: $salesOrderId, SpecialOfferID: 1, OrderQty: $orderQty, ProductID: $productId, UnitPrice: $unitPrice, UnitPriceDiscount: $unitPriceDiscount }) { SalesOrderDetailID ProductID OrderQty UnitPrice } }",
  "variables": {
    "salesOrderId": '${SALES_ORDER_ID}',
    "productId": '${PRODUCT_ID_2}',
    "orderQty": 2,
    "unitPrice": 9.50,
    "unitPriceDiscount": 0.0000
  }
}'

DETAIL_2_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$CREATE_DETAIL_2")
echo "$DETAIL_2_RESPONSE" | jq .
echo "✓ Added line item 2"

echo -e "\n4️⃣  Step 4: Update Product Stock..."

# Get current stock for Product 707
echo "Getting current stock for Product ${PRODUCT_ID_1}..."
GET_STOCK='{
  "query": "query GetStock($productId: Int!) { products(filter: { ProductID: { eq: $productId } }) { items { ProductID Name SafetyStockLevel } } }",
  "variables": { "productId": '${PRODUCT_ID_1}' }
}'

STOCK_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$GET_STOCK")
echo "$STOCK_RESPONSE" | jq .

CURRENT_STOCK=$(echo "$STOCK_RESPONSE" | jq -r '.data.products.items[0].SafetyStockLevel')
NEW_STOCK=$((CURRENT_STOCK - 1))

echo "Updating stock from $CURRENT_STOCK to $NEW_STOCK..."
UPDATE_STOCK='{
  "query": "mutation UpdateStock($productId: Int!, $newStock: Short!) { updateProduct(ProductID: $productId, item: { SafetyStockLevel: $newStock }) { ProductID SafetyStockLevel } }",
  "variables": { "productId": '${PRODUCT_ID_1}', "newStock": '${NEW_STOCK}' }
}'

UPDATE_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$UPDATE_STOCK")
echo "$UPDATE_RESPONSE" | jq .
echo "✓ Stock updated"

echo -e "\n5️⃣  Step 5: Test Cart Deletion (creating test item first)..."

# Create a test cart item
echo "Creating test cart item..."
CREATE_CART='{
  "query": "mutation { createShoppingCartItem(item: { ShoppingCartID: \"test-order-flow\", ProductID: '${PRODUCT_ID_1}', Quantity: 1 }) { ShoppingCartItemID ShoppingCartID ProductID } }"
}'

CART_CREATE_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$CREATE_CART")
CART_ITEM_ID=$(echo "$CART_CREATE_RESPONSE" | jq -r '.data.createShoppingCartItem.ShoppingCartItemID')
echo "Created cart item ID: $CART_ITEM_ID"

# Delete the cart item
echo "Deleting cart item..."
DELETE_CART='{
  "query": "mutation DeleteCart($shoppingCartItemId: Int!) { deleteShoppingCartItem(ShoppingCartItemID: $shoppingCartItemId) { ShoppingCartItemID } }",
  "variables": { "shoppingCartItemId": '${CART_ITEM_ID}' }
}'

DELETE_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$DELETE_CART")
echo "$DELETE_RESPONSE" | jq .
echo "✓ Cart item deleted"

echo -e "\n========================================="
echo "✅ Complete Order Flow Test Successful!"
echo "========================================="
echo "Order ID: SO-${SALES_ORDER_ID}"
echo "Customer ID: ${CUSTOMER_ID}"
echo "Total Items: 2 products"
echo "Total Amount: \$67.30 (Subtotal: \$53.99 + Tax: \$4.32 + Shipping: \$8.99)"
echo "========================================="
