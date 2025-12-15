# Post-deployment script to configure runtime environment variables
# This script updates the API Container App with the frontend URL for CORS configuration

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Get the frontend URL from azd environment
$redirectUrl = (azd env get-value 'APP_REDIRECT_URI' 2>$null).Trim()

if ($redirectUrl -ceq "ERROR: key 'APP_REDIRECT_URI' not found in the environment values" -or [string]::IsNullOrWhiteSpace($redirectUrl)) {
    Write-Warning "APP_REDIRECT_URI not found in azd environment. Skipping API Container App CORS configuration."
    exit 0
}

# Extract base URL from redirect URL (this is the frontend app URL)
$appUrl = $redirectUrl -replace '/getAToken$', ''
Write-Output "Frontend URL: $appUrl"

# Update API Container App with APP_URL environment variable for CORS
Write-Output "Updating API Container App with APP_URL environment variable for CORS configuration..."

$apiServiceName = (azd env get-value 'SERVICE_API_NAME' 2>$null).Trim()
$resourceGroupName = (azd env get-value 'AZURE_RESOURCE_GROUP' 2>$null).Trim()

if ([string]::IsNullOrWhiteSpace($apiServiceName) -or [string]::IsNullOrWhiteSpace($resourceGroupName)) {
    Write-Warning "SERVICE_API_NAME or AZURE_RESOURCE_GROUP not found in azd environment. Skipping API Container App update."
    exit 0
}

Write-Output "API Service Name: $apiServiceName"
Write-Output "Resource Group: $resourceGroupName"
Write-Output "Setting APP_URL to: $appUrl"

# Update the Container App using az CLI
az containerapp update `
    --name $apiServiceName `
    --resource-group $resourceGroupName `
    --set-env-vars "APP_URL=$appUrl" `
    --output none

if ($LASTEXITCODE -eq 0) {
    Write-Output "Successfully updated APP_URL environment variable in API Container App for CORS."
} else {
    Write-Error "Failed to update Container App environment variables. Exit code: $LASTEXITCODE"
    exit 1
}

Write-Output ""
Write-Output "Post-deployment configuration completed successfully."
Write-Output "NOTE: Static Web App config.js was updated during the predeploy hook."
Write-Output "The frontend is configured with:"
Write-Output "  API URL: $(azd env get-value 'API_URL' 2>$null)"
Write-Output "  API Functions URL: $(azd env get-value 'API_FUNCTIONS_URL' 2>$null)"
