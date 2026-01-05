#!/bin/bash
# Test Swashbuckle-based OpenAPI and Swagger UI

echo "Testing Swashbuckle OpenAPI endpoints..."
echo ""

# Wait for Functions to start
sleep 5

BASE_URL="http://localhost:7071"

echo "1. Testing OpenAPI spec endpoint..."
curl -s "$BASE_URL/api/openapi.json" | head -n 20
echo ""
echo ""

echo "2. Testing Swagger UI endpoint..."
curl -s "$BASE_URL/api/swagger/ui" | grep -o "<title>.*</title>"
echo ""
echo ""

echo "3. Open Swagger UI in browser:"
echo "   $BASE_URL/api/swagger/ui"
echo ""

echo "4. View OpenAPI JSON:"
echo "   $BASE_URL/api/openapi.json"
echo ""
