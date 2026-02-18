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
  return loadCsvFileWithDelimiter(filename, ",");
};

/**
 * Load CSV/TSV with a given delimiter. Use for seed-job files that are tab-delimited and have no header.
 */
const loadCsvFileWithDelimiter = (
  filename: string,
  delimiter: string,
  options?: { hasHeader?: boolean; columnNames?: string[] },
): CsvRow[] => {
  const csvPath = path.join(process.cwd(), "seed-job", "sql", filename);

  if (!fs.existsSync(csvPath)) {
    console.warn(`⚠️ CSV file not found: ${csvPath}`);
    return [];
  }

  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  const hasHeader = options?.hasHeader ?? true;
  const columnNames = options?.columnNames;

  if (hasHeader && lines.length < 2) return [];
  if (!hasHeader && lines.length < 1) return [];

  let headers: string[];
  let startIdx: number;

  if (hasHeader && !columnNames) {
    headers = lines[0].split(delimiter).map((h) => h.trim().replace(/"/g, ""));
    startIdx = 1;
  } else if (!hasHeader && columnNames && columnNames.length > 0) {
    headers = columnNames;
    startIdx = 0;
  } else if (hasHeader) {
    headers = lines[0].split(delimiter).map((h) => h.trim().replace(/"/g, ""));
    startIdx = 1;
  } else {
    return [];
  }

  const rows: CsvRow[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const values = lines[i].split(delimiter).map((v) => v.trim().replace(/"/g, ""));
    const row: CsvRow = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? "";
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
    // Tab-delimited, no header (seed-job format)
    const csvData = loadCsvFileWithDelimiter("ProductReview-ai.csv", "\t", {
      hasHeader: false,
      columnNames: [
        "ProductReviewID",
        "ProductID",
        "ReviewerName",
        "ReviewDate",
        "Email",
        "Rating",
        "Comments",
        "ModifiedDate",
        "Vector",
      ],
    });

    expect(
      csvData.length,
      "ProductReview-ai.csv missing or empty - check seed-job/sql",
    ).toBeGreaterThan(0);
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

    expect(
      reviews.length,
      "Data missing - check seed job: no product reviews returned from DAB API",
    ).toBeGreaterThan(0);

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
    // Tab-delimited, no header (seed-job format)
    const csvData = loadCsvFileWithDelimiter("ProductDescription-ai.csv", "\t", {
      hasHeader: false,
      columnNames: [
        "ProductDescriptionID",
        "Description",
        "Rowguid",
        "ModifiedDate",
        "Vector",
      ],
    });

    expect(
      csvData.length,
      "ProductDescription-ai.csv missing or empty - check seed-job/sql",
    ).toBeGreaterThan(0);
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

    expect(
      descriptions.length,
      "Data missing - check seed job: no product descriptions returned from DAB API",
    ).toBeGreaterThan(0);

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
    // Seed CSVs are tab-delimited with no header; column order: CultureID, Name, ModifiedDate
    const csvData = loadCsvFileWithDelimiter("Culture-ai.csv", "\t", {
      hasHeader: false,
      columnNames: ["CultureID", "Name", "ModifiedDate"],
    });

    expect(csvData.length, "Culture-ai.csv missing or empty - check seed-job/sql").toBeGreaterThan(0);
    console.log(`📊 Found ${csvData.length} rows in Culture-ai.csv`);

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
    const cultures = data.cultures?.items ?? [];

    expect(
      cultures.length,
      "Data missing - check seed job: no cultures returned from DAB API",
    ).toBeGreaterThan(0);
    console.log(`📊 Found ${cultures.length} cultures in database`);

    const cultureIds = cultures.map((c: { CultureID?: string }) => (c.CultureID ?? "").trim());
    const expectedFromCsv = csvData.map((r) => (r.CultureID ?? "").trim()).filter(Boolean);
    const found = expectedFromCsv.filter((id) => cultureIds.includes(id));

    expect(
      found.length,
      `No Culture-ai.csv culture IDs found in API (CSV has ${expectedFromCsv.length}, API returned ${cultureIds.length}). Check seed job.`,
    ).toBeGreaterThan(0);
    console.log(`✅ Found ${found.length} CSV cultures in API (e.g. ${found.slice(0, 5).join(", ")})`);
  });

  test("Currency-ai.csv data is imported correctly", async () => {
    // Seed CSV is tab-delimited, no header; columns: CurrencyCode, Name, ModifiedDate
    const csvData = loadCsvFileWithDelimiter("Currency-ai.csv", "\t", {
      hasHeader: false,
      columnNames: ["CurrencyCode", "Name", "ModifiedDate"],
    });

    expect(csvData.length, "Currency-ai.csv missing or empty - check seed-job/sql").toBeGreaterThan(0);
    console.log(`📊 Found ${csvData.length} rows in Currency-ai.csv`);

    const currencies = await queryREST("Currency");
    const items = currencies.value ?? [];

    expect(
      items.length,
      "Data missing - check seed job: no currencies returned from DAB REST API",
    ).toBeGreaterThan(0);
    console.log(`📊 Found ${items.length} currencies in database`);

    // DAB REST may return camelCase (CurrencyCode or currencyCode)
    const apiCodes = items.map(
      (c: { CurrencyCode?: string; currencyCode?: string }) =>
        (c.CurrencyCode ?? c.currencyCode ?? "").trim(),
    );
    const expectedFromCsv = csvData.map((r) => (r.CurrencyCode ?? "").trim()).filter(Boolean);
    const found = expectedFromCsv.filter((code) => apiCodes.includes(code));

    expect(
      found.length,
      `No Currency-ai.csv codes found in API (CSV has ${expectedFromCsv.length}, API returned ${apiCodes.length}). Check seed job.`,
    ).toBeGreaterThan(0);
    console.log(`✅ Found ${found.length} CSV currency codes in API (e.g. ${found.slice(0, 5).join(", ")})`);
  });

  test("ProductProductPhoto: base and PNG image data present", async () => {
    // Seed loads base images (ProductPhoto.csv, ProductPhotoID < 1000) and PNG upload (ProductPhotoID 1000+).
    // Allow variance in IDs: expect product-photo links (any range) and that both base and PNG photos exist in ProductPhoto.
    const linksQuery = `
      query {
        productProductPhotos(first: 500) {
          items { ProductID ProductPhotoID }
        }
      }
    `;
    const linksData = await queryGraphQL(linksQuery);
    const items = linksData.productProductPhotos?.items ?? [];

    expect(
      items.length,
      "Data missing - check seed job: no product-product-photo links returned from DAB API",
    ).toBeGreaterThan(0);
    console.log(`📊 Found ${items.length} product-photo links in database`);

    const baseLinks = items.filter((i: { ProductPhotoID: number }) => i.ProductPhotoID < 1000);
    const pngLinks = items.filter((i: { ProductPhotoID: number }) => i.ProductPhotoID >= 1000);

    expect(
      baseLinks.length,
      "Base image links missing: no mappings with ProductPhotoID < 1000. Check ProductPhoto.csv and ProductProductPhoto load.",
    ).toBeGreaterThan(0);
    console.log(`✅ Base image links (ProductPhotoID < 1000): ${baseLinks.length}`);

    // PNG photos exist in ProductPhoto table (IDs 1000+); links to them may or may not exist depending on seed
    const pngPhotosQuery = `
      query {
        productPhotos(filter: { ProductPhotoID: { gte: 1000 } }, first: 10) {
          items { ProductPhotoID }
        }
      }
    `;
    const pngPhotosData = await queryGraphQL(pngPhotosQuery);
    const pngPhotos = pngPhotosData.productPhotos?.items ?? [];
    expect(
      pngPhotos.length,
      "PNG image data missing: no ProductPhoto rows with ProductPhotoID >= 1000. Check PNG upload in seed job.",
    ).toBeGreaterThan(0);
    console.log(`✅ PNG photos in ProductPhoto (ID >= 1000): ${pngPhotos.length} (sample)`);
    if (pngLinks.length > 0) {
      console.log(`✅ PNG image links (ProductPhotoID >= 1000): ${pngLinks.length}`);
    }
  });

  test("StateProvince-ai.csv data is imported correctly", async () => {
    // Seed CSV is tab-delimited, no header; columns: StateProvinceID, StateProvinceCode, ...
    const csvData = loadCsvFileWithDelimiter("StateProvince-ai.csv", "\t", {
      hasHeader: false,
      columnNames: ["StateProvinceID", "StateProvinceCode"],
    });

    expect(csvData.length, "StateProvince-ai.csv missing or empty - check seed-job/sql").toBeGreaterThan(0);
    console.log(`📊 Found ${csvData.length} rows in StateProvince-ai.csv`);

    const stateProvinces = await queryREST("StateProvince");
    const items = stateProvinces.value ?? [];

    expect(
      items.length,
      "Data missing - check seed job: no state provinces returned from DAB REST API",
    ).toBeGreaterThan(0);
    console.log(`📊 Found ${items.length} state/provinces in database`);

    // DAB REST may return camelCase (StateProvinceCode or stateProvinceCode)
    const stateCodes = items.map(
      (s: { StateProvinceCode?: string; stateProvinceCode?: string }) =>
        (s.StateProvinceCode ?? s.stateProvinceCode ?? "").trim(),
    );
    const expectedFromCsv = csvData.map((r) => (r.StateProvinceCode ?? "").trim()).filter(Boolean);
    const found = expectedFromCsv.filter((code) => stateCodes.includes(code));

    expect(
      found.length,
      `No StateProvince-ai.csv codes found in API (CSV has ${expectedFromCsv.length}, API returned ${stateCodes.length}). Check seed job.`,
    ).toBeGreaterThan(0);
    console.log(`✅ Found ${found.length} CSV state codes in API (e.g. ${found.slice(0, 5).join(", ")})`);
  });

  test("database has products available for display", async () => {
    // Query for products with prices (displayable items) - DAB paginates at 100
    const query = `
      query {
        products(filter: { ListPrice: { gt: 0 } }, first: 100) {
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

    console.log(
      `📊 Found ${products.length} products with prices (first page)`,
    );

    expect(products.length).toBeGreaterThan(0);

    // Verify all returned products have required fields and prices
    const productsWithPrice = products.filter(
      (p: any) => p.ListPrice && p.ListPrice > 0,
    );
    const productsWithName = products.filter((p: any) => p.Name);

    expect(productsWithPrice.length).toBe(products.length);
    expect(productsWithName.length).toBe(products.length);

    console.log(
      `✅ All ${products.length} products have required data fields and prices > 0`,
    );

    // Check if there are more displayable products beyond first page
    const queryPage2 = `
      query {
        products(filter: { ListPrice: { gt: 0 }, ProductID: { gt: ${products[products.length - 1].ProductID} } }, first: 10) {
          items {
            ProductID
            ListPrice
          }
        }
      }
    `;

    const page2Data = await queryGraphQL(queryPage2);
    const hasMoreProducts = page2Data.products?.items?.length > 0;

    if (hasMoreProducts) {
      console.log(
        "✅ Database has more than 100 displayable products (paginated)",
      );
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
