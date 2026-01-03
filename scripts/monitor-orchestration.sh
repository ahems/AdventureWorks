#!/bin/bash

STATUS_URL="$1"
INSTANCE_ID="$2"

if [ -z "$STATUS_URL" ]; then
    echo "Error: Status URL required"
    exit 1
fi

echo "============================================"
echo "Monitoring Orchestration: $INSTANCE_ID"
echo "============================================"
echo ""

poll_count=0
max_polls=300  # 5 minutes with 1 second intervals

while [ $poll_count -lt $max_polls ]; do
    response=$(curl -s "$STATUS_URL")
    
    # Extract key fields using jq
    runtime_status=$(echo "$response" | jq -r '.runtimeStatus // empty')
    created_time=$(echo "$response" | jq -r '.createdTime // empty')
    last_updated=$(echo "$response" | jq -r '.lastUpdatedTime // empty')
    output=$(echo "$response" | jq -r '.output // empty')
    
    # Clear line and print status
    echo -ne "\r\033[K"  # Clear line
    echo -ne "[$poll_count] Status: $runtime_status | Last Updated: $last_updated"
    
    # Check if completed
    if [ "$runtime_status" = "Completed" ]; then
        echo ""
        echo ""
        echo "✅ ORCHESTRATION COMPLETED SUCCESSFULLY!"
        echo ""
        echo "Result: $output"
        echo ""
        echo "Full Response:"
        echo "$response" | jq '.'
        exit 0
    fi
    
    # Check if failed
    if [ "$runtime_status" = "Failed" ]; then
        echo ""
        echo ""
        echo "❌ ORCHESTRATION FAILED!"
        echo ""
        echo "Full Response:"
        echo "$response" | jq '.'
        exit 1
    fi
    
    # Check if terminated or suspended
    if [ "$runtime_status" = "Terminated" ] || [ "$runtime_status" = "Suspended" ]; then
        echo ""
        echo ""
        echo "⚠️  ORCHESTRATION $runtime_status"
        echo ""
        echo "Full Response:"
        echo "$response" | jq '.'
        exit 1
    fi
    
    # Wait before next poll
    sleep 1
    poll_count=$((poll_count + 1))
done

echo ""
echo ""
echo "⏱️  Timeout reached after $max_polls seconds"
echo "Last known status: $runtime_status"
echo ""
echo "You can check status manually at:"
echo "$STATUS_URL"
