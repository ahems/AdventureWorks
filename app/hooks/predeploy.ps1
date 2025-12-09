#!/usr/bin/env pwsh

# Pre-deploy hook for the app service
# This script sets up build arguments for the Docker build

Write-Host "Setting up build arguments for app deployment..." -ForegroundColor Green

# Get the API URL from azd environment
$apiUrl = azd env get-values | Select-String -Pattern "API_URL=" | ForEach-Object { $_ -replace 'API_URL=', '' } | ForEach-Object { $_ -replace '"', '' }

if ([string]::IsNullOrEmpty($apiUrl)) {
    Write-Host "Warning: API_URL not found in environment. Using default." -ForegroundColor Yellow
    $apiUrl = "http://localhost:5000/graphql"
}

Write-Host "API URL: $apiUrl" -ForegroundColor Cyan

# Set the build argument as an azd environment variable that Docker can use
# Azure Container Registry build will pick this up
azd env set VITE_API_URL $apiUrl

Write-Host "Build arguments configured successfully!" -ForegroundColor Green
