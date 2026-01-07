# Test script for Order Receipt PDF Generation (PowerShell)
# This script helps test the receipt generation function locally

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Order Receipt PDF Generation Test Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if the function is running
param(
    [string]$FunctionUrl = "http://localhost:7071"
)

$Endpoint = "$FunctionUrl/api/GenerateOrderReceipts_HttpStart"

Write-Host "Testing endpoint: $Endpoint" -ForegroundColor Yellow
Write-Host ""

# Test 1: Generate receipt for a single order
Write-Host "Test 1: Generating receipt for a single order..." -ForegroundColor Green
Write-Host "Request: SO43659"
Write-Host ""

$Body1 = @{
    salesOrderNumbers = @("SO43659")
} | ConvertTo-Json

try {
    $Response1 = Invoke-RestMethod -Uri $Endpoint -Method Post -Body $Body1 -ContentType "application/json"
    Write-Host "Response:"
    $Response1 | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "----------------------------------------"
Write-Host ""

# Test 2: Generate receipts for multiple orders
Write-Host "Test 2: Generating receipts for multiple orders..." -ForegroundColor Green
Write-Host "Request: SO43659, SO43660, SO43661"
Write-Host ""

$Body2 = @{
    salesOrderNumbers = @("SO43659", "SO43660", "SO43661")
} | ConvertTo-Json

try {
    $Response2 = Invoke-RestMethod -Uri $Endpoint -Method Post -Body $Body2 -ContentType "application/json"
    Write-Host "Response:"
    $Response2 | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "----------------------------------------"
Write-Host ""

# Test 3: Invalid request (empty array)
Write-Host "Test 3: Testing error handling (empty array)..." -ForegroundColor Green
Write-Host ""

$Body3 = @{
    salesOrderNumbers = @()
} | ConvertTo-Json

try {
    $Response3 = Invoke-RestMethod -Uri $Endpoint -Method Post -Body $Body3 -ContentType "application/json"
    Write-Host "Response:"
    $Response3 | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Expected Error: $_" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "----------------------------------------"
Write-Host ""

# Instructions for checking results
Write-Host "📝 How to verify the receipts were generated:" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Check the Azure Functions logs for processing messages"
Write-Host "2. Look for messages like:"
Write-Host "   - 'Enqueued receipt generation for order: SO43659'"
Write-Host "   - 'Processing receipt generation for order: SO43659'"
Write-Host "   - 'Successfully generated receipt for order SO43659'"
Write-Host ""
Write-Host "3. Check blob storage for the generated PDFs:"
Write-Host "   Container: adventureworks-receipts"
Write-Host "   Folder: CustomerReceipts/"
Write-Host "   Files: SO43659.pdf, SO43660.pdf, etc."
Write-Host ""
Write-Host "4. You can also use Azure Storage Explorer or the Azure Portal"
Write-Host "   to view the generated PDFs"
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test Complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
