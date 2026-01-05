#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Test the AdventureWorks MCP Server endpoints
.DESCRIPTION
    This script tests the MCP Server's HTTP endpoints to verify functionality.
    It queries the tools list and executes sample tool calls.
#>

# Get MCP Server URL from azd environment
$mcpServerUrl = (azd env get-value 'API_FUNCTIONS_URL' 2>$null)
if ($mcpServerUrl) {
    $mcpServerUrl = $mcpServerUrl.Trim()
    if ($mcpServerUrl -like '*ERROR:*') {
        $mcpServerUrl = $null
    }
}

if (-not $mcpServerUrl) {
    Write-Error "API_FUNCTIONS_URL not found in azd environment. Run 'azd env get-values' to check configuration."
    exit 1
}

$mcpEndpoint = "$mcpServerUrl/api/mcp"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Testing AdventureWorks MCP Server" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Endpoint: $mcpEndpoint`n" -ForegroundColor Gray

# Test 1: List Available Tools
Write-Host "[1] Listing available MCP tools..." -ForegroundColor Yellow
try {
    $toolsResponse = Invoke-RestMethod -Uri "$mcpEndpoint/tools" -Method Get -ContentType "application/json"
    
    Write-Host "✅ Found $($toolsResponse.tools.Count) tools:" -ForegroundColor Green
    foreach ($tool in $toolsResponse.tools) {
        Write-Host "   • $($tool.name)" -ForegroundColor White
        Write-Host "     $($tool.description)" -ForegroundColor Gray
    }
    Write-Host ""
}
catch {
    Write-Host "❌ Failed to list tools: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Test 2: Search Products
Write-Host "[2] Testing search_products tool..." -ForegroundColor Yellow
try {
    $searchRequest = @{
        name = "search_products"
        arguments = @{
            searchTerm = "bike"
        }
    } | ConvertTo-Json -Depth 10
    
    $searchResponse = Invoke-WebRequest -Uri "$mcpEndpoint/call" -Method Post -Body $searchRequest -ContentType "application/json"
    $responseJson = $searchResponse.Content | ConvertFrom-Json
    
    if ($responseJson.isError) {
        Write-Host "❌ Error: $($responseJson.content[0].text)" -ForegroundColor Red
    }
    else {
        Write-Host "✅ Search Results:" -ForegroundColor Green
        # MCP returns text content, not JSON
        $resultText = $responseJson.content[0].text
        # Show first 500 characters
        Write-Host $resultText.Substring(0, [Math]::Min(500, $resultText.Length)) -ForegroundColor White
        if ($resultText.Length -gt 500) {
            Write-Host "..." -ForegroundColor Gray
        }
        Write-Host ""
    }
}
catch {
    Write-Host "❌ Failed to search products: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 3: Get Product Details
Write-Host "[3] Testing get_product_details tool..." -ForegroundColor Yellow
try {
    $detailsRequest = @{
        name = "get_product_details"
        arguments = @{
            productId = 680
        }
    } | ConvertTo-Json -Depth 10
    
    $detailsResponse = Invoke-WebRequest -Uri "$mcpEndpoint/call" -Method Post -Body $detailsRequest -ContentType "application/json"
    $responseJson = $detailsResponse.Content | ConvertFrom-Json
    
    if ($responseJson.isError) {
        Write-Host "❌ Error: $($responseJson.content[0].text)" -ForegroundColor Red
    }
    else {
        Write-Host "✅ Product Details:" -ForegroundColor Green
        Write-Host $responseJson.content[0].text -ForegroundColor White
        Write-Host ""
    }
}
catch {
    Write-Host "❌ Failed to get product details: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 4: Find Complementary Products
Write-Host "[4] Testing find_complementary_products tool..." -ForegroundColor Yellow
try {
    $complementaryRequest = @{
        name = "find_complementary_products"
        arguments = @{
            productId = 680
            limit = 5
        }
    } | ConvertTo-Json -Depth 10
    
    $complementaryResponse = Invoke-WebRequest -Uri "$mcpEndpoint/call" -Method Post -Body $complementaryRequest -ContentType "application/json"
    $responseJson = $complementaryResponse.Content | ConvertFrom-Json
    
    if ($responseJson.isError) {
        Write-Host "❌ Error: $($responseJson.content[0].text)" -ForegroundColor Red
    }
    else {
        Write-Host "✅ Complementary Products:" -ForegroundColor Green
        Write-Host $responseJson.content[0].text -ForegroundColor White
        Write-Host ""
    }
}
catch {
    Write-Host "❌ Failed to find complementary products: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 5: Get Customer Orders (requires valid CustomerID)
Write-Host "[5] Testing get_customer_orders tool..." -ForegroundColor Yellow
try {
    $ordersRequest = @{
        name = "get_customer_orders"
        arguments = @{
            customerId = 1
        }
    } | ConvertTo-Json -Depth 10
    
    $ordersResponse = Invoke-WebRequest -Uri "$mcpEndpoint/call" -Method Post -Body $ordersRequest -ContentType "application/json"
    $responseJson = $ordersResponse.Content | ConvertFrom-Json
    
    if ($responseJson.isError) {
        Write-Host "⚠️  $($responseJson.content[0].text)" -ForegroundColor Yellow
    }
    else {
        Write-Host "✅ Customer Orders:" -ForegroundColor Green
        Write-Host $responseJson.content[0].text -ForegroundColor White
        Write-Host ""
    }
}
catch {
    Write-Host "❌ Failed to get customer orders: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 6: Get Order Details (requires valid SalesOrderID)
Write-Host "[6] Testing get_order_details tool..." -ForegroundColor Yellow
try {
    $orderDetailsRequest = @{
        name = "get_order_details"
        arguments = @{
            orderId = 43659
        }
    } | ConvertTo-Json -Depth 10
    
    $orderDetailsResponse = Invoke-WebRequest -Uri "$mcpEndpoint/call" -Method Post -Body $orderDetailsRequest -ContentType "application/json"
    $responseJson = $orderDetailsResponse.Content | ConvertFrom-Json
    
    if ($responseJson.isError) {
        Write-Host "⚠️  $($responseJson.content[0].text)" -ForegroundColor Yellow
    }
    else {
        Write-Host "✅ Order Details:" -ForegroundColor Green
        Write-Host $responseJson.content[0].text -ForegroundColor White
        Write-Host ""
    }
}
catch {
    Write-Host "❌ Failed to get order details: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "MCP Server Test Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
