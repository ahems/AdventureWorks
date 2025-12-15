#!/bin/bash

API_URL="https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql"

# Simple test - create order header with minimal fields
echo "Creating minimal order..."

CREATE_ORDER='{
  "query": "mutation { createSalesOrderHeader(item: { RevisionNumber: 1, OrderDate: \"2025-12-15T10:00:00Z\", DueDate: \"2025-12-22T10:00:00Z\", Status: 1, OnlineOrderFlag: true, CustomerID: 30119, ShipToAddressID: 32523, ShipMethodID: 5, SubTotal: 44.49, TaxAmt: 3.56, Freight: 8.99 }) { SalesOrderID OrderDate SubTotal TaxAmt Freight } }"
}'

curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$CREATE_ORDER" | jq .
