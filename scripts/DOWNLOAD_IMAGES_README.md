# Product Image Download Script

This script downloads all product images from the Azure DAB API and saves them to disk.

## Features

- 🔍 Automatically gets the API URL from `azd` environment variables
- 📥 Downloads all product images from the Azure database
- 🏷️ Names files as `{productID}-{ProductPhotoID}.{ext}` (e.g., `709-355.jpg`)
- 📁 Detects correct file extension from the database (jpg, gif, png, etc.)
- ⭐ Marks primary photos in the output
- 📊 Provides progress tracking and summary statistics

## Prerequisites

- Node.js 18+ (for ES modules and `fetch` API)
- Azure resources deployed via `azd up`
- Access to the Azure DAB API

## Usage

### Basic Usage (default directory)

```bash
node scripts/download-product-images.mjs
```

This will download all images to `./product-images/`

### Custom Output Directory

```bash
node scripts/download-product-images.mjs /path/to/output/directory
```

Example:

```bash
node scripts/download-product-images.mjs ./my-images
```

### From the scripts directory

```bash
cd scripts
./download-product-images.mjs ../product-images
```

## Output

The script creates one file per product photo with the naming format:

```
{ProductID}-{ProductPhotoID}.{extension}
```

Examples:

- `709-355.jpg` - Product 709, Photo 355 (JPG format)
- `713-162.gif` - Product 713, Photo 162 (GIF format)
- `998-443.jpg` - Product 998, Photo 443 (JPG format)

### Console Output

The script provides detailed progress output:

```
🚀 Starting product image download...
📁 Output directory: product-images

🔍 Getting API URL from azd environment...
✅ API URL: https://av-api-xxx.azurecontainerapps.io/graphql/

📋 Fetching products with photos...
✅ Found 295 products with photos (out of 295 total)

[1/295] Product 709 (Mountain Bike Socks, M) - 3 photo(s)
     Saved: 709-353.png (120.5 KB)
     Saved: 709-354.png (85.2 KB)
  ⭐ Saved: 709-355.png (95.0 KB)

[2/295] Product 713 (Long-Sleeve Logo Jersey, S) - 4 photo(s)
     Saved: 713-162.gif (2.8 KB)
  📸 Saved: 713-437.png (450.2 KB)
  📸 Saved: 713-438.png (380.5 KB)
  ⭐📸 Saved: 713-439.png (425.8 KB)

...

============================================================
✅ Download complete!
============================================================
📊 Summary:
   Products processed: 295
   Images downloaded: 2,847
   Products skipped:  0
   Errors:            0
   Time:              125.3s
   Output directory:  product-images
============================================================
```

## Icons Legend

- ⭐ **Primary photo** - The main product photo
- 📸 **Large photo** - Downloaded from LargePhoto field (higher quality)
- No icon - Downloaded from ThumbNailPhoto field (smaller thumbnail)

## Notes

- **Smart fallback**: The script first tries to download the `ThumbNailPhoto`, but if that's NULL, it automatically falls back to the higher-quality `LargePhoto`
- **Primary photos** are marked with ⭐ in the output
- **Large photos** are marked with 📸 (typically bigger files, better quality)
- Products without any image data will show warning messages
- The script uses the Azure DAB API in production (not local)
- Images are downloaded from either `ThumbNailPhoto` (preferred) or `LargePhoto` (fallback) fields
- File extensions are automatically detected from the respective filename fields
- Large photos can be significantly bigger (100-500KB vs 30-80KB for thumbnails)

## Troubleshooting

### "API_URL not found in azd environment variables"

Make sure you've deployed the Azure resources:

```bash
azd up
```

### "Failed to get API URL"

Ensure you're logged in to Azure:

```bash
azd auth login
```

### Network or timeout errors

The script processes products sequentially to avoid overwhelming the API. If you encounter timeouts, the script will continue with the next product.

## Technical Details

- Uses GraphQL queries to fetch product and photo data
- Downloads images in Base64 format from the database
- Converts Base64 to binary and writes to disk
- Handles both JPG and GIF formats (extensible to other formats)
- Chunk size optimizations prevent memory issues with large batches
