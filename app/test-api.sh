#!/bin/bash

# Test script to verify GraphQL API integration

echo "Testing GraphQL API..."
echo "API URL: ${VITE_API_URL:-https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql}"
echo ""

# Test 1: Get Categories
echo "Test 1: Fetching Product Categories..."
curl -s -X POST "${VITE_API_URL:-https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql}" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ productCategories { items { ProductCategoryID Name } } }"}' \
  --max-time 10 | jq '.' || echo "Failed to fetch categories"

echo ""

# Test 2: Get Products
echo "Test 2: Fetching Products (first 5)..."
curl -s -X POST "${VITE_API_URL:-https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql}" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ products(first: 5) { items { ProductID Name ListPrice } } }"}' \
  --max-time 10 | jq '.' || echo "Failed to fetch products"

echo ""
echo "Testing complete!"
