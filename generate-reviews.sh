#!/bin/bash

# Script to generate product reviews using AI
# This will create 0-10 reviews per product with varied sentiment

echo "🎭 Generating AI-powered product reviews..."
echo ""

# Determine the base URL
if [ -n "$FUNCTIONS_URL" ]; then
    # Use explicitly set FUNCTIONS_URL environment variable
    BASE_URL="$FUNCTIONS_URL"
elif command -v azd &> /dev/null; then
    # Try to get from azd environment (deployed to Azure)
    API_FUNCTIONS_URL=$(azd env get-values 2>/dev/null | grep "^API_FUNCTIONS_URL=" | cut -d '=' -f2 | tr -d '"')
    if [ -n "$API_FUNCTIONS_URL" ]; then
        BASE_URL="$API_FUNCTIONS_URL"
        echo "✨ Using deployed Azure Functions"
    else
        BASE_URL="http://localhost:7071"
        echo "⚠️  No Azure deployment found, using local endpoint"
    fi
else
    # Default to local development
    BASE_URL="http://localhost:7071"
    echo "⚠️  Using local endpoint"
fi

echo "Using Functions endpoint: $BASE_URL"
echo ""

# Trigger the review generation orchestration
RESPONSE=$(curl -s -X POST "$BASE_URL/api/GenerateProductReviewsUsingAI_HttpStart")

# Extract the statusQueryGetUri from the response
STATUS_URL=$(echo "$RESPONSE" | grep -o '"statusQueryGetUri":"[^"]*"' | cut -d'"' -f4)

if [ -z "$STATUS_URL" ]; then
    echo "❌ Failed to start orchestration"
    echo "$RESPONSE"
    exit 1
fi

echo "✅ Orchestration started successfully!"
echo ""
echo "Instance ID: $(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)"
echo ""
echo "Status URL: $STATUS_URL"
echo ""
echo "📊 Polling for completion (this may take several minutes)..."
echo ""

# Poll the status endpoint until completion
while true; do
    STATUS_RESPONSE=$(curl -s "$STATUS_URL")
    RUNTIME_STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"runtimeStatus":"[^"]*"' | cut -d'"' -f4)
    
    if [ "$RUNTIME_STATUS" = "Completed" ]; then
        echo ""
        echo "✅ Review generation completed!"
        echo ""
        OUTPUT=$(echo "$STATUS_RESPONSE" | grep -o '"output":"[^"]*"' | cut -d'"' -f4)
        echo "Result: $OUTPUT"
        echo ""
        echo "🎉 Reviews have been generated and saved to the database!"
        echo "💡 Next step: Run GenerateProductReviewEmbeddings to create embeddings for search"
        break
    elif [ "$RUNTIME_STATUS" = "Failed" ]; then
        echo ""
        echo "❌ Review generation failed"
        echo "$STATUS_RESPONSE"
        exit 1
    elif [ "$RUNTIME_STATUS" = "Running" ]; then
        echo -n "."
    else
        echo "Status: $RUNTIME_STATUS"
    fi
    
    sleep 5
done
