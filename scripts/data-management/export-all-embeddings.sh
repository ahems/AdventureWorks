#!/bin/bash
# Export all embeddings from Azure SQL Database to CSV files compatible with VECTOR columns
# This script exports both ProductDescription and ProductReview embeddings

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "================================================"
echo "Exporting embeddings from Azure SQL to CSV"
echo "================================================"
echo ""

# Check if node is available
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

# Check if mssql package is installed
if ! node -e "require('mssql')" 2>/dev/null; then
    echo "Installing mssql package..."
    cd "$SCRIPT_DIR/.." && npm install mssql
fi

# Get Azure SQL connection details from azd environment
echo "Fetching Azure SQL connection details..."
eval $(azd env get-values | grep -E "^(SQL_SERVER_NAME|SQL_DATABASE_NAME|SQL_ADMIN_USER|SQL_ADMIN_PASSWORD)=")

# Check if SQL authentication is configured
if [ -z "$SQL_ADMIN_USER" ] || [ -z "$SQL_ADMIN_PASSWORD" ]; then
    echo ""
    echo "SQL authentication not configured in azd environment."
    echo "Fetching credentials from Azure SQL Server..."
    echo ""
    
    # Get resource group
    RESOURCE_GROUP=$(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d'=' -f2 | tr -d '"')
    
    echo "Server: $SQL_SERVER_NAME"
    echo "Resource Group: $RESOURCE_GROUP"
    echo ""
    
    # Fetch the SQL Server administrator login name
    SQL_ADMIN_USER=$(az sql server show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$SQL_SERVER_NAME" \
        --query "administratorLogin" \
        --output tsv)
    
    if [ -z "$SQL_ADMIN_USER" ]; then
        echo "Error: Could not fetch SQL admin username from Azure"
        exit 1
    fi
    
    echo "✓ Found SQL admin user: $SQL_ADMIN_USER"
    
    # Check if password is stored in Azure Key Vault or needs to be provided
    # Since we can't retrieve the password from Azure, prompt for it or check other sources
    echo ""
    echo "Note: Azure SQL Server password cannot be retrieved from Azure."
    echo "Checking for password in deployment outputs or Key Vault..."
    
    # Try to get password from Key Vault if available
    KEY_VAULT_NAME=$(azd env get-values | grep AZURE_KEY_VAULT_NAME | cut -d'=' -f2 | tr -d '"')
    
    if [ -n "$KEY_VAULT_NAME" ]; then
        echo "Checking Key Vault: $KEY_VAULT_NAME"
        SQL_ADMIN_PASSWORD=$(az keyvault secret show \
            --vault-name "$KEY_VAULT_NAME" \
            --name "sql-admin-password" \
            --query "value" \
            --output tsv 2>/dev/null)
        
        if [ -n "$SQL_ADMIN_PASSWORD" ]; then
            echo "✓ Retrieved password from Key Vault"
        fi
    fi
    
    # If still no password, prompt user
    if [ -z "$SQL_ADMIN_PASSWORD" ]; then
        echo ""
        echo "Please enter the SQL Server administrator password:"
        read -s SQL_ADMIN_PASSWORD
        echo ""
        
        if [ -z "$SQL_ADMIN_PASSWORD" ]; then
            echo "Error: Password is required"
            exit 1
        fi
    fi
    
    # Store credentials in azd environment for future use
    echo "Storing credentials in azd environment..."
    azd env set SQL_ADMIN_USER "$SQL_ADMIN_USER"
    azd env set SQL_ADMIN_PASSWORD "$SQL_ADMIN_PASSWORD"
    echo "✓ Credentials stored"
    
    # Ensure SQL Server allows SQL authentication and public network access
    echo ""
    echo "Configuring SQL Server for authentication..."
    az sql server update \
        --resource-group "$RESOURCE_GROUP" \
        --name "$SQL_SERVER_NAME" \
        --enable-public-network true \
        --output none
    
    echo "✓ SQL Server configuration updated"
    
    # Add current IP to firewall
    CURRENT_IP=$(curl -s https://api.ipify.org)
    echo "Adding firewall rule for IP: $CURRENT_IP"
    
    # Create firewall rule (or update if exists)
    RULE_NAME="temp-export-access"
    az sql server firewall-rule create \
        --resource-group "$RESOURCE_GROUP" \
        --server "$SQL_SERVER_NAME" \
        --name "$RULE_NAME" \
        --start-ip-address "$CURRENT_IP" \
        --end-ip-address "$CURRENT_IP" \
        --output none 2>/dev/null || \
    az sql server firewall-rule update \
        --resource-group "$RESOURCE_GROUP" \
        --server "$SQL_SERVER_NAME" \
        --name "$RULE_NAME" \
        --start-ip-address "$CURRENT_IP" \
        --end-ip-address "$CURRENT_IP" \
        --output none
    
    echo "✓ Firewall rule configured"
    echo ""
    echo "Waiting for configuration to propagate..."
    sleep 5
fi

echo ""

echo "Step 1: Exporting Product Description embeddings..."
echo "---------------------------------------------------"
node "$SCRIPT_DIR/export-product-description-embeddings.js"
echo ""

echo "Step 2: Exporting Product Review embeddings..."
echo "---------------------------------------------------"
node "$SCRIPT_DIR/export-product-review-embeddings.js"
echo ""

echo "================================================"
echo "✓ All embeddings exported successfully!"
echo "================================================"
echo ""
echo "Generated files:"
echo "  - $SCRIPT_DIR/sql/ProductDescription-ai.csv"
echo "  - $SCRIPT_DIR/sql/ProductReview-ai.csv"
echo ""
echo "These files are now compatible with VECTOR columns and can be"
echo "imported during the postprovision.ps1 script execution."
echo "Data source: Azure SQL Database"
