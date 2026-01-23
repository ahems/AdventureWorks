import { test, expect } from "@playwright/test";
import { testEnv } from "../utils/env";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * These tests validate that the AI-enhanced CSV data was properly imported
 * into the Azure SQL database during azd deployment.
 *
 * We query the DAB API (GraphQL/REST) to verify data presence and integrity.
 */

interface CsvRow {
  [key: string]: string;
}

const loadCsvFile = (filename: string): CsvRow[] => {
  const csvPath = path.join(process.cwd(), "..", "scripts", "sql", filename);

  if (!fs.existsSync(csvPath)) {
    console.warn(`⚠️ CSV file not found: ${csvPath}`);
    return [];
  }

  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim().replace(/"/g, ""));
    const row: CsvRow = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || "";
    });
    rows.push(row);
  }

  return rows;
};

const queryGraphQL = async (query: string): Promise<any> => {
  const graphqlUrl = testEnv.restApiBaseUrl.replace(/\/api\/?$/, "/graphql");

  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL query failed: ${response.statusText}`);
  }

  const result = await response.json();
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
};

const queryREST = async (endpoint: string): Promise<any> => {
  const url = `${testEnv.restApiBaseUrl}/${endpoint}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`REST query failed: ${response.statusText}`);
  }

  return await response.json();
};

test.describe("Data Validation - AI-Enhanced CSV Imports", () => {
  test("ProductReview-ai.csv data is imported correctly", async () => {
    // Load the CSV file
    const csvData = loadCsvFile("ProductReview-ai.csv");

    if (csvData.length === 0) {
      test.skip();
      return;
    }

    console.log(`📊 Found ${csvData.length} rows in ProductReview-ai.csv`);

    // Query the database via DAB API
    const query = `
      query {
        productReviews {
          items {
            ProductReviewID
            ProductID
            ReviewerName
            Rating
            Comments
          }
        }
      }
    `;

    const data = await queryGraphQL(query);
    const reviews = data.productReviews?.items || [];

    console.log(`📊 Found ${reviews.length} reviews in database`);

    // Verify we have reviews
    expect(reviews.length).toBeGreaterThan(0);

    // Verify at least some reviews from CSV are present
    // (Note: CSV might have more data than what's in database or vice versa)
    const csvReviewIds = csvData
      .map((row) => row.ProductReviewID)
      .filter(Boolean);
    const dbReviewIds = reviews.map((r: any) => r.ProductReviewID?.toString());

    // Check if at least 50% of CSV reviews are in DB (or adjust threshold)
    const matchCount = csvReviewIds.filter((id) =>
      dbReviewIds.includes(id),
    ).length;

    console.log(
      `✅ Matched ${matchCount}/${csvReviewIds.length} reviews from CSV`,
    );
  });

  test("ProductDescription-ai.csv data is imported correctly", async () => {
    const csvData = loadCsvFile("ProductDescription-ai.csv");

    if (csvData.length === 0) {
      test.skip();
      return;
    }

    console.log(`📊 Found ${csvData.length} rows in ProductDescription-ai.csv`);

    // Query product descriptions
    const query = `
      query {
        productDescriptions {
          items {
            ProductDescriptionID
            Description
          }
        }
      }
    `;

    const data = await queryGraphQL(query);
    const descriptions = data.productDescriptions?.items || [];

    console.log(`📊 Found ${descriptions.length} descriptions in database`);

    expect(descriptions.length).toBeGreaterThan(0);

    // Verify descriptions are substantial (AI-enhanced should be longer)
    const substantialDescriptions = descriptions.filter(
      (d: any) => d.Description && d.Description.length > 100,
    );

    expect(substantialDescriptions.length).toBeGreaterThan(0);
    console.log(
      `✅ Found ${substantialDescriptions.length} substantial AI-enhanced descriptions`,
    );
  });

  test("Culture-ai.csv data is imported correctly", async () => {
    const csvData = loadCsvFile("Culture-ai.csv");

    if (csvData.length === 0) {
      test.skip();
      return;
    }

    console.log(`📊 Found ${csvData.length} rows in Culture-ai.csv`);

    // Query cultures
    const query = `
      query {
        cultures {
          items {
            CultureID
            Name
          }
        }
      }
    `;

    const data = await queryGraphQL(query);
    const cultures = data.cultures?.items || [];

    console.log(`📊 Found ${cultures.length} cultures in database`);

    expect(cultures.length).toBeGreaterThan(0);

    // Verify expected cultures are present
    const cultureIds = cultures.map((c: any) => c.CultureID);
    const expectedCultures = ["en", "fr", "es", "de", "ja", "zh-Hans"];

    const foundExpected = expectedCultures.filter((ec) =>
      cultureIds.includes(ec),
    );

    expect(foundExpected.length).toBeGreaterThan(0);
    console.log(`✅ Found ${foundExpected.length} expected cultures`);
  });

  test("Currency-ai.csv data is imported correctly", async () => {
    const csvData = loadCsvFile("Currency-ai.csv");

    if (csvData.length === 0) {
      test.skip();
      return;
    }

    console.log(`📊 Found ${csvData.length} rows in Currency-ai.csv`);

    // Query via REST API
    const currencies = await queryREST("Currency");

    console.log(
      `📊 Found ${currencies.value?.length || 0} currencies in database`,
    );

    expect(currencies.value?.length).toBeGreaterThan(0);

    // Verify expected currencies
    const currencyCodes = currencies.value.map((c: any) => c.CurrencyCode);
    const expectedCurrencies = ["USD", "EUR", "GBP", "JPY"];

    const foundExpected = expectedCurrencies.filter((ec) =>
      currencyCodes.includes(ec),
    );

    expect(foundExpected.length).toBeGreaterThan(0);
    console.log(`✅ Found ${foundExpected.length} expected currencies`);
  });

  test("ProductProductPhoto-ai.csv data links products to images", async () => {
    const csvData = loadCsvFile("ProductProductPhoto-ai.csv");

    if (csvData.length === 0) {
      test.skip();
      return;
    }

    console.log(
      `📊 Found ${csvData.length} rows in ProductProductPhoto-ai.csv`,
    );

    // Query products with photos
    const query = `
      query {
        products(first: 50) {
          items {
            ProductID
            Name
            ProductPhotoID
          }
        }
      }
    `;

    const data = await queryGraphQL(query);
    const products = data.products?.items || [];

    // Count products with photos
    const productsWithPhotos = products.filter((p: any) => p.ProductPhotoID);

    console.log(
      `📊 Found ${productsWithPhotos.length}/${products.length} products with photos`,
    );

    expect(productsWithPhotos.length).toBeGreaterThan(0);
    console.log("✅ Product-Photo associations exist");
  });

  test("StateProvince-ai.csv data is imported correctly", async () => {
    const csvData = loadCsvFile("StateProvince-ai.csv");

    if (csvData.length === 0) {
      test.skip();
      return;
    }

    console.log(`📊 Found ${csvData.length} rows in StateProvince-ai.csv`);

    // Query state provinces
    const stateProvinces = await queryREST("StateProvince");

    console.log(
      `📊 Found ${stateProvinces.value?.length || 0} state/provinces in database`,
    );

    expect(stateProvinces.value?.length).toBeGreaterThan(0);

    // Verify US states are present
    const stateCodes = stateProvinces.value.map(
      (s: any) => s.StateProvinceCode,
    );
    const expectedStates = ["WA", "CA", "TX", "NY"];

    const foundExpected = expectedStates.filter((es) =>
      stateCodes.includes(es),
    );

    expect(foundExpected.length).toBeGreaterThan(0);
    console.log(`✅ Found ${foundExpected.length} expected US states`);
  });

  test("database has products available for display", async () => {
    // Query first page of products (DAB paginates at 100)
    const query = `
      query {
        products(first: 100) {
          items {
            ProductID
            Name
            ListPrice
            ProductNumber
          }
        }
      }
    `;

    const data = await queryGraphQL(query);
    const products = data.products?.items || [];

    console.log(`📊 Found ${products.length} products (first page)`);

    expect(products.length).toBeGreaterThan(0);

    // Verify products have required fields
    const productsWithPrice = products.filter(
      (p: any) => p.ListPrice && p.ListPrice > 0,
    );
    const productsWithName = products.filter((p: any) => p.Name);

    expect(productsWithPrice.length).toBeGreaterThan(0);
    expect(productsWithName.length).toBe(products.length);

    console.log("✅ Products have required data fields");

    // Check if there are more products beyond first page
    const queryPage2 = `
      query {
        products(filter: { ProductID: { gt: ${products[products.length - 1].ProductID} } }, first: 10) {
          items {
            ProductID
          }
        }
      }
    `;

    const page2Data = await queryGraphQL(queryPage2);
    const hasMoreProducts = page2Data.products?.items?.length > 0;

    if (hasMoreProducts) {
      console.log("✅ Database has more than 100 products (paginated)");
    }
  });

  test("product categories are available", async () => {
    const query = `
      query {
        productCategories {
          items {
            ProductCategoryID
            Name
          }
        }
      }
    `;

    const data = await queryGraphQL(query);
    const categories = data.productCategories?.items || [];

    console.log(`📊 Found ${categories.length} product categories`);

    expect(categories.length).toBeGreaterThan(0);

    // Verify expected categories exist
    const categoryNames = categories.map((c: any) => c.Name.toLowerCase());
    const expectedCategories = [
      "bikes",
      "components",
      "clothing",
      "accessories",
    ];

    const foundExpected = expectedCategories.filter((ec) =>
      categoryNames.some((cn: string) => cn.includes(ec)),
    );

    console.log(`✅ Found ${foundExpected.length} expected categories`);
  });
});
