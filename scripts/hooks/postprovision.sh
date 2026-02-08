#!/bin/bash
# Post-provision script for setting up Static Web App build environment variables
# and configuring Aspire Dashboard access

set -e

echo "Starting post-provision script at $(date '+%Y-%m-%d %H:%M:%S')"

# Set VITE_API_URL for Static Web App build
API_URL=$(azd env get-value 'API_URL' 2>/dev/null | tr -d '\n\r ')
if [ -n "$API_URL" ]; then
    echo ""
    echo "Setting VITE_API_URL for Static Web App build: $API_URL"
    azd env set 'VITE_API_URL' "$API_URL"
else
    echo "WARNING: API_URL not found in environment. VITE_API_URL will not be set."
fi

# Set VITE_API_FUNCTIONS_URL for Static Web App build
API_FUNCTIONS_URL=$(azd env get-value 'API_FUNCTIONS_URL' 2>/dev/null | tr -d '\n\r ')
if [ -n "$API_FUNCTIONS_URL" ]; then
    echo ""
    echo "Setting VITE_API_FUNCTIONS_URL for Static Web App build: $API_FUNCTIONS_URL"
    azd env set 'VITE_API_FUNCTIONS_URL' "$API_FUNCTIONS_URL"
else
    echo "WARNING: API_FUNCTIONS_URL not found in environment. VITE_API_FUNCTIONS_URL will not be set."
fi

# Grant current user Contributor role on Container Apps Environment for Aspire Dashboard access
CONTAINER_APP_ENV_NAME=$(azd env get-value 'CONTAINER_APP_ENVIRONMENT_NAME' 2>/dev/null | tr -d '\n\r ')
RESOURCE_GROUP=$(azd env get-value 'AZURE_RESOURCE_GROUP' 2>/dev/null | tr -d '\n\r ')

if [ -n "$CONTAINER_APP_ENV_NAME" ] && [ "$CONTAINER_APP_ENV_NAME" != "ERROR: key 'CONTAINER_APP_ENVIRONMENT_NAME' not found in the environment values" ]; then
    echo ""
    echo "Configuring Aspire Dashboard access..."
    
    # Get current user's object ID
    CURRENT_USER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
    
    if [ -n "$CURRENT_USER_OBJECT_ID" ] && [ -n "$RESOURCE_GROUP" ]; then
        # Assign Contributor role to the current user on the Container Apps Environment
        # Use --scope to target the specific Container Apps Environment resource
        ENV_RESOURCE_ID="/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/managedEnvironments/$CONTAINER_APP_ENV_NAME"
        
        # Check if role assignment already exists (idempotent)
        EXISTING_ASSIGNMENT=$(az role assignment list \
            --scope "$ENV_RESOURCE_ID" \
            --assignee "$CURRENT_USER_OBJECT_ID" \
            --role "Contributor" \
            --query "[].id" -o tsv 2>/dev/null || echo "")
        
        if [ -z "$EXISTING_ASSIGNMENT" ]; then
            az role assignment create \
                --scope "$ENV_RESOURCE_ID" \
                --assignee "$CURRENT_USER_OBJECT_ID" \
                --role "Contributor" \
                --output none 2>/dev/null || echo "Note: Role assignment may already exist or failed (this is OK)"
            echo "  Aspire Dashboard access configured successfully"
        else
            echo "  Aspire Dashboard access already configured"
        fi
    else
        echo "  WARNING: Could not determine current user or resource group. Skipping Aspire Dashboard role assignment."
    fi
else
    echo "  WARNING: CONTAINER_APP_ENVIRONMENT_NAME not found in environment. Skipping Aspire Dashboard configuration."
fi

echo ""
echo "=========================================="
echo "Assigning database roles to Managed Identity..."
echo "=========================================="

# Check if user is logged in to Azure CLI
echo "Verifying Azure CLI login status..."
if ! az account show &>/dev/null; then
    echo ""
    echo "❌ ERROR: Not logged in to Azure CLI"
    echo ""
    echo "Please run 'az login' to authenticate with Azure, then try again."
    echo ""
    exit 1
fi
echo "  ✓ Azure CLI login verified"

# Get required values
SQL_SERVER_NAME=$(azd env get-value SQL_SERVER_NAME 2>/dev/null | tr -d '\n\r ')
SQL_DATABASE_NAME=$(azd env get-value SQL_DATABASE_NAME 2>/dev/null | tr -d '\n\r ')
USER_MANAGED_IDENTITY_NAME=$(azd env get-value USER_MANAGED_IDENTITY_NAME 2>/dev/null | tr -d '\n\r ')

if [ -n "$SQL_SERVER_NAME" ] && [ -n "$SQL_DATABASE_NAME" ] && [ -n "$USER_MANAGED_IDENTITY_NAME" ]; then
    echo "SQL Server: $SQL_SERVER_NAME"
    echo "Database: $SQL_DATABASE_NAME"
    echo "Managed Identity: $USER_MANAGED_IDENTITY_NAME"
    
    echo ""
    echo "Executing database role assignment..."
    
    # Use a minimal PowerShell script that calls az CLI (not Az PowerShell modules)
    # This avoids separate PowerShell login and uses current az CLI context
    PWSH_OUTPUT=$(pwsh -NoProfile -NonInteractive -Command "
        # Get SQL token using az CLI (same login as bash)
        try {
            \$tokenJson = az account get-access-token --resource https://database.windows.net/ 2>&1 | ConvertFrom-Json
            if (-not \$tokenJson.accessToken) {
                Write-Error 'Failed to get access token'
                exit 1
            }
            \$token = \$tokenJson.accessToken
        } catch {
            Write-Error \"Failed to get Azure access token: \$_\"
            exit 1
        }
        
        # Read and prepare SQL script
        try {
            \$sql = Get-Content 'seed-job/sql/assign-database-roles.sql' -Raw
            \$sql = \$sql -replace '{{IDENTITY_NAME}}', '$USER_MANAGED_IDENTITY_NAME'
        } catch {
            Write-Error \"Failed to read SQL script: \$_\"
            exit 1
        }
        
        # Execute SQL with token
        try {
            \$connString = 'Server=tcp:$SQL_SERVER_NAME.database.windows.net,1433;Initial Catalog=$SQL_DATABASE_NAME;Encrypt=True;TrustServerCertificate=False;'
            \$conn = New-Object System.Data.SqlClient.SqlConnection(\$connString)
            \$conn.AccessToken = \$token
            \$conn.Open()
            \$cmd = \$conn.CreateCommand()
            \$cmd.CommandText = \$sql
            \$null = \$cmd.ExecuteNonQuery()
            \$conn.Close()
            Write-Host '  ✓ Database roles assigned successfully'
        } catch {
            Write-Error \"Failed to execute SQL: \$_\"
            exit 1
        }
    " 2>&1)
    PWSH_EXIT_CODE=$?
    
    echo "$PWSH_OUTPUT"
    
    if [ $PWSH_EXIT_CODE -ne 0 ]; then
        echo ""
        echo "❌ ERROR: Database role assignment failed"
        echo ""
        echo "This may be caused by:"
        echo "  - Azure CLI token expired (try running 'az login' again)"
        echo "  - Insufficient permissions on the SQL database"
        echo "  - Network connectivity issues"
        echo ""
        exit 1
    fi
    echo ""
else
    echo "WARNING: Missing required environment variables for database role assignment"
    echo "  SQL_SERVER_NAME: ${SQL_SERVER_NAME:-[NOT SET]}"
    echo "  SQL_DATABASE_NAME: ${SQL_DATABASE_NAME:-[NOT SET]}"
    echo "  USER_MANAGED_IDENTITY_NAME: ${USER_MANAGED_IDENTITY_NAME:-[NOT SET]}"
fi

echo ""
echo "=========================================="
echo "Building and deploying seed-job image..."
echo "=========================================="

# Get Azure environment values for seed job deployment
ACR_ENDPOINT=$(azd env get-value AZURE_CONTAINER_REGISTRY_ENDPOINT 2>/dev/null | tr -d '\n\r ')
SEED_JOB_NAME=$(azd env get-value SERVICE_SEED_JOB_NAME 2>/dev/null | tr -d '\n\r ')

if [ -z "$RESOURCE_GROUP" ] || [ -z "$ACR_ENDPOINT" ] || [ -z "$SEED_JOB_NAME" ]; then
    echo "ERROR: Required environment variables not found for seed-job deployment."
    echo "Resource Group: ${RESOURCE_GROUP:-[NOT SET]}"
    echo "ACR Endpoint: ${ACR_ENDPOINT:-[NOT SET]}"
    echo "Seed Job Name: ${SEED_JOB_NAME:-[NOT SET]}"
    exit 1
fi

# Extract ACR name from endpoint (e.g., "avacragtyjfry4y6w6.azurecr.io" -> "avacragtyjfry4y6w6")
ACR_NAME="${ACR_ENDPOINT%%.*}"

echo "Resource Group: $RESOURCE_GROUP"
echo "ACR Name: $ACR_NAME"
echo "ACR Endpoint: $ACR_ENDPOINT"
echo "Seed Job Name: $SEED_JOB_NAME"

# Build and push the image to ACR
echo ""
echo "Building and pushing seed-job image to ACR..."
az acr build \
    --registry "$ACR_NAME" \
    --image seed-job:latest \
    --file seed-job/dockerfile \
    seed-job

# Use the endpoint directly for the image name
IMAGE_NAME="${ACR_ENDPOINT}/seed-job:latest"

echo ""
echo "Updating Container App Job image..."

# Simple approach: Just update the container image for the specific container
# This preserves ALL other configuration including env vars and volume mounts
az containerapp job update \
    --name "$SEED_JOB_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --container-name "$SEED_JOB_NAME" \
    --image "$IMAGE_NAME"

echo ""
echo "Seed job image deployed successfully!"
echo ""
echo "Starting seed job to populate database..."
az containerapp job start \
    --name "$SEED_JOB_NAME" \
    --resource-group "$RESOURCE_GROUP"

if [ $? -eq 0 ]; then
    echo "  ✓ Seed job started successfully"
    echo "  Note: The job runs asynchronously. Check execution status with:"
    echo "    az containerapp job execution list --name $SEED_JOB_NAME --resource-group $RESOURCE_GROUP"
else
    echo "  ⚠ Seed job start may have failed"
fi

echo ""
echo "=========================================="
echo "Post-provision script completed"
echo "Finished at: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
