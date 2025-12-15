#!/bin/bash

API_URL="https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql"

echo "Step 1: Creating SalesOrderHeader..."
CREATE_ORDER='{
  "query": "mutation { createSalesOrderHeader(item: { RevisionNumber: 1, OrderDate: \"2025-12-15T10:00:00Z\", DueDate: \"2025-12-22T10:00:00Z\", Status: 1, OnlineOrderFlag: true, CustomerID: 30119, BillToAddressID: 32523, ShipToAddressID: 32523, ShipMethodID: 5, SubTotal: 44.49, TaxAmt: 3.56, Freight: 8.99 }) { SalesOrderID OrderDate SubTotal TaxAmt Freight } }"
}'

ORDER_RESPONSE=$(curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$CREATE_ORDER")
echo "$ORDER_RESPONSE" | jq .

SALES_ORDER_ID=$(echo "$ORDER_RESPONSE" | jq -r '.data.createSalesOrderHeader.SalesOrderID')

if [ "$SALES_ORDER_ID" != "null" ] && [ -n "$SALES_ORDER_ID" ]; then
  echo -e "\n✓ Created Order ID: $SALES_ORDER_ID"
  
  echo -e "\nStep 2: Adding line item (Product 707 - Helmet)..."
  CREATE_DETAIL='{
    "query": "mutation { createSalesOrderDetail(item: { SalesOrderID: '${SALES_ORDER_ID}', SpecialOfferID: 1, OrderQty: 1, ProductID: 707, UnitPrice: 34.99, UnitPriceDiscount: 0 }) { SalesOrderDetailID ProductID OrderQty UnitPrice } }"
  }'
  
  curl -s -X POST "$API_URL" -H "Content-Type: application/json" -d "$CREATE_DETAIL" | jq .
  
  echo -e "\n✓ Order creation complete!"
else
  echo "✗ Failed to create order"
fi
