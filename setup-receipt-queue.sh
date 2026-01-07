#!/bin/bash

# Script to manually create the order-receipt-generation queue and set up permissions
# Run this if you get "Queue does not exist" errors

echo "=========================================="
echo "Receipt Queue Setup Script"
echo "=========================================="
echo ""

# Get Azure environment values
echo "Getting Azure environment values from azd..."
STORAGE_ACCOUNT=$(azd env get-values | grep AZURE_STORAGE_ACCOUNT_NAME | cut -d'=' -f2 | tr -d '"')
RESOURCE_GROUP=$(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d'=' -f2 | tr -d '"')
FUNCTION_APP_NAME=$(azd env get-values | grep AZURE_FUNCTION_APP_NAME | cut -d'=' -f2 | tr -d '"')

if [ -z "$STORAGE_ACCOUNT" ]; then
    echo "❌ Could not find AZURE_STORAGE_ACCOUNT_NAME in azd environment"
    echo "Please run 'azd up' first to deploy the infrastructure"
    exit 1
fi

echo "Storage Account: $STORAGE_ACCOUNT"
echo "Resource Group: $RESOURCE_GROUP"
echo "Function App: $FUNCTION_APP_NAME"
echo ""

# Create the queue
echo "Step 1: Creating queue 'order-receipt-generation'..."
az storage queue create \
    --name "order-receipt-generation" \
    --account-name "$STORAGE_ACCOUNT" \
    --auth-mode login

if [ $? -eq 0 ]; then
    echo "✅ Queue created successfully"
else
    echo "❌ Failed to create queue"
    exit 1
fi

echo ""
echo "Step 2: Getting Function App's Managed Identity..."

# Get the Function App's principal ID
PRINCIPAL_ID=$(az functionapp identity show \
    --name "$FUNCTION_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query principalId -o tsv)

if [ -z "$PRINCIPAL_ID" ]; then
    echo "⚠️  No Managed Identity found for Function App"
    echo "Creating system-assigned managed identity..."
    
    PRINCIPAL_ID=$(az functionapp identity assign \
        --name "$FUNCTION_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --query principalId -o tsv)
    
    echo "✅ Managed Identity created: $PRINCIPAL_ID"
else
    echo "✅ Found Managed Identity: $PRINCIPAL_ID"
fi

echo ""
echo "Step 3: Assigning 'Storage Queue Data Contributor' role..."

# Get Storage Account ID
STORAGE_ID=$(az storage account show \
    --name "$STORAGE_ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --query id -o tsv)

# Assign role
az role assignment create \
    --assignee "$PRINCIPAL_ID" \
    --role "Storage Queue Data Contributor" \
    --scope "$STORAGE_ID"

if [ $? -eq 0 ]; then
    echo "✅ Role assigned successfully"
else
    echo "⚠️  Role assignment may have failed (might already exist)"
fi

echo ""
echo "Step 4: Verifying setup..."

# Check if queue exists
QUEUE_EXISTS=$(az storage queue exists \
    --name "order-receipt-generation" \
    --account-name "$STORAGE_ACCOUNT" \
    --auth-mode login \
    --query exists -o tsv)

if [ "$QUEUE_EXISTS" = "true" ]; then
    echo "✅ Queue 'order-receipt-generation' exists and is accessible"
else
    echo "❌ Queue verification failed"
    exit 1
fi

echo ""
echo "=========================================="
echo "✅ Setup Complete!"
echo "=========================================="
echo ""
echo "The receipt generation function should now work."
echo "Test it with:"
echo ""
echo "FUNCTION_URL=\$(azd env get-values | grep FUNCTION_URL | cut -d'=' -f2 | tr -d '\"')"
echo "curl -X POST \"\$FUNCTION_URL/api/GenerateOrderReceipts_HttpStart\" \\"
echo "  -H \"Content-Type: application/json\" \\"
echo "  -d '{\"salesOrderNumbers\": [\"SO75125\"]}'"
echo ""
