#!/usr/bin/env node
/**
 * Download all product images from Azure DAB API
 *
 * This script:
 * 1. Gets the API URL from azd environment variables
 * 2. Queries all products that have images
 * 3. Downloads each product's images
 * 4. Saves them to disk as {productID}-{ProductPhotoID}.{ext}
 *
 * Usage: node scripts/download-product-images.mjs [output-dir]
 */

import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// GraphQL queries
const GET_PRODUCTS_WITH_PHOTOS = `
  query GetProductsWithPhotos {
    products(first: 1000, filter: { FinishedGoodsFlag: { eq: true } }) {
      items {
        ProductID
        Name
        productProductPhotos {
          items {
            ProductPhotoID
            Primary
          }
        }
      }
    }
  }
`;

const GET_PRODUCT_PHOTOS = `
  query GetProductPhotos($productId: Int!) {
    products(filter: { ProductID: { eq: $productId } }) {
      items {
        ProductID
        Name
        productProductPhotos {
          items {
            ProductPhotoID
            Primary
            productPhoto {
              ProductPhotoID
              ThumbnailPhotoFileName
              LargePhotoFileName
            }
          }
        }
      }
    }
  }
`;

const GET_PHOTO_DATA = `
  query GetPhotoData($photoId: Int!, $useLarge: Boolean!) {
    productPhotos(filter: { ProductPhotoID: { eq: $photoId } }) {
      items {
        ProductPhotoID
        ThumbNailPhoto @skip(if: $useLarge)
        ThumbnailPhotoFileName @skip(if: $useLarge)
        LargePhoto @include(if: $useLarge)
        LargePhotoFileName @include(if: $useLarge)
      }
    }
  }
`;

/**
 * Get the API URL from azd environment variables
 */
async function getApiUrl() {
  try {
    const { stdout } = await execAsync("azd env get-values 2>/dev/null");
    const lines = stdout.split("\n");

    for (const line of lines) {
      if (line.startsWith("API_URL=")) {
        // Extract value from API_URL="..."
        const match = line.match(/API_URL="(.+)"/);
        if (match) {
          return match[1];
        }
      }
    }

    throw new Error("API_URL not found in azd environment variables");
  } catch (error) {
    console.error("❌ Failed to get API URL:", error.message);
    console.error(
      'Make sure you have run "azd up" to provision the Azure resources'
    );
    process.exit(1);
  }
}

/**
 * Execute a GraphQL query
 */
async function graphqlRequest(apiUrl, query, variables = {}) {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(
      `GraphQL errors: ${JSON.stringify(result.errors, null, 2)}`
    );
  }

  return result.data;
}

/**
 * Extract file extension from filename
 */
function getFileExtension(filename) {
  if (!filename) return "jpg"; // default

  const match = filename.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "jpg";
}

/**
 * Convert base64 image data to buffer
 */
function base64ToBuffer(base64Data) {
  // Remove data URL prefix if present (e.g., "data:image/gif;base64,")
  const base64String = base64Data.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(base64String, "base64");
}

/**
 * Download and save a single product's images
 */
async function downloadProductImages(apiUrl, productId, outputDir) {
  try {
    // First, query for this product's photo metadata (without binary data)
    const data = await graphqlRequest(apiUrl, GET_PRODUCT_PHOTOS, {
      productId,
    });

    if (
      !data.products ||
      !data.products.items ||
      data.products.items.length === 0
    ) {
      console.log(`  ⚠️  Product ${productId}: No data found`);
      return { productId, downloaded: 0, skipped: 0, errors: 0 };
    }

    const product = data.products.items[0];
    const photoMappings = product.productProductPhotos?.items || [];

    if (photoMappings.length === 0) {
      return { productId, downloaded: 0, skipped: 1, errors: 0 };
    }

    let downloaded = 0;
    let errors = 0;

    // Process each photo one at a time to avoid memory issues
    for (const mapping of photoMappings) {
      const photoMetadata = mapping.productPhoto;

      if (!photoMetadata) {
        console.log(
          `  ⚠️  Product ${productId}, Photo ${mapping.ProductPhotoID}: Photo record not found`
        );
        errors++;
        continue;
      }

      const photoId = photoMetadata.ProductPhotoID;
      const hasThumbnail = !!photoMetadata.ThumbnailPhotoFileName;
      const hasLarge = !!photoMetadata.LargePhotoFileName;

      if (!hasThumbnail && !hasLarge) {
        console.log(
          `  ⚠️  Product ${productId}, Photo ${photoId}: No image data`
        );
        errors++;
        continue;
      }

      try {
        // Fetch the actual photo data (prefer thumbnail, fallback to large)
        const useLarge = !hasThumbnail;
        const photoDataResponse = await graphqlRequest(apiUrl, GET_PHOTO_DATA, {
          photoId,
          useLarge,
        });

        const photoData = photoDataResponse.productPhotos?.items?.[0];
        if (!photoData) {
          console.log(
            `  ⚠️  Product ${productId}, Photo ${photoId}: Failed to fetch photo data`
          );
          errors++;
          continue;
        }

        const imageData = photoData.ThumbNailPhoto || photoData.LargePhoto;
        const filename =
          photoData.ThumbnailPhotoFileName || photoData.LargePhotoFileName;
        const photoType = photoData.ThumbNailPhoto ? "thumbnail" : "large";

        if (!imageData) {
          console.log(
            `  ⚠️  Product ${productId}, Photo ${photoId}: No binary image data`
          );
          errors++;
          continue;
        }

        const extension = getFileExtension(filename);
        const outputFilename = `${productId}-${photoId}.${extension}`;
        const filepath = join(outputDir, outputFilename);

        // Convert base64 to buffer and write to file
        const imageBuffer = base64ToBuffer(imageData);
        await writeFile(filepath, imageBuffer);

        const primaryMark = mapping.Primary ? "⭐" : "  ";
        const typeIndicator = photoType === "large" ? "📸" : "  ";
        console.log(
          `  ${primaryMark}${typeIndicator} Saved: ${outputFilename} (${(
            imageBuffer.length / 1024
          ).toFixed(1)} KB)`
        );
        downloaded++;

        // Small delay to avoid overwhelming the API
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        // Check if it's an OutOfMemoryException (server can't handle this photo)
        const isOOMError = error.message?.includes("OutOfMemoryException");
        if (isOOMError) {
          console.log(
            `  ⚠️  Product ${productId}, Photo ${photoId}: Photo too large for API (server OOM)`
          );
        } else {
          console.error(`  ❌ Error saving photo ${photoId}:`, error.message);
        }
        errors++;
      }
    }

    return { productId, downloaded, skipped: 0, errors };
  } catch (error) {
    console.error(
      `  ❌ Error downloading images for product ${productId}:`,
      error.message
    );
    return { productId, downloaded: 0, skipped: 0, errors: 1 };
  }
}

/**
 * Main function
 */
async function main() {
  const startTime = Date.now();

  // Get output directory from args or use default
  const outputDir = process.argv[2] || join(__dirname, "..", "product-images");

  console.log("🚀 Starting product image download...");
  console.log(`📁 Output directory: ${outputDir}\n`);

  // Create output directory
  await mkdir(outputDir, { recursive: true });

  // Get API URL from azd
  console.log("🔍 Getting API URL from azd environment...");
  const apiUrl = await getApiUrl();
  console.log(`✅ API URL: ${apiUrl}\n`);

  // Get all products that have photos
  console.log("📋 Fetching products with photos...");
  const data = await graphqlRequest(apiUrl, GET_PRODUCTS_WITH_PHOTOS);

  const allProducts = data.products.items;
  const productsWithPhotos = allProducts.filter(
    (p) => p.productProductPhotos?.items?.length > 0
  );

  console.log(
    `✅ Found ${productsWithPhotos.length} products with photos (out of ${allProducts.length} total)\n`
  );

  // Download images for each product
  const stats = {
    totalProducts: productsWithPhotos.length,
    totalDownloaded: 0,
    totalSkipped: 0,
    totalErrors: 0,
  };

  for (let i = 0; i < productsWithPhotos.length; i++) {
    const product = productsWithPhotos[i];
    const photoCount = product.productProductPhotos.items.length;

    console.log(
      `\n[${i + 1}/${productsWithPhotos.length}] Product ${
        product.ProductID
      } (${product.Name}) - ${photoCount} photo(s)`
    );

    const result = await downloadProductImages(
      apiUrl,
      product.ProductID,
      outputDir
    );
    stats.totalDownloaded += result.downloaded;
    stats.totalSkipped += result.skipped;
    stats.totalErrors += result.errors;
  }

  // Print summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(60));
  console.log("✅ Download complete!");
  console.log("=".repeat(60));
  console.log(`📊 Summary:`);
  console.log(`   Products processed: ${stats.totalProducts}`);
  console.log(`   Images downloaded: ${stats.totalDownloaded}`);
  console.log(`   Products skipped:  ${stats.totalSkipped}`);
  console.log(`   Errors:            ${stats.totalErrors}`);
  console.log(`   Time:              ${duration}s`);
  console.log(`   Output directory:  ${outputDir}`);
  console.log("=".repeat(60));
}

// Run the script
main().catch((error) => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});
