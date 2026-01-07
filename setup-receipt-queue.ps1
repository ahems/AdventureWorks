# Script to manually create the order-receipt-generation queue and set up permissions
# Run this if you get "Queue does not exist" errors

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Receipt Queue Setup Script" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Get Azure environment values
Write-Host "Getting Azure environment values from azd..." -ForegroundColor Yellow

$envValues = azd env get-values | Out-String
$storageAccount = ($envValues | Select-String 'AZURE_STORAGE_ACCOUNT_NAME="?([^"]+)"?' | ForEach-Object { $_.Matches.Groups[1].Value })
$resourceGroup = ($envValues | Select-String 'AZURE_RESOURCE_GROUP="?([^"]+)"?' | ForEach-Object { $_.Matches.Groups[1].Value })
$functionAppName = ($envValues | Select-String 'AZURE_FUNCTION_APP_NAME="?([^"]+)"?' | ForEach-Object { $_.Matches.Groups[1].Value })

if ([string]::IsNullOrEmpty($storageAccount)) {
    Write-Host "❌ Could not find AZURE_STORAGE_ACCOUNT_NAME in azd environment" -ForegroundColor Red
    Write-Host "Please run 'azd up' first to deploy the infrastructure" -ForegroundColor Red
    exit 1
}

Write-Host "Storage Account: $storageAccount" -ForegroundColor Green
Write-Host "Resource Group: $resourceGroup" -ForegroundColor Green
Write-Host "Function App: $functionAppName" -ForegroundColor Green
Write-Host ""

# Create the queue
Write-Host "Step 1: Creating queue 'order-receipt-generation'..." -ForegroundColor Yellow

try {
    az storage queue create `
        --name "order-receipt-generation" `
        --account-name $storageAccount `
        --auth-mode login
    
    Write-Host "✅ Queue created successfully" -ForegroundColor Green
} catch {
    Write-Host "❌ Failed to create queue: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step 2: Getting Function App's Managed Identity..." -ForegroundColor Yellow

# Get the Function App's principal ID
$principalId = az functionapp identity show `
    --name $functionAppName `
    --resource-group $resourceGroup `
    --query principalId -o tsv

if ([string]::IsNullOrEmpty($principalId)) {
    Write-Host "⚠️  No Managed Identity found for Function App" -ForegroundColor Yellow
    Write-Host "Creating system-assigned managed identity..." -ForegroundColor Yellow
    
    $principalId = az functionapp identity assign `
        --name $functionAppName `
        --resource-group $resourceGroup `
        --query principalId -o tsv
    
    Write-Host "✅ Managed Identity created: $principalId" -ForegroundColor Green
} else {
    Write-Host "✅ Found Managed Identity: $principalId" -ForegroundColor Green
}

Write-Host ""
Write-Host "Step 3: Assigning 'Storage Queue Data Contributor' role..." -ForegroundColor Yellow

# Get Storage Account ID
$storageId = az storage account show `
    --name $storageAccount `
    --resource-group $resourceGroup `
    --query id -o tsv

# Assign role
try {
    az role assignment create `
        --assignee $principalId `
        --role "Storage Queue Data Contributor" `
        --scope $storageId
    
    Write-Host "✅ Role assigned successfully" -ForegroundColor Green
} catch {
    Write-Host "⚠️  Role assignment may have failed (might already exist)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Step 4: Verifying setup..." -ForegroundColor Yellow

# Check if queue exists
$queueExists = az storage queue exists `
    --name "order-receipt-generation" `
    --account-name $storageAccount `
    --auth-mode login `
    --query exists -o tsv

if ($queueExists -eq "true") {
    Write-Host "✅ Queue 'order-receipt-generation' exists and is accessible" -ForegroundColor Green
} else {
    Write-Host "❌ Queue verification failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "✅ Setup Complete!" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "The receipt generation function should now work." -ForegroundColor Green
Write-Host "Test it with:" -ForegroundColor Green
Write-Host ""

$functionUrl = ($envValues | Select-String 'FUNCTION_URL="?([^"]+)"?' | ForEach-Object { $_.Matches.Groups[1].Value })
Write-Host "curl -X POST `"$functionUrl/api/GenerateOrderReceipts_HttpStart`" ``" -ForegroundColor White
Write-Host "  -H `"Content-Type: application/json`" ``" -ForegroundColor White
Write-Host "  -d '{`"salesOrderNumbers`": [`"SO75125`"]}'" -ForegroundColor White
Write-Host ""
