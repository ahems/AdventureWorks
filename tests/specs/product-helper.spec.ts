import { test, expect } from "@playwright/test";
import {
  fetchAllProducts,
  getRandomProducts,
  getRandomProductIds,
  getInStockProducts,
  getInStockProductIds,
  getAllProductsCached,
} from "../utils/productHelper";

test.describe("Product Helper Utility", () => {
  test("fetchAllProducts returns finished goods only by default", async () => {
    const products = await fetchAllProducts();

    expect(products.length).toBeGreaterThan(0);
    console.log(`✅ Fetched ${products.length} finished goods from database`);

    // Verify all products are finished goods
    const allAreFinishedGoods = products.every(
      (p) => p.FinishedGoodsFlag === true,
    );
    expect(allAreFinishedGoods).toBe(true);

    // Verify product structure
    const firstProduct = products[0];
    expect(firstProduct).toHaveProperty("ProductID");
    expect(firstProduct.ProductID).toBeGreaterThan(0);

    // Products should have many unique IDs
    const uniqueIds = new Set(products.map((p) => p.ProductID));
    expect(uniqueIds.size).toBe(products.length); // All should be unique

    console.log(
      `✅ All ${uniqueIds.size} products are finished goods, IDs spanning from ${Math.min(...uniqueIds)} to ${Math.max(...uniqueIds)}`,
    );
  });

  test("fetchAllProducts can include components when requested", async () => {
    const finishedGoodsOnly = await fetchAllProducts(false);
    const allProducts = await fetchAllProducts(true);

    expect(allProducts.length).toBeGreaterThan(finishedGoodsOnly.length);

    const finishedCount = allProducts.filter(
      (p) => p.FinishedGoodsFlag === true,
    ).length;
    const componentCount = allProducts.filter(
      (p) => p.FinishedGoodsFlag === false,
    ).length;

    expect(finishedCount).toBe(finishedGoodsOnly.length);
    expect(componentCount).toBeGreaterThan(0);

    console.log(
      `✅ Total: ${allProducts.length} products (${finishedCount} finished goods, ${componentCount} components)`,
    );
  });

  test("getRandomProducts returns specified number of unique products", async () => {
    const count = 5;
    const products = await getRandomProducts(count);

    expect(products.length).toBe(count);

    // Verify all products are unique
    const productIds = products.map((p) => p.ProductID);
    const uniqueIds = new Set(productIds);
    expect(uniqueIds.size).toBe(count);

    console.log(
      `✅ Retrieved ${count} unique random products: ${productIds.join(", ")}`,
    );
  });

  test("getRandomProductIds returns product IDs from across the database", async () => {
    const count = 10;
    const productIds = await getRandomProductIds(count);

    expect(productIds.length).toBe(count);

    // Verify all IDs are unique
    const uniqueIds = new Set(productIds);
    expect(uniqueIds.size).toBe(count);

    // Verify IDs are distributed (not sequential)
    const sorted = [...productIds].sort((a, b) => a - b);
    const range = sorted[sorted.length - 1] - sorted[0];

    // If we have 10 products and they span more than 50 IDs, they're well distributed
    expect(range).toBeGreaterThan(50);

    console.log(
      `✅ Product IDs span from ${sorted[0]} to ${sorted[sorted.length - 1]} (range: ${range})`,
    );
    console.log(`   Sample IDs: ${productIds.slice(0, 5).join(", ")}...`);
  });

  test("getInStockProducts filters products appropriately", async () => {
    const count = 5;
    const products = await getInStockProducts(count);

    expect(products.length).toBeGreaterThanOrEqual(1); // At least some products should be in stock

    // Verify in-stock criteria
    for (const product of products) {
      expect(product.SellStartDate).toBeTruthy();
      // DiscontinuedDate can be null or undefined
      expect(product.DiscontinuedDate == null).toBe(true);
    }

    console.log(`✅ Found ${products.length} in-stock products`);
  });

  test("product filter works correctly", async () => {
    // Test color filter
    const redProducts = await getRandomProducts(3, (p) =>
      p.Name?.toLowerCase().includes("red"),
    );

    if (redProducts.length > 0) {
      for (const product of redProducts) {
        const hasRedInName = product.Name?.toLowerCase().includes("red");
        expect(hasRedInName).toBe(true);
      }
      console.log(
        `✅ Color filter working: Found ${redProducts.length} red products`,
      );
      console.log(`   Sample: ${redProducts.map((p) => p.Name).join(", ")}`);
    } else {
      console.log("⚠️  No red products found in database");
    }
  });

  test("getAllProductsCached uses caching correctly", async () => {
    const startTime = Date.now();
    const products1 = await getAllProductsCached();
    const firstFetchTime = Date.now() - startTime;

    const startTime2 = Date.now();
    const products2 = await getAllProductsCached();
    const secondFetchTime = Date.now() - startTime2;

    // Second fetch should be much faster (cached)
    expect(products1.length).toBe(products2.length);
    expect(secondFetchTime).toBeLessThan(firstFetchTime / 10); // At least 10x faster

    console.log(
      `✅ Cache working: First fetch ${firstFetchTime}ms, cached fetch ${secondFetchTime}ms`,
    );
  });

  test("getRandomProducts distributes across multiple API pages", async () => {
    // Since DAB API paginates at 100 items, getting 150 products should
    // require fetching from multiple pages if we have that many products
    const allProducts = await fetchAllProducts();

    if (allProducts.length > 100) {
      console.log(
        `✅ Database has ${allProducts.length} products (spans multiple API pages)`,
      );

      // Verify products come from different pages
      // First 100 products
      const firstPageIds = allProducts.slice(0, 100).map((p) => p.ProductID);
      // Last few products (from second+ page)
      const lastPageIds = allProducts
        .slice(allProducts.length - 10)
        .map((p) => p.ProductID);

      // Verify we have products from both ranges
      const minFirstPage = Math.min(...firstPageIds);
      const maxLastPage = Math.max(...lastPageIds);

      console.log(
        `   First page products: ${minFirstPage}-${Math.max(...firstPageIds)}`,
      );
      console.log(
        `   Last page products: ${Math.min(...lastPageIds)}-${maxLastPage}`,
      );

      // Now verify random selection can pick from different parts of the catalog
      const randomIds = await getRandomProductIds(50);

      // Calculate the spread of selected IDs
      const minRandom = Math.min(...randomIds);
      const maxRandom = Math.max(...randomIds);
      const spread = maxRandom - minRandom;

      // Verify the spread covers a significant portion of the product range
      // (at least 30% of the total range)
      const totalRange = maxLastPage - minFirstPage;
      const spreadRatio = spread / totalRange;

      expect(spreadRatio).toBeGreaterThan(0.3);
      console.log(
        `✅ Random selection includes products from multiple pages (spread: ${spread}, ratio: ${(spreadRatio * 100).toFixed(1)}%)`,
      );
    } else {
      console.log(
        `ℹ️  Database has ${allProducts.length} products (single page)`,
      );
    }
  });
});
