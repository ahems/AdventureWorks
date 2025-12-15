#!/usr/bin/env pwsh

# Pre-deploy hook for the app service
# This script updates config.js with actual Azure URLs before SWA deployment

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "Setting up API URLs for Static Web App deployment..." -ForegroundColor Green

# Get the API URLs from azd environment
$apiUrl = (azd env get-value 'API_URL' 2>$null).Trim()
$apiFunctionsUrl = (azd env get-value 'API_FUNCTIONS_URL' 2>$null).Trim()

if ([string]::IsNullOrWhiteSpace($apiUrl)) {
    Write-Host "Warning: API_URL not found in environment. Using localhost." -ForegroundColor Yellow
    $apiUrl = "http://localhost:5000/graphql"
}

if ([string]::IsNullOrWhiteSpace($apiFunctionsUrl)) {
    Write-Host "Warning: API_FUNCTIONS_URL not found in environment. Using localhost." -ForegroundColor Yellow
    $apiFunctionsUrl = "http://localhost:7071"
}

Write-Host "API URL: $apiUrl" -ForegroundColor Cyan
Write-Host "API Functions URL: $apiFunctionsUrl" -ForegroundColor Cyan

# Update config.js directly before build
$configPath = Join-Path $PSScriptRoot ".." "public" "config.js"
Write-Host "Updating config.js at: $configPath" -ForegroundColor Cyan

$configContent = @"
// Runtime configuration
// Generated during deployment process
window.APP_CONFIG = {
  API_URL: '$apiUrl',
  API_FUNCTIONS_URL: '$apiFunctionsUrl'
};
"@

Set-Content -Path $configPath -Value $configContent -NoNewline -Force
Write-Host "✓ config.js updated successfully!" -ForegroundColor Green

# Also set environment variables for the build process (in case scripts need them)
$env:VITE_API_URL = $apiUrl
$env:VITE_API_FUNCTIONS_URL = $apiFunctionsUrl

Write-Host "Build configuration completed successfully!" -ForegroundColor Green
