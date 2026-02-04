#!/bin/bash

# Complete workflow: Generate reviews and create embeddings
# This script runs both operations in sequence

echo "🎭 Complete Product Review Workflow"
echo "===================================="
echo ""
echo "Step 1: Generate AI-powered reviews"
echo "Step 2: Create embeddings for searchability"
echo ""

# Determine the base URL
if [ -n "$FUNCTIONS_URL" ]; then
    # Use explicitly set FUNCTIONS_URL environment variable
    BASE_URL="$FUNCTIONS_URL"
elif [ -f ".azure/$(azd env get-values 2>/dev/null | grep AZURE_ENV_NAME | cut -d '=' -f2 | tr -d '"')/.env" ]; then
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
    BASE_URL="http://localhost:7071"
    echo "⚠️  Using local endpoint"
fi

echo "Using Functions endpoint: $BASE_URL"
echo ""

# Function to trigger and wait for orchestration
trigger_and_wait() {
    local FUNCTION_NAME=$1
    local STEP_NAME=$2
    
    echo "🚀 Starting: $STEP_NAME"
    echo ""
    
    RESPONSE=$(curl -s -X POST "$BASE_URL/api/$FUNCTION_NAME")
    STATUS_URL=$(echo "$RESPONSE" | grep -o '"statusQueryGetUri":"[^"]*"' | cut -d'"' -f4)
    
    if [ -z "$STATUS_URL" ]; then
        echo "❌ Failed to start $STEP_NAME"
        echo ""
        echo "Response from server:"
        echo "$RESPONSE"
        echo ""
        echo "💡 Troubleshooting tips:"
        echo "   • Check Azure Functions are deployed: azd env get-values | grep API_FUNCTIONS_URL"
        echo "   • View function logs in Azure Portal"
        echo "   • For local dev, ensure 'func start' is running in api-functions/"
        echo "   • See REVIEW_GENERATION_SCRIPTS.md for detailed troubleshooting"
        return 1
    fi
    
    echo "✅ Started successfully"
    echo "📊 Processing..."
    
    while true; do
        STATUS_RESPONSE=$(curl -s "$STATUS_URL")
        RUNTIME_STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"runtimeStatus":"[^"]*"' | cut -d'"' -f4)
        
        if [ "$RUNTIME_STATUS" = "Completed" ]; then
            echo ""
            OUTPUT=$(echo "$STATUS_RESPONSE" | grep -o '"output":"[^"]*"' | cut -d'"' -f4)
            echo "✅ $STEP_NAME completed!"
            echo "   $OUTPUT"
            echo ""
            return 0
        elif [ "$RUNTIME_STATUS" = "Failed" ]; then
            echo ""
            echo "❌ $STEP_NAME failed"
            echo "$STATUS_RESPONSE"
            return 1
        else
            echo -n "."
        fi
        
        sleep 5
    done
}

# Step 1: Generate reviews
trigger_and_wait "GenerateProductReviewsUsingAI_HttpStart" "Review Generation"

if [ $? -ne 0 ]; then
    echo "Workflow stopped due to error"
    exit 1
fi

echo "---"
echo ""

# Step 2: Generate embeddings
trigger_and_wait "GenerateProductReviewEmbeddings_HttpStart" "Embedding Generation"

if [ $? -ne 0 ]; then
    echo "Workflow stopped due to error"
    exit 1
fi

echo "=================================="
echo "🎉 Complete workflow finished!"
echo ""
echo "Your demo site now has:"
echo "  ✓ AI-generated product reviews"
echo "  ✓ Searchable review embeddings"
echo ""
echo "Reviews are ready to display on the site!"
