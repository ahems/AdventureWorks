#!/usr/bin/env node

/**
 * Check Product Translation Coverage
 *
 * Verifies that all products have translations in all supported languages
 */

const { execSync } = require("child_process");

// Get database connection info
const sqlServer = "av-sql-ewphuc52etkbc.database.windows.net";
const sqlDatabase = "AdventureWorks";
const sqlUser = "CloudSA7d3784da";
const sqlPassword = "TempP@ssw0rd123!";

// UI Languages from LanguageContext (23 languages, excluding 'en')
const UI_LANGUAGES = [
  "ar",
  "de",
  "en-au",
  "en-ca",
  "en-gb",
  "en-ie",
  "en-nz",
  "es",
  "fr",
  "he",
  "id",
  "it",
  "ja",
  "ko",
  "nl",
  "pt",
  "ru",
  "th",
  "tr",
  "vi",
  "zh",
  "zh-cht",
];

// Database culture mapping (UI code -> DB CultureID)
const CULTURE_MAPPING = {
  ar: "ar",
  de: "de",
  "en-au": "en-AU", // Note: DB uses uppercase country codes
  "en-ca": "en-CA",
  "en-gb": "en-GB",
  "en-ie": "en-IE",
  "en-nz": "en-NZ",
  es: "es",
  fr: "fr",
  "fr-ca": "fr-CA",
  he: "he",
  id: "id",
  it: "it",
  ja: "ja",
  ko: "ko",
  nl: "nl",
  pt: "pt",
  "pt-br": "pt-BR",
  ru: "ru",
  th: "th",
  tr: "tr",
  vi: "vi",
  zh: "zh-Hans", // Simplified Chinese
  "zh-cht": "zh-Hant", // Traditional Chinese
  "zh-cn": "zh-CN",
  "zh-tw": "zh-TW",
};

function runQuery(query) {
  try {
    // Escape the query for shell
    const escapedQuery = query.replace(/'/g, "''");

    // Use az sql db query
    const result = execSync(
      `az sql db query -s ${sqlServer} -d ${sqlDatabase} -U ${sqlUser} -P '${sqlPassword}' -Q "${escapedQuery}" -o json`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    return JSON.parse(result);
  } catch (error) {
    console.error("Query failed:", error.message);
    if (error.stderr) {
      console.error("Error output:", error.stderr.toString());
    }
    return null;
  }
}

async function main() {
  console.log("=== Product Translation Coverage Check ===\n");

  // Query 1: Get all cultures in the database
  console.log("📋 Checking database cultures...");
  const culturesQuery =
    "SELECT CultureID, Name FROM Production.Culture ORDER BY Name";
  const dbCultures = runQuery(culturesQuery);

  if (!dbCultures) {
    console.error("❌ Failed to query database cultures");
    process.exit(1);
  }

  console.log(`   Found ${dbCultures.length} cultures in database\n`);

  // Query 2: Get total products that should have translations
  console.log("📦 Checking total products...");
  const productsQuery = `
    SELECT COUNT(DISTINCT pm.ProductModelID) as TotalProducts
    FROM Production.ProductModel pm
    WHERE EXISTS (
      SELECT 1 
      FROM Production.ProductModelProductDescriptionCulture pmpdc 
      WHERE pmpdc.ProductModelID = pm.ProductModelID 
      AND pmpdc.CultureID = 'en'
    )`;

  const productCount = runQuery(productsQuery);

  if (!productCount || !productCount[0]) {
    console.error("❌ Failed to query product count");
    process.exit(1);
  }

  const totalProducts = productCount[0].TotalProducts;
  console.log(`   ${totalProducts} products with English descriptions\n`);

  // Query 3: Get translation coverage for each culture
  console.log("🌍 Checking translation coverage by culture...\n");

  const coverageQuery = `
    SELECT 
      c.CultureID,
      c.Name as CultureName,
      COUNT(DISTINCT pmpdc.ProductModelID) as TranslatedProducts
    FROM Production.Culture c
    LEFT JOIN Production.ProductModelProductDescriptionCulture pmpdc 
      ON c.CultureID = pmpdc.CultureID
    WHERE c.CultureID != 'en'
    GROUP BY c.CultureID, c.Name
    ORDER BY c.Name`;

  const coverage = runQuery(coverageQuery);

  if (!coverage) {
    console.error("❌ Failed to query translation coverage");
    process.exit(1);
  }

  // Create a map of DB cultures
  const dbCultureMap = {};
  coverage.forEach((c) => {
    dbCultureMap[c.CultureID] = c.TranslatedProducts;
  });

  // Check each UI language
  console.log(
    "Language".padEnd(20) +
      "DB Culture".padEnd(15) +
      "Status".padEnd(15) +
      "Coverage"
  );
  console.log("-".repeat(70));

  let missingCultures = [];
  let incompleteCultures = [];
  let completeCultures = [];

  UI_LANGUAGES.forEach((uiLang) => {
    const dbCulture = CULTURE_MAPPING[uiLang];
    const translatedCount = dbCultureMap[dbCulture] || 0;
    const percent =
      totalProducts > 0
        ? ((translatedCount / totalProducts) * 100).toFixed(1)
        : 0;

    let status = "";
    if (translatedCount === 0) {
      status = "❌ Missing";
      missingCultures.push({ uiLang, dbCulture });
    } else if (translatedCount < totalProducts) {
      status = "⚠️  Incomplete";
      incompleteCultures.push({ uiLang, dbCulture, count: translatedCount });
    } else {
      status = "✅ Complete";
      completeCultures.push({ uiLang, dbCulture });
    }

    console.log(
      uiLang.padEnd(20) +
        (dbCulture || "N/A").padEnd(15) +
        status.padEnd(15) +
        `${translatedCount}/${totalProducts} (${percent}%)`
    );
  });

  // Summary
  console.log("\n=== Summary ===\n");
  console.log(`✅ Complete: ${completeCultures.length}`);
  console.log(`⚠️  Incomplete: ${incompleteCultures.length}`);
  console.log(`❌ Missing: ${missingCultures.length}`);

  if (missingCultures.length > 0) {
    console.log("\n❌ Languages with NO translations:");
    missingCultures.forEach(({ uiLang, dbCulture }) => {
      console.log(`   - ${uiLang} (${dbCulture || "no DB culture"})`);
    });
  }

  if (incompleteCultures.length > 0) {
    console.log("\n⚠️  Languages with INCOMPLETE translations:");
    incompleteCultures.forEach(({ uiLang, dbCulture, count }) => {
      console.log(
        `   - ${uiLang} (${dbCulture}): ${count}/${totalProducts} products`
      );
    });

    console.log("\n💡 To complete translations, run:");
    console.log(
      "   curl -X POST https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/TranslateProductDescriptions_HttpStart"
    );
  }
}

main().catch(console.error);
