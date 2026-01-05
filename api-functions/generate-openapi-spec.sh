#!/bin/bash
# Generate OpenAPI specification from local Azure Functions
# This creates openapi-spec.json that will be deployed to Azure

set -e

echo "📝 Generating OpenAPI Specification"
echo "===================================="
echo ""

cd /workspaces/AdventureWorks/api-functions

# Check if functions are running
if ! curl -s http://localhost:7071/api/swagger.json > /dev/null 2>&1; then
    echo "❌ Functions are not running locally"
    echo ""
    echo "Please start the functions first:"
    echo "  cd api-functions"
    echo "  func start"
    echo ""
    echo "Then run this script again in another terminal"
    exit 1
fi

echo "✅ Functions are running locally"
echo ""

# Download OpenAPI spec
echo "📥 Downloading OpenAPI specification..."
curl -s http://localhost:7071/api/swagger.json > openapi-spec.json

if [ $? -eq 0 ] && [ -s openapi-spec.json ]; then
    echo "✅ OpenAPI spec saved to: api-functions/openapi-spec.json"
    
    # Pretty print first few lines
    echo ""
    echo "Preview:"
    cat openapi-spec.json | jq '.info' 2>/dev/null || echo "{ spec downloaded but jq not available for preview }"
    
    echo ""
    echo "📊 Stats:"
    echo "  File size: $(wc -c < openapi-spec.json) bytes"
    echo "  Endpoints: $(cat openapi-spec.json | jq '.paths | length' 2>/dev/null || echo 'N/A')"
    
    echo ""
    echo "✅ Done! Now deploy to Azure:"
    echo "  azd deploy api-functions"
    echo ""
    echo "After deployment, access at:"
    echo "  https://your-function-url/api/swagger/ui"
else
    echo "❌ Failed to download OpenAPI spec"
    exit 1
fi
