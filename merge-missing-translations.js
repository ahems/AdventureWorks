#!/usr/bin/env node

/**
 * Merge Missing Translations
 *
 * Downloads translated missing keys from blob storage and merges them
 * into the local common.json files for each language.
 */

const { BlobServiceClient } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");
const fs = require("fs").promises;
const path = require("path");

// Configuration
const STORAGE_ACCOUNT_NAME =
  process.env.STORAGE_ACCOUNT_NAME || "avstoragewje2yrjsuipbs";
const CONTAINER_NAME = "locales";
const LOCALES_DIR = path.join(__dirname, "app/src/locales");

// Languages to update
const LANGUAGES = [
  "ar",
  "en-au",
  "en-ca",
  "en-gb",
  "en-ie",
  "en-nz",
  "es",
  "fr",
  "he",
  "id",
  "pt",
  "ru",
  "tr",
  "vi",
  "zh",
  "zh-cht",
];

// Colors
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function downloadTranslation(blobServiceClient, lang) {
  const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  const blobName = `${lang}/missing_keys.json`;
  const blobClient = containerClient.getBlobClient(blobName);

  try {
    const downloadResponse = await blobClient.download();
    const content = await streamToString(downloadResponse.readableStreamBody);
    return JSON.parse(content);
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function streamToString(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (data) => {
      chunks.push(data.toString());
    });
    readableStream.on("end", () => {
      resolve(chunks.join(""));
    });
    readableStream.on("error", reject);
  });
}

async function mergeTranslations(lang, translatedKeys) {
  const targetFile = path.join(LOCALES_DIR, lang, "common.json");

  try {
    const existing = JSON.parse(await fs.readFile(targetFile, "utf8"));
    let updated = false;

    // Merge header.aiSearchPlaceholder
    if (translatedKeys.header?.aiSearchPlaceholder) {
      if (!existing.header.aiSearchPlaceholder) {
        existing.header.aiSearchPlaceholder =
          translatedKeys.header.aiSearchPlaceholder;
        log(`    ✓ Added header.aiSearchPlaceholder`, "green");
        updated = true;
      }
    }

    // Merge checkout.removeDiscountCode
    if (translatedKeys.checkout?.removeDiscountCode) {
      if (!existing.checkout.removeDiscountCode) {
        existing.checkout.removeDiscountCode =
          translatedKeys.checkout.removeDiscountCode;
        log(`    ✓ Added checkout.removeDiscountCode`, "green");
        updated = true;
      }
    }

    // Merge reviewForm keys
    if (translatedKeys.reviewForm) {
      existing.reviewForm = existing.reviewForm || {};
      const reviewFormKeys = [
        "alreadyReviewed",
        "error",
        "failedToSubmit",
        "thankYouForFeedback",
        "thankYouForReview",
      ];

      for (const key of reviewFormKeys) {
        if (translatedKeys.reviewForm[key] && !existing.reviewForm[key]) {
          existing.reviewForm[key] = translatedKeys.reviewForm[key];
          log(`    ✓ Added reviewForm.${key}`, "green");
          updated = true;
        }
      }
    }

    if (updated) {
      // Write back with proper formatting
      await fs.writeFile(
        targetFile,
        JSON.stringify(existing, null, 2) + "\n",
        "utf8"
      );
      return true;
    } else {
      log(`    ⚠ No updates needed (keys already exist)`, "yellow");
      return false;
    }
  } catch (error) {
    log(`    ✗ Failed to merge: ${error.message}`, "red");
    return false;
  }
}

async function main() {
  log("\n=== Merge Missing Translations ===\n", "blue");

  try {
    // Initialize blob service client
    log("🔗 Connecting to blob storage...", "blue");
    const blobServiceUrl = `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net`;
    const credential = new DefaultAzureCredential();
    const blobServiceClient = new BlobServiceClient(blobServiceUrl, credential);
    log("✓ Connected\n", "green");

    const results = {
      merged: [],
      notFound: [],
      failed: [],
    };

    // Process each language
    for (const lang of LANGUAGES) {
      log(`📦 Processing ${lang}...`, "yellow");

      // Download translation
      const translatedKeys = await downloadTranslation(blobServiceClient, lang);

      if (!translatedKeys) {
        log(`  ⚠ Translation not found in blob storage`, "yellow");
        results.notFound.push(lang);
        continue;
      }

      log(`  ✓ Downloaded from blob storage`, "green");

      // Merge into local file
      const merged = await mergeTranslations(lang, translatedKeys);

      if (merged) {
        results.merged.push(lang);
      } else {
        results.failed.push(lang);
      }

      console.log();
    }

    // Summary
    log("=== Summary ===\n", "blue");

    if (results.merged.length > 0) {
      log(`✓ Successfully merged: ${results.merged.length}`, "green");
      log(`  ${results.merged.join(", ")}`, "green");
    }

    if (results.notFound.length > 0) {
      log(
        `\n⚠ Not found in blob storage: ${results.notFound.length}`,
        "yellow"
      );
      log(`  ${results.notFound.join(", ")}`, "yellow");
    }

    if (results.failed.length > 0) {
      log(`\n✗ Failed to merge: ${results.failed.length}`, "red");
      log(`  ${results.failed.join(", ")}`, "red");
    }

    log("\n✨ Done!\n", "green");
  } catch (error) {
    log(`\n✗ Error: ${error.message}`, "red");
    console.error(error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { downloadTranslation, mergeTranslations };
