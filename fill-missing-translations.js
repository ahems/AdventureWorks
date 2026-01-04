#!/usr/bin/env node

/**
 * Fill Missing Translations
 *
 * This script:
 * 1. Extracts missing keys from English source
 * 2. Sends them to Azure Function for translation
 * 3. Polls for completion
 * 4. Merges results back into local files
 */

const fs = require("fs").promises;
const path = require("path");

// Configuration
const FUNCTION_URL =
  process.env.TRANSLATION_FUNCTION_URL ||
  "https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/TranslateLanguageFile_HttpStart";
const SOURCE_FILE = path.join(__dirname, "app/src/locales/en/common.json");
const LOCALES_DIR = path.join(__dirname, "app/src/locales");

// Languages missing specific keys
const MISSING_MAP = {
  "header.aiSearchPlaceholder": [
    "pt",
    "ar",
    "ru",
    "tr",
    "id",
    "vi",
    "he",
    "en-gb",
    "en-ca",
    "en-au",
    "en-nz",
    "en-ie",
    "zh-cht",
  ],
  "checkout.removeDiscountCode": [
    "fr",
    "pt",
    "ar",
    "ru",
    "id",
    "vi",
    "en-gb",
    "en-ca",
    "en-au",
    "en-nz",
    "en-ie",
    "zh-cht",
  ],
  "reviewForm.*": ["es", "fr", "zh", "ru", "vi", "zh-cht"],
};

// Colors for console output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function extractMissingKeys() {
  log("📖 Reading source file...", "blue");
  const source = JSON.parse(await fs.readFile(SOURCE_FILE, "utf8"));

  const missingKeys = {
    header: {
      aiSearchPlaceholder: source.header.aiSearchPlaceholder,
    },
    checkout: {
      removeDiscountCode: source.checkout.removeDiscountCode,
    },
    reviewForm: {
      alreadyReviewed: source.reviewForm.alreadyReviewed,
      error: source.reviewForm.error,
      failedToSubmit: source.reviewForm.failedToSubmit,
      thankYouForFeedback: source.reviewForm.thankYouForFeedback,
      thankYouForReview: source.reviewForm.thankYouForReview,
    },
  };

  log("✓ Extracted missing keys", "green");
  return missingKeys;
}

async function translateLanguage(lang, keysToTranslate) {
  log(`\n🌍 Translating to ${lang}...`, "yellow");

  // Start translation
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      languageData: keysToTranslate,
      targetLanguage: lang,
      sourceFilename: "missing_keys",
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const { id: instanceId, statusUrl } = await response.json();
  log(`  Instance ID: ${instanceId}`, "blue");

  // Poll for completion
  process.stdout.write("  Polling");
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    process.stdout.write(".");

    const statusResponse = await fetch(statusUrl);
    const status = await statusResponse.json();

    if (status.runtimeStatus === "Completed") {
      console.log();
      log("  ✓ Translation completed", "green");

      // Parse the output (it's a JSON string containing the blob path)
      const blobPath = JSON.parse(status.output || '""');
      return { success: true, blobPath, output: status.rawOutput };
    } else if (status.runtimeStatus === "Failed") {
      console.log();
      log(`  ✗ Translation failed: ${status.error}`, "red");
      return { success: false, error: status.error };
    }
  }

  console.log();
  log("  ✗ Timeout waiting for translation", "red");
  return { success: false, error: "Timeout" };
}

async function mergeTranslations(lang, translatedKeys) {
  const targetFile = path.join(LOCALES_DIR, lang, "common.json");

  try {
    const existing = JSON.parse(await fs.readFile(targetFile, "utf8"));

    // Merge in the translated keys
    if (translatedKeys.header?.aiSearchPlaceholder) {
      existing.header.aiSearchPlaceholder =
        translatedKeys.header.aiSearchPlaceholder;
    }
    if (translatedKeys.checkout?.removeDiscountCode) {
      existing.checkout.removeDiscountCode =
        translatedKeys.checkout.removeDiscountCode;
    }
    if (translatedKeys.reviewForm) {
      existing.reviewForm = existing.reviewForm || {};
      Object.assign(existing.reviewForm, translatedKeys.reviewForm);
    }

    // Write back with proper formatting
    await fs.writeFile(
      targetFile,
      JSON.stringify(existing, null, 2) + "\n",
      "utf8"
    );
    log(`  ✓ Merged into ${lang}/common.json`, "green");
    return true;
  } catch (error) {
    log(`  ✗ Failed to merge: ${error.message}`, "red");
    return false;
  }
}

async function main() {
  log("\n=== Fill Missing Translations ===\n", "bright");
  log(`Function URL: ${FUNCTION_URL}\n`, "blue");

  try {
    // Extract missing keys
    const missingKeys = await extractMissingKeys();

    // Get unique list of languages that need updates
    const allLangs = new Set();
    Object.values(MISSING_MAP).forEach((langs) =>
      langs.forEach((lang) => allLangs.add(lang))
    );
    const languages = Array.from(allLangs).sort();

    log(`\n📋 Languages to update: ${languages.join(", ")}\n`, "blue");

    const results = {
      success: [],
      failed: [],
    };

    // Process each language
    for (const lang of languages) {
      const result = await translateLanguage(lang, missingKeys);

      if (result.success) {
        results.success.push(lang);
        log(
          `  Note: Translation saved to blob storage: ${result.blobPath}`,
          "blue"
        );
        log(
          `  You'll need to download and merge manually, or wait for blob sync`,
          "yellow"
        );
      } else {
        results.failed.push({ lang, error: result.error });
      }
    }

    // Summary
    log("\n=== Summary ===\n", "bright");
    log(`✓ Successful: ${results.success.length}`, "green");
    if (results.success.length > 0) {
      log(`  ${results.success.join(", ")}`, "green");
    }

    if (results.failed.length > 0) {
      log(`\n✗ Failed: ${results.failed.length}`, "red");
      results.failed.forEach(({ lang, error }) => {
        log(`  ${lang}: ${error}`, "red");
      });
    }

    log(
      "\n📦 Translated files are in blob storage (locales container)",
      "yellow"
    );
    log("   Format: {languageCode}/missing_keys.json\n", "yellow");
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

module.exports = { extractMissingKeys, translateLanguage, mergeTranslations };
