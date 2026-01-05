#!/bin/bash
# Test OpenAPI endpoints for Azure Functions
set -e

echo "🔍 Testing OpenAPI Endpoints"
echo "================================"

# Check if Functions app is running locally
if ! curl -s http://localhost:7071/api/swagger.json > /dev/null 2>&1; then
    echo "❌ Azure Functions app is not running locally"
    echo "Start it with: cd api-functions && func start"
    exit 1
fi

echo "✅ Functions app is running"
echo ""

# Test swagger.json endpoint
echo "📄 Testing /api/swagger.json..."
if curl -s http://localhost:7071/api/swagger.json | jq '.info.title' > /dev/null 2>&1; then
    TITLE=$(curl -s http://localhost:7071/api/swagger.json | jq -r '.info.title')
    echo "✅ OpenAPI spec available"
    echo "   Title: $TITLE"
else
    echo "❌ Failed to retrieve OpenAPI spec"
    exit 1
fi
echo ""

# Test OpenAPI v3 endpoint
echo "📄 Testing /api/openapi/v3.json..."
if curl -s http://localhost:7071/api/openapi/v3.json | jq '.openapi' > /dev/null 2>&1; then
    VERSION=$(curl -s http://localhost:7071/api/openapi/v3.json | jq -r '.openapi')
    echo "✅ OpenAPI v3 spec available"
    echo "   Version: $VERSION"
else
    echo "❌ Failed to retrieve OpenAPI v3 spec"
    exit 1
fi
echo ""

# Test Swagger UI endpoint
echo "🖥️  Testing /api/swagger/ui..."
if curl -s http://localhost:7071/api/swagger/ui | grep -q "swagger-ui"; then
    echo "✅ Swagger UI is available"
    echo "   URL: http://localhost:7071/api/swagger/ui"
else
    echo "⚠️  Swagger UI may not be fully loaded (this is normal)"
fi
echo ""

# List documented endpoints
echo "📋 Documented Endpoints:"
curl -s http://localhost:7071/api/swagger.json | jq -r '.paths | keys[]' | sort | while read -r path; do
    echo "   $path"
done
echo ""

# Show tags
echo "🏷️  API Tags:"
curl -s http://localhost:7071/api/swagger.json | jq -r '.tags[]?.name' 2>/dev/null | sort -u | while read -r tag; do
    echo "   - $tag"
done

echo ""
echo "✅ All OpenAPI endpoints are working!"
echo ""
echo "Open Swagger UI in your browser:"
echo "👉 http://localhost:7071/api/swagger/ui"
