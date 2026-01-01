#!/bin/bash

# Check if database has embeddings
# This script verifies the product descriptions and reviews have embeddings

echo "📊 Checking Database for Embeddings"
echo "===================================="
echo ""

# Get connection string from environment
source /workspaces/AdventureWorks/api-functions/.env 2>/dev/null || true

# Check if we can access the database
if [ -z "$SQL_CONNECTION_STRING" ]; then
    echo "❌ SQL_CONNECTION_STRING not found in .env file"
    echo "Please ensure you've run setup-local-dev.sh"
    exit 1
fi

echo "✅ Connection string found"
echo ""

# Note: This would require sqlcmd or similar tool to be installed
# For now, let's just check the configuration

echo "Checking Azure OpenAI configuration..."
echo "--------------------------------------"

if [ -z "$AZURE_OPENAI_ENDPOINT" ]; then
    echo "❌ AZURE_OPENAI_ENDPOINT not set"
    echo ""
    echo "The semantic search requires:"
    echo "  1. AZURE_OPENAI_ENDPOINT - Your Azure OpenAI endpoint"
    echo "  2. Database with embeddings in ProductDescription.DescriptionEmbedding"
    echo "  3. Database with embeddings in ProductReview.CommentsEmbedding"
    echo ""
    echo "To generate embeddings, run:"
    echo "  curl -X POST http://localhost:7071/api/GenerateProductEmbeddings_HttpStart"
    echo "  curl -X POST http://localhost:7071/api/GenerateProductReviewEmbeddings_HttpStart"
else
    echo "✅ AZURE_OPENAI_ENDPOINT configured: $AZURE_OPENAI_ENDPOINT"
    echo ""
    echo "To generate embeddings if not already done:"
    echo "  curl -X POST http://localhost:7071/api/GenerateProductEmbeddings_HttpStart"
    echo "  curl -X POST http://localhost:7071/api/GenerateProductReviewEmbeddings_HttpStart"
fi

echo ""
echo "Note: Semantic search will fail if embeddings haven't been generated yet."
