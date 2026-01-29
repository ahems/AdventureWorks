#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Downloads all product thumbnail images from the GraphQL API to the images directory.

.DESCRIPTION
    This script queries the GraphQL API for all ProductPhoto records, extracts the 
    ThumbnailPhoto (base64 encoded) data and ThumbnailPhotoFileName, and writes each image 
    to disk in the images/ directory.

.PARAMETER ApiUrl
    The GraphQL API endpoint URL. Defaults to the production endpoint.

.EXAMPLE
    ./download-large-images.ps1
    Downloads all images using the default API URL.

.EXAMPLE
    ./download-large-images.ps1 -ApiUrl "http://localhost:5000/graphql"
    Downloads all images from a local API endpoint.
#>

param(
    [Parameter()]
    [string]$ApiUrl = "https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql"
)

# Set error action preference
$ErrorActionPreference = "Stop"

# Create images directory if it doesn't exist
$imagesDir = Join-Path $PSScriptRoot "images"
if (-not (Test-Path $imagesDir)) {
    Write-Host "Creating images directory: $imagesDir"
    New-Item -ItemType Directory -Path $imagesDir -Force | Out-Null
}

Write-Host "Downloading images from: $ApiUrl"
Write-Host "Target directory: $imagesDir"
Write-Host ""

# Step 1: Fetch all photo metadata (IDs and filenames) without the large binary data
Write-Host "Step 1: Fetching photo metadata..."
$allMetadata = @()
$metadataPageSize = 1000
$after = $null
$hasNextPage = $true
$pageCount = 0

try {
    while ($hasNextPage) {
        $pageCount++
        
        # Build the GraphQL query for metadata only
        if ($after) {
            $queryText = @"
{
  productPhotos(first: $metadataPageSize, after: "$after") {
    items {
      ProductPhotoID
      ThumbnailPhotoFileName
    }
    endCursor
    hasNextPage
  }
}
"@
        }
        else {
            $queryText = @"
{
  productPhotos(first: $metadataPageSize) {
    items {
      ProductPhotoID
      ThumbnailPhotoFileName
    }
    endCursor
    hasNextPage
  }
}
"@
        }
        
        $query = @{ query = $queryText } | ConvertTo-Json
        
        Write-Host "  Fetching metadata page $pageCount..."
        $response = Invoke-RestMethod -Uri $ApiUrl -Method Post -Body $query -ContentType "application/json"
        
        if ($response.errors) {
            Write-Error "GraphQL errors: $($response.errors | ConvertTo-Json)"
            exit 1
        }
        
        $result = $response.data.productPhotos
        $items = $result.items
        
        if ($items -and $items.Count -gt 0) {
            $allMetadata += $items
            Write-Host "    Retrieved $($items.Count) photo records (Total: $($allMetadata.Count))"
            
            $hasNextPage = $result.hasNextPage
            if ($hasNextPage) {
                $after = $result.endCursor
            }
        }
        else {
            $hasNextPage = $false
        }
    }
    
    $totalPhotos = $allMetadata.Count
    Write-Host ""
    Write-Host "Found $totalPhotos product photos"
    Write-Host ""
    
    # Step 2: Download images one at a time
    Write-Host "Step 2: Downloading images..."
    Write-Host ""
    # Step 2: Download images one at a time
    Write-Host "Step 2: Downloading images..."
    Write-Host ""
    
    $downloaded = 0
    $skipped = 0
    $failed = 0
    $current = 0
    
    foreach ($metadata in $allMetadata) {
        $current++
        $photoId = $metadata.ProductPhotoID
        $fileName = $metadata.ThumbnailPhotoFileName
        
        if ([string]::IsNullOrWhiteSpace($fileName)) {
            Write-Warning "[$current/$totalPhotos] Photo ID $photoId has no filename, skipping..."
            $skipped++
            continue
        }
        
        $filePath = Join-Path $imagesDir $fileName
        
        # Check if file already exists
        if (Test-Path $filePath) {
            Write-Host "[$current/$totalPhotos] Skipping $fileName (already exists)"
            $downloaded++
            continue
        }
        
        try {
            # Query for individual photo with binary data
            $photoQuery = @{
                query = "{ productPhoto_by_pk(ProductPhotoID: $photoId) { ProductPhotoID ThumbnailPhotoFileName ThumbNailPhoto } }"
            } | ConvertTo-Json
            
            $photoResponse = Invoke-RestMethod -Uri $ApiUrl -Method Post -Body $photoQuery -ContentType "application/json"
            
            if ($photoResponse.errors) {
                Write-Warning "[$current/$totalPhotos] Error fetching $fileName (Photo ID: $photoId): $($photoResponse.errors[0].message)"
                $failed++
                continue
            }
            
            $photo = $photoResponse.data.productPhoto_by_pk
            $base64Data = $photo.ThumbNailPhoto
            
            if ([string]::IsNullOrWhiteSpace($base64Data)) {
                Write-Warning "[$current/$totalPhotos] Photo ID $photoId ($fileName) has no image data, skipping..."
                $skipped++
                continue
            }
            
            # Convert base64 string to bytes and write to file
            $imageBytes = [Convert]::FromBase64String($base64Data)
            [System.IO.File]::WriteAllBytes($filePath, $imageBytes)
            
            $fileSizeKB = [Math]::Round($imageBytes.Length / 1KB, 2)
            Write-Host "[$current/$totalPhotos] Downloaded: $fileName (Photo ID: $photoId, Size: $fileSizeKB KB)"
            $downloaded++
        }
        catch {
            Write-Error "[$current/$totalPhotos] Failed to download $fileName (Photo ID: $photoId): $_"
            $failed++
        }
    }
    
    Write-Host ""
    Write-Host "Download Summary:"
    Write-Host "  Total photos found: $totalPhotos"
    Write-Host "  Successfully downloaded: $downloaded"
    Write-Host "  Skipped (no data): $skipped"
    Write-Host "  Failed: $failed"
    Write-Host ""
    Write-Host "Images saved to: $imagesDir"
}
catch {
    Write-Error "Failed to fetch product photos from API: $_"
    exit 1
}
