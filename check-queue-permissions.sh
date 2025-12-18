#!/bin/bash

# Get the managed identity principal ID
IDENTITY_NAME="av-identity-$(echo $AZURE_RESOURCE_GROUP | md5sum | cut -c1-13)"
PRINCIPAL_ID=$(az identity show --name $IDENTITY_NAME --resource-group $AZURE_RESOURCE_GROUP --query principalId -o tsv)

# Get the storage account name
STORAGE_ACCOUNT="avstorage$(echo $AZURE_RESOURCE_GROUP | md5sum | cut -c1-13)"

echo "Checking role assignments for managed identity: $IDENTITY_NAME"
echo "Principal ID: $PRINCIPAL_ID"
echo "Storage Account: $STORAGE_ACCOUNT"
echo ""

# Check role assignments on the storage account
az role assignment list --assignee $PRINCIPAL_ID --scope "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$AZURE_RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/$STORAGE_ACCOUNT" --output table

echo ""
echo "Required roles for queue triggers:"
echo "- Storage Queue Data Contributor (or Storage Queue Data Message Processor)"
