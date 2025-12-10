#!/bin/bash

API_URL="https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/api"
CUSTOMER_ID=30120

# Create Order 1: Sport-100 Helmet & Mountain Bike Socks
echo "Creating Order 1 (Helmet & Socks)..."

ORDER_1=$(curl -s -X POST "${API_URL}/SalesOrderHeader" \
  -H "Content-Type: application/json" \
  -d '{
    "RevisionNumber": 1,
    "OrderDate": "2025-11-15T10:30:00Z",
    "DueDate": "2025-11-22T10:30:00Z",
    "ShipDate": "2025-11-16T10:30:00Z",
    "Status": 5,
    "OnlineOrderFlag": true,
    "CustomerID": '${CUSTOMER_ID}',
    "BillToAddressID": 985,
    "ShipToAddressID": 985,
    "ShipMethodID": 5,
    "SubTotal": 44.49,
    "TaxAmt": 3.56,
    "Freight": 8.99,
    "TotalDue": 57.04
  }')

SALES_ORDER_ID_1=$(echo $ORDER_1 | jq -r '.value[0].SalesOrderID')
echo "Created SalesOrderHeader ID: $SALES_ORDER_ID_1"

# Add line items for Order 1
curl -s -X POST "${API_URL}/SalesOrderDetail" \
  -H "Content-Type: application/json" \
  -d '{
    "SalesOrderID": '${SALES_ORDER_ID_1}',
    "SpecialOfferID": 1,
    "OrderQty": 1,
    "ProductID": 707,
    "UnitPrice": 34.99,
    "UnitPriceDiscount": 0,
    "LineTotal": 34.99
  }' > /dev/null

curl -s -X POST "${API_URL}/SalesOrderDetail" \
  -H "Content-Type: application/json" \
  -d '{
    "SalesOrderID": '${SALES_ORDER_ID_1}',
    "SpecialOfferID": 1,
    "OrderQty": 1,
    "ProductID": 709,
    "UnitPrice": 9.50,
    "UnitPriceDiscount": 0,
    "LineTotal": 9.50
  }' > /dev/null

echo "✓ Order 1 created: Sport-100 Helmet ($34.99) + Mountain Bike Socks ($9.50)"

# Create Order 2: HL Road Frame
echo ""
echo "Creating Order 2 (Road Frame)..."

ORDER_2=$(curl -s -X POST "${API_URL}/SalesOrderHeader" \
  -H "Content-Type: application/json" \
  -d '{
    "RevisionNumber": 1,
    "OrderDate": "2025-12-01T14:20:00Z",
    "DueDate": "2025-12-08T14:20:00Z",
    "ShipDate": "2025-12-02T14:20:00Z",
    "Status": 5,
    "OnlineOrderFlag": true,
    "CustomerID": '${CUSTOMER_ID}',
    "BillToAddressID": 985,
    "ShipToAddressID": 985,
    "ShipMethodID": 5,
    "SubTotal": 1431.50,
    "TaxAmt": 114.52,
    "Freight": 14.99,
    "TotalDue": 1561.01
  }')

SALES_ORDER_ID_2=$(echo $ORDER_2 | jq -r '.value[0].SalesOrderID')
echo "Created SalesOrderHeader ID: $SALES_ORDER_ID_2"

# Add line items for Order 2
curl -s -X POST "${API_URL}/SalesOrderDetail" \
  -H "Content-Type: application/json" \
  -d '{
    "SalesOrderID": '${SALES_ORDER_ID_2}',
    "SpecialOfferID": 1,
    "OrderQty": 1,
    "ProductID": 680,
    "UnitPrice": 1431.50,
    "UnitPriceDiscount": 0,
    "LineTotal": 1431.50
  }' > /dev/null

echo "✓ Order 2 created: HL Road Frame - Black, 58 ($1,431.50)"

# Create Order 3: Multiple items
echo ""
echo "Creating Order 3 (Mixed order)..."

ORDER_3=$(curl -s -X POST "${API_URL}/SalesOrderHeader" \
  -H "Content-Type: application/json" \
  -d '{
    "RevisionNumber": 1,
    "OrderDate": "2025-12-08T09:15:00Z",
    "DueDate": "2025-12-15T09:15:00Z",
    "Status": 1,
    "OnlineOrderFlag": true,
    "CustomerID": '${CUSTOMER_ID}',
    "BillToAddressID": 985,
    "ShipToAddressID": 985,
    "ShipMethodID": 5,
    "SubTotal": 79.48,
    "TaxAmt": 6.36,
    "Freight": 8.99,
    "TotalDue": 94.83,
    "Comment": "Pending order - awaiting payment"
  }')

SALES_ORDER_ID_3=$(echo $ORDER_3 | jq -r '.value[0].SalesOrderID')
echo "Created SalesOrderHeader ID: $SALES_ORDER_ID_3"

# Add line items for Order 3
curl -s -X POST "${API_URL}/SalesOrderDetail" \
  -H "Content-Type: application/json" \
  -d '{
    "SalesOrderID": '${SALES_ORDER_ID_3}',
    "SpecialOfferID": 1,
    "OrderQty": 2,
    "ProductID": 707,
    "UnitPrice": 34.99,
    "UnitPriceDiscount": 0,
    "LineTotal": 69.98
  }' > /dev/null

curl -s -X POST "${API_URL}/SalesOrderDetail" \
  -H "Content-Type: application/json" \
  -d '{
    "SalesOrderID": '${SALES_ORDER_ID_3}',
    "SpecialOfferID": 1,
    "OrderQty": 1,
    "ProductID": 709,
    "UnitPrice": 9.50,
    "UnitPriceDiscount": 0,
    "LineTotal": 9.50
  }' > /dev/null

echo "✓ Order 3 created: 2x Sport-100 Helmet + 1x Mountain Bike Socks (Pending)"

echo ""
echo "================================"
echo "Summary:"
echo "================================"
echo "Order 1 (SalesOrderID: $SALES_ORDER_ID_1) - \$57.04 - Shipped (Status: 5)"
echo "Order 2 (SalesOrderID: $SALES_ORDER_ID_2) - \$1,561.01 - Shipped (Status: 5)"
echo "Order 3 (SalesOrderID: $SALES_ORDER_ID_3) - \$94.83 - Pending (Status: 1)"
echo ""
echo "Total: \$1,712.88"
