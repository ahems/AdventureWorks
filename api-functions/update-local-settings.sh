#!/bin/bash
# Script to update local.settings.json with actual Azure resource values

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_SETTINGS_FILE="$SCRIPT_DIR/local.settings.json"

echo "Updating local.settings.json with Azure resource values..."

# Get storage account name from azd environment
STORAGE_ACCOUNT_NAME=$(azd env get-values | grep STORAGE_ACCOUNT_NAME | cut -d= -f2 | tr -d '"')

if [ -z "$STORAGE_ACCOUNT_NAME" ]; then
    echo "ERROR: STORAGE_ACCOUNT_NAME not found in azd environment"
    echo "Please run 'azd provision' first to create the storage account"
    exit 1
fi

echo "Found storage account: $STORAGE_ACCOUNT_NAME"

# Update local.settings.json
sed -i.bak "s|<STORAGE_ACCOUNT_NAME>|${STORAGE_ACCOUNT_NAME}|g" "$LOCAL_SETTINGS_FILE"

# Remove backup file
rm -f "${LOCAL_SETTINGS_FILE}.bak"

echo "✓ local.settings.json updated successfully"
echo ""
echo "Storage account: $STORAGE_ACCOUNT_NAME"
echo ""
echo "You can now run the Functions locally with: func start"
