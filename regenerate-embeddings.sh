#!/bin/bash
# Quick script to regenerate product embeddings with variant information

set -e

echo "🔄 Regenerating Product Embeddings with Variant Information"
echo "============================================================"
echo ""

# Get function URL
FUNCTION_URL=$(azd env get-values 2>/dev/null | grep VITE_API_FUNCTIONS_URL | cut -d'=' -f2 | tr -d '"' || echo "")

if [ -z "$FUNCTION_URL" ]; then
    echo "❌ FUNCTION_URL not found"
    echo "Make sure you've deployed with 'azd deploy'"
    exit 1
fi

echo "📍 Function URL: $FUNCTION_URL"
echo ""

# Step 1: Clear existing embeddings via SQL
echo "Step 1: Clear existing embeddings"
echo "Please run this SQL script manually in your database:"
echo "  scripts/clear-product-embeddings.sql"
echo ""
read -p "Press Enter once you've cleared the embeddings..."
echo ""

# Step 2: Trigger embedding generation
echo "Step 2: Triggering embedding generation..."
RESPONSE=$(curl -s -X POST "$FUNCTION_URL/api/GenerateProductEmbeddings_HttpStart")

if [ $? -eq 0 ]; then
    echo "✅ Embedding generation started!"
    echo ""
    echo "Response:"
    echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    echo ""
    
    # Extract status query URL
    STATUS_URL=$(echo "$RESPONSE" | jq -r '.statusQueryGetUri' 2>/dev/null)
    
    if [ -n "$STATUS_URL" ] && [ "$STATUS_URL" != "null" ]; then
        echo "📊 Monitor progress at:"
        echo "$STATUS_URL"
        echo ""
        echo "Or run: curl -s '$STATUS_URL' | jq '.'"
    fi
else
    echo "❌ Failed to trigger embedding generation"
    exit 1
fi

echo ""
echo "⏰ Embedding generation is running in the background"
echo "This process typically takes 5-10 minutes for all products"
echo ""
echo "💡 Next steps:"
echo "1. Wait for generation to complete"
echo "2. Test search with: ./test-variant-search.sh"
echo "3. Verify results in your application"
