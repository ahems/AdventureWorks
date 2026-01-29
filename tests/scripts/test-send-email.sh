#!/bin/bash

# Test script for sending emails to customers via Azure Communication Services
# This demonstrates the SendCustomerEmail function

# Get the Functions API URL from azd environment
FUNCTION_URL=$(azd env get-values | grep "VITE_API_FUNCTIONS_URL" | cut -d'=' -f2 | tr -d '"')

if [ -z "$FUNCTION_URL" ]; then
    echo "Error: API_FUNCTIONS_URL not found in azd environment"
    echo "Run 'azd provision' first to deploy the infrastructure"
    exit 1
fi

# Example 1: Send a simple email without attachment
# Customer 1 typically has EmailAddressID 1 (orlando0@adventure-works.com)
echo "Example 1: Sending email to customer 1..."
curl -X POST "${FUNCTION_URL}/api/customers/30119/send-email" \
  -H "Content-Type: application/json" \
  -d '{
    "emailAddressId": 19973,
    "subject": "Welcome to AdventureWorks!",
    "content": "Thank you for being a valued customer. We appreciate your business!"
  }'

echo -e "\n\n"

# Example 2: Send email with an attachment (e.g., order receipt)
echo "Example 2: Sending email with attachment..."
STORAGE_ACCOUNT=$(azd env get-values | grep "STORAGE_ACCOUNT_NAME" | cut -d'=' -f2 | tr -d '"')
RECEIPT_URL="https://${STORAGE_ACCOUNT}.blob.core.windows.net/CustomerReceipts/SO75125.pdf"

curl -X POST "${FUNCTION_URL}/api/customers/30119/send-email" \
  -H "Content-Type: application/json" \
  -d "{
    \"emailAddressId\": 19973,
    \"subject\": \"Your Order Receipt\",
    \"content\": \"Thank you for your order! Please find your receipt attached.\",
    \"attachmentUrl\": \"${RECEIPT_URL}\"
  }"

echo -e "\n\nDone!"
