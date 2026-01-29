#!/bin/bash

# Test script to manually enqueue an email with attachment
# This tests step 3 of the flow: Email queue trigger → Send email with PDF attachment

set -e

echo "Testing email sending with PDF attachment..."
echo ""

# Queue message that simulates what the receipt generation function creates
QUEUE_MESSAGE='{
  "SalesOrderNumber": "SO75134",
  "CustomerId": 30119,
  "EmailAddressId": 19974,
  "SalesOrderId": 75134
}'

# Get Azure Storage details from environment
STORAGE_ACCOUNT=$(grep "AzureWebJobsStorage__accountName" api-functions/local.settings.json | cut -d'"' -f4)
QUEUE_NAME="order-email-generation"

echo "Storage Account: $STORAGE_ACCOUNT"
echo "Queue Name: $QUEUE_NAME"
echo "Message: $QUEUE_MESSAGE"
echo ""

# Create queue and send message using Azure CLI
echo "Creating queue if it doesn't exist..."
az storage queue create \
  --name "$QUEUE_NAME" \
  --account-name "$STORAGE_ACCOUNT" \
  --auth-mode login

echo ""
echo "Sending message to queue (Base64 encoded)..."
# Base64 encode the message to match Azure Functions expectations
ENCODED_MESSAGE=$(echo -n "$QUEUE_MESSAGE" | base64 -w 0)
az storage message put \
  --queue-name "$QUEUE_NAME" \
  --account-name "$STORAGE_ACCOUNT" \
  --content "$ENCODED_MESSAGE" \
  --auth-mode login

echo ""
echo "✅ Message sent to queue!"
echo "The SendOrderEmail_QueueTrigger function should process it shortly."
echo "Check the Functions console logs for details."
echo ""
echo "Expected blob URL: https://$STORAGE_ACCOUNT.blob.core.windows.net/adventureworks-receipts/CustomerReceipts/SO75134.pdf"
