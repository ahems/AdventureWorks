#!/bin/bash
# Test semantic search with variant queries after embedding enhancement

set -e

# Get function URL from azd environment
FUNCTION_URL=$(azd env get-values 2>/dev/null | grep VITE_API_FUNCTIONS_URL | cut -d'=' -f2 | tr -d '"' || echo "")

if [ -z "$FUNCTION_URL" ]; then
    echo "❌ FUNCTION_URL not found in azd environment"
    echo "Using local URL instead..."
    FUNCTION_URL="http://localhost:7071"
fi

echo "🔍 Testing Semantic Search with Variant Queries"
echo "Using API: $FUNCTION_URL"
echo "================================================"
echo ""

# Test 1: Color-based search
echo "Test 1: Searching for 'red bikes'..."
echo "Expected: Should return bikes available in red color"
curl -s -X POST "$FUNCTION_URL/api/search/semantic" \
  -H "Content-Type: application/json" \
  -d '{"query": "red bikes", "topN": 5}' | jq -r '.results[] | "\(.Name) - \(.Color) - Score: \(.SimilarityScore)"' || echo "❌ Search failed"
echo ""

# Test 2: Size-based search  
echo "Test 2: Searching for 'large helmet'..."
echo "Expected: Should return helmets available in large size"
curl -s -X POST "$FUNCTION_URL/api/search/semantic" \
  -H "Content-Type: application/json" \
  -d '{"query": "large helmet", "topN": 5}' | jq -r '.results[] | "\(.Name) - Score: \(.SimilarityScore)"' || echo "❌ Search failed"
echo ""

# Test 3: Style-based search
echo "Test 3: Searching for \"women's mountain bike\"..."
echo "Expected: Should return mountain bikes with women's style"
curl -s -X POST "$FUNCTION_URL/api/search/semantic" \
  -H "Content-Type: application/json" \
  -d '{"query": "womens mountain bike", "topN": 5}' | jq -r '.results[] | "\(.Name) - Score: \(.SimilarityScore)"' || echo "❌ Search failed"
echo ""

# Test 4: Combined attributes
echo "Test 4: Searching for 'black touring bike'..."
echo "Expected: Should return touring bikes available in black"
curl -s -X POST "$FUNCTION_URL/api/search/semantic" \
  -H "Content-Type: application/json" \
  -d '{"query": "black touring bike", "topN": 5}' | jq -r '.results[] | "\(.Name) - \(.Color) - Score: \(.SimilarityScore)"' || echo "❌ Search failed"
echo ""

# Test 5: Size and color
echo "Test 5: Searching for 'small red jersey'..."
echo "Expected: Should return jerseys that are small and red"
curl -s -X POST "$FUNCTION_URL/api/search/semantic" \
  -H "Content-Type: application/json" \
  -d '{"query": "small red jersey", "topN": 5}' | jq -r '.results[] | "\(.Name) - Score: \(.SimilarityScore)"' || echo "❌ Search failed"
echo ""

echo "================================================"
echo "✅ Search tests completed!"
echo ""
echo "💡 Tips:"
echo "- If results seem poor, ensure embeddings have been regenerated"
echo "- Check that DescriptionEmbedding column is not NULL in database"
echo "- Regenerate embeddings using: curl -X POST \"$FUNCTION_URL/api/GenerateProductEmbeddings_HttpStart\""
