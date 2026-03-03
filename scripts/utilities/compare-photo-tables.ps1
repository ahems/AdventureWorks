#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Compare ProductPhoto data between Original API and seed-job API; report AI images in Original that are missing from the filesystem.
#>
param(
    [string]$OriginalUrl = "https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql/",
    [string]$SeedUrl = "",
    [string]$ImagesDir = ""
)

$ErrorActionPreference = "Stop"
$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "../..")).Path
if (-not $ImagesDir) { $ImagesDir = Join-Path $repoRoot "seed-job/images" }

function Get-AllProductPhotos($baseUrl) {
    $all = @()
    $after = $null
    $page = 0
    do {
        $page++
        if ($after) {
            $query = 'query { productPhotos(first: 100, after: "' + $after.Replace('\', '\\').Replace('"', '\"') + '") { items { ProductPhotoID ThumbnailPhotoFileName } endCursor hasNextPage } }'
        } else {
            $query = 'query { productPhotos(first: 100) { items { ProductPhotoID ThumbnailPhotoFileName } endCursor hasNextPage } }'
        }
        $body = '{"query":"' + $query.Replace('\', '\\').Replace('"', '\"') + '"}'
        $resp = Invoke-RestMethod -Uri $baseUrl -Method Post -Body $body -ContentType "application/json"
        $data = $resp.data.productPhotos
        $all += $data.items
        if (-not $data.hasNextPage) { break }
        $after = $data.endCursor
        if (-not $after) { break }
    } while ($true)
    return $all
}

# Parse product_N_photo_M from filename (e.g. product_680_photo_2_small.png)
function Get-ProductPhotoKeys($items) {
    $keys = @{}
    foreach ($item in $items) {
        $fn = $item.ThumbnailPhotoFileName
        if (-not $fn) { continue }
        if ($fn -match '^product_(\d+)_photo_(\d+)') {
            $productId = [int]$Matches[1]
            $pnum = [int]$Matches[2]
            $k = "$productId`t$pnum"
            if (-not $keys.ContainsKey($k)) { $keys[$k] = @($item.ProductPhotoID) }
            else { $keys[$k] += $item.ProductPhotoID }
        }
    }
    return $keys
}

# Filesystem: list product_*_photo_*_small.png or _thumb.png, derive (productId, photoNum)
$fsKeys = @{}
if (Test-Path $ImagesDir) {
    Get-ChildItem -Path $ImagesDir -Filter "*.png" | Where-Object { $_.Name -match '_small\.png$|_thumb\.png$' } | ForEach-Object {
        $name = $_.Name -replace '_small\.png$', '.png' -replace '_thumb\.png$', '.png'
        if ($name -match '^product_(\d+)_photo_(\d+)\.png$') {
            $fsKeys["$($Matches[1])`t$($Matches[2])"] = $true
        }
    }
}

Write-Host "Original API: $OriginalUrl"
$originalAll = Get-AllProductPhotos -baseUrl $OriginalUrl
Write-Host "  Total ProductPhoto records: $($originalAll.Count)"
$originalAi = $originalAll | Where-Object { $_.ThumbnailPhotoFileName -match '^product_\d+_photo_\d+' }
Write-Host "  AI-style (product_N_photo_M): $($originalAi.Count)"
$originalKeys = Get-ProductPhotoKeys -items $originalAi
Write-Host "  Unique (ProductID, photoNum) from Original: $($originalKeys.Count)"

Write-Host ""
Write-Host "Filesystem: $ImagesDir"
Write-Host "  Unique (ProductID, photoNum) from image files: $($fsKeys.Count)"

$missing = @()
foreach ($k in $originalKeys.Keys) {
    if (-not $fsKeys.ContainsKey($k)) {
    $parts = $k -split "`t"
    $missing += [pscustomobject]@{ ProductID = [int]$parts[0]; PhotoNum = [int]$parts[1]; Key = $k }
    }
}
$missing = $missing | Sort-Object ProductID, PhotoNum

Write-Host ""
if ($missing.Count -eq 0) {
    Write-Host "Result: No missing images. Every (ProductID, photoNum) in the Original API has a corresponding file on the filesystem."
} else {
    Write-Host "Result: $($missing.Count) image(s) in Original are NOT on the filesystem:"
    $missing | Format-Table -AutoSize
    Write-Host "First 20 missing (ProductID, photoNum):"
    $missing | Select-Object -First 20 | ForEach-Object { Write-Host "  product_$($_.ProductID)_photo_$($_.PhotoNum)" }
    $byProduct = $missing | Group-Object ProductID
    Write-Host ""
    Write-Host "Missing by product: $($byProduct.Count) products affected. ProductID range: $(($missing | Measure-Object -Property ProductID -Minimum -Maximum).Minimum)-$(($missing | Measure-Object -Property ProductID -Minimum -Maximum).Maximum)"
}

if ($SeedUrl) {
    Write-Host ""
    Write-Host "Seed API: $SeedUrl"
    $seedAll = Get-AllProductPhotos -baseUrl $SeedUrl
    Write-Host "  Total ProductPhoto records: $($seedAll.Count)"
    $seedAi = $seedAll | Where-Object { $_.ThumbnailPhotoFileName -match '^product_\d+_photo_\d+' }
    Write-Host "  AI-style (product_N_photo_M): $($seedAi.Count)"
}
