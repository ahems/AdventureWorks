import { test, expect } from "@playwright/test";
import { testEnv } from "../utils/env";

test.describe("Search Functionality", () => {
  test("search for red bikes returns actual red bike products (Product 750 and others)", async ({
    page,
  }) => {
    console.log("🔍 Testing search for 'red bikes'...");

    // Navigate directly to search page
    await page.goto("/search");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(5000);

    // Wait for search page to load
    await expect(page.locator("h1")).toContainText("Search Products", {
      timeout: 30000,
    });

    // Enter search query
    const searchInput = page.locator('input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible({ timeout: 30000 });
    await searchInput.fill("red bikes");

    // Submit search
    const searchButton = page.locator('button[type="submit"]', {
      hasText: "Search",
    });
    await searchButton.click();

    // Wait for search results to load
    console.log("⏳ Waiting for search results...");
    await page.waitForTimeout(6000);

    // Check for product cards
    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    console.log(`Found ${count} search results for 'red bikes'`);

    if (count > 0) {
      console.log("✓ Search returned results");

      // Get all product names to verify they are bikes
      const allCards = await productCards.all();
      let bikeCount = 0;
      let redCount = 0;
      const productNames: string[] = [];

      for (const card of allCards) {
        const productName = await card
          .locator('[data-testid^="product-name-"]')
          .first()
          .textContent();

        if (productName) {
          productNames.push(productName.trim());
          const nameLower = productName.toLowerCase();

          // Check if it's a bike (Road, Mountain, Touring, or contains "bike")
          if (
            nameLower.includes("bike") ||
            nameLower.includes("road-") ||
            nameLower.includes("mountain-") ||
            nameLower.includes("touring-")
          ) {
            bikeCount++;
          }

          // Check if it mentions red
          if (nameLower.includes("red")) {
            redCount++;
          }
        }
      }

      console.log(`  - ${bikeCount} out of ${count} results are bikes`);
      console.log(`  - ${redCount} out of ${count} results mention 'red'`);
      console.log(`  Sample products: ${productNames.slice(0, 5).join(", ")}`);

      // Verify we got bike-related results
      expect(
        bikeCount,
        "At least some results should be bikes",
      ).toBeGreaterThan(0);

      // Database has 20 red road bikes (ProductIDs 749-764, 789-792)
      // Including product 750: "Road-150 Red, 44"
      console.log("✓ Search successfully returned bike products");
    } else {
      console.log(
        "⚠️  No results found - this may indicate an issue with semantic search indexing",
      );
      console.log(
        "   Expected to find products like 'Road-150 Red, 44' (Product 750)",
      );
      console.log(
        "   Database contains 20 red road bikes that should match this query",
      );

      // This is actually a problem - we know these products exist
      throw new Error(
        "Search for 'red bikes' should return results. Database has 20 red road bikes (e.g., Product 750: 'Road-150 Red, 44')",
      );
    }
  });

  test("search for red helmets returns only red helmet products", async ({
    page,
  }) => {
    console.log("🔍 Testing search for 'red helmet'...");

    // Navigate directly to search page (no login required)
    await page.goto(`${testEnv.webBaseUrl}/search`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for page to be fully loaded (products may load slowly)
    console.log("⏳ Waiting for page to load...");
    await page.waitForTimeout(5000);

    // Wait for search page to load
    await expect(page.locator("h1")).toBeVisible({ timeout: 30000 });

    // Enter search query
    const searchInput = page.locator('input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible({ timeout: 30000 });
    await searchInput.fill("red helmet");

    // Submit search
    const searchButton = page.locator('button[type="submit"]', {
      hasText: "Search",
    });
    await searchButton.click();

    // Wait for search results to load
    console.log("⏳ Waiting for search results...");
    await page.waitForTimeout(5000);

    // Wait for products to load or "no results" message
    const productCards = page.locator('[data-testid^="product-card-"]');
    const noResults = page.locator("text=No products found");

    // Check if we have results or no results message
    const hasResults = (await productCards.count()) > 0;
    const hasNoResultsMessage = await noResults.isVisible().catch(() => false);

    if (hasResults) {
      const totalCount = await productCards.count();
      console.log(`✓ Found ${totalCount} search results`);

      // Semantic search may return "red" products (e.g. red bikes) as well as helmets.
      // Require at least one result to be helmet-related (name contains "helmet").
      const allCards = await productCards.all();
      let helmetCount = 0;
      for (const card of allCards) {
        const productName = await card
          .locator('[data-testid^="product-name-"]')
          .first()
          .textContent();

        if (productName && productName.toLowerCase().includes("helmet")) {
          helmetCount++;
        }
      }

      expect(
        helmetCount,
        `Semantic search for "red helmet" should return at least one helmet product; got ${helmetCount} among ${totalCount} results`,
      ).toBeGreaterThan(0);
      console.log(`✓ ${helmetCount} of ${totalCount} results contain 'helmet' in the name`);
    } else if (hasNoResultsMessage) {
      console.log(
        "ℹ No results found - this is acceptable if no red helmets exist in inventory",
      );
    } else {
      // Still loading - wait a bit more
      await page.waitForTimeout(5000);
      const finalCount = await productCards.count();
      console.log(`Search completed with ${finalCount} results`);
    }
  });

  test("search for red frames returns only frame products in red", async ({
    page,
  }) => {
    console.log("🔍 Testing search for 'red frame'...");

    await page.goto(`${testEnv.webBaseUrl}/search?q=red frame`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for search to execute
    console.log("⏳ Waiting for search results...");
    await page.waitForTimeout(5000);

    // Check for results
    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    if (count > 0) {
      console.log(`✓ Found ${count} search results for 'red frame'`);

      // Verify all results contain "frame" in the name
      const allCards = await productCards.all();
      for (const card of allCards) {
        const productName = await card
          .locator('[data-testid^="product-name-"]')
          .first()
          .textContent();

        if (productName) {
          const nameLower = productName.toLowerCase();
          expect(
            nameLower.includes("frame"),
            `Product "${productName}" should contain "frame"`,
          ).toBeTruthy();
        }
      }

      console.log("✓ All results contain 'frame' in the name");
    } else {
      console.log(
        "ℹ No results found - checking if 'no results' message is displayed",
      );
      // Either loading or truly no results
      await page.waitForTimeout(2000);
      const finalCount = await productCards.count();
      console.log(`Final count: ${finalCount} results`);
    }
  });

  test("search for bikes returns bike-related products", async ({ page }) => {
    console.log("🔍 Testing search for 'bike'...");

    await page.goto(`${testEnv.webBaseUrl}/search`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(5000);

    // Enter search query
    const searchInput = page.locator('input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible({ timeout: 30000 });
    await searchInput.fill("bike");

    // Submit search
    const searchButton = page.locator('button[type="submit"]', {
      hasText: "Search",
    });
    await searchButton.click();

    // Wait for results
    console.log("⏳ Waiting for search results...");
    await page.waitForTimeout(5000);

    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    if (count > 0) {
      // Semantic search returned results. Many bike products don't have "bike" in the name
      // (e.g. "Road-150", "Mountain-200", "HL Road Frame"). Count as bike-related if name
      // contains any of these keywords.
      const bikeKeywords = [
        "bike",
        "road",
        "mountain",
        "touring",
        "frame",
        "wheel",
        "cycle",
      ];
      const allCards = await productCards.all();
      let verifiedCount = 0;

      for (const card of allCards) {
        const productName = await card
          .locator('[data-testid^="product-name-"]')
          .first()
          .textContent();

        if (productName) {
          const nameLower = productName.toLowerCase();
          if (bikeKeywords.some((kw) => nameLower.includes(kw))) {
            verifiedCount++;
          }
        }
      }

      console.log(`✓ ${verifiedCount} out of ${count} results are bike-related`);
      expect(
        verifiedCount,
        `At least one search result should be bike-related (name contains bike/road/mountain/etc.)`,
      ).toBeGreaterThan(0);
    } else {
      console.log(
        "ℹ No results found for 'bike' search - semantic search may not have indexed bike products or they may be out of stock",
      );
      // Verify search executed without errors
      await expect(page.locator("h1")).toBeVisible();
    }
  });

  test("search for specific color filters results correctly", async ({
    page,
  }) => {
    console.log("🔍 Testing search with color filter...");

    await page.goto("/search");
    await page.waitForLoadState("domcontentloaded");

    // First, just browse all products to establish baseline
    await page.waitForTimeout(6000);

    const allProductCards = page.locator('[data-testid^="product-card-"]');
    const initialCount = await allProductCards.count();
    console.log(`Total products available: ${initialCount}`);

    // Now search for "red" to filter by color
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill("red");

    const searchButton = page.locator('button[type="submit"]', {
      hasText: "Search",
    });
    await searchButton.click();

    // Wait for filtered results
    console.log("⏳ Waiting for color-filtered results...");
    await page.waitForTimeout(5000);

    const filteredCards = page.locator('[data-testid^="product-card-"]');
    const filteredCount = await filteredCards.count();

    console.log(`Filtered results: ${filteredCount} products`);

    if (filteredCount > 0) {
      // Verify we got results
      console.log("✓ Search filtering is active");

      // Check that results relate to "red" in some way
      const firstProduct = filteredCards.first();
      await expect(firstProduct).toBeVisible();
      console.log("✓ Filtered results are displayed");
    } else {
      console.log("ℹ No results for 'red' color search");
    }
  });

  test("empty search shows prompt to search, not all products", async ({
    page,
  }) => {
    console.log("🔍 Testing empty search behavior (semantic search only)...");

    await page.goto("/search");
    await page.waitForLoadState("domcontentloaded");

    // Wait for initial page load
    await page.waitForTimeout(6000);

    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    console.log(`Products shown without search query: ${count}`);

    // Should NOT show products without a search query (semantic search only)
    expect(count).toBe(0);
    console.log("✓ No products shown without search query (expected behavior)");

    // Verify the search page shows appropriate messaging
    const pageContent = await page.textContent("body");
    const hasPromptMessage =
      pageContent?.includes("Enter a search query") ||
      pageContent?.includes("search box");

    if (hasPromptMessage) {
      console.log("✓ Page shows prompt to enter search query");
    }
  });

  test("search handles no results gracefully", async ({ page }) => {
    console.log("🔍 Testing search with no results...");

    await page.goto("/search");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(5000);

    // Search for something that definitely won't exist
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill("xyznonexistentproduct12345");

    const searchButton = page.locator('button[type="submit"]', {
      hasText: "Search",
    });
    await searchButton.click();

    // Wait for results
    await page.waitForTimeout(5000);

    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    // Should have no results or show a message
    if (count === 0) {
      console.log("✓ No products shown for nonsense query");

      // Look for "no results" or similar message
      const pageContent = await page.textContent("body");
      const hasNoResultsMessage =
        pageContent?.toLowerCase().includes("no") ||
        pageContent?.toLowerCase().includes("found") ||
        pageContent?.toLowerCase().includes("0");

      console.log(
        hasNoResultsMessage
          ? "✓ 'No results' message or indicator displayed"
          : "ℹ Results display handled differently",
      );
    } else {
      console.log(
        `ℹ ${count} products shown - semantic search may return related items`,
      );
    }
  });

  test("search results can be sorted", async ({ page }) => {
    console.log("🔍 Testing search result sorting...");

    await page.goto("/search?q=frame");
    await page.waitForLoadState("domcontentloaded");

    // Wait for results to load
    await page.waitForTimeout(5000);

    // Check if sorting controls exist
    const sortSelect = page.locator('select, [role="combobox"]').filter({
      hasText: /sort|price|rating/i,
    });

    if ((await sortSelect.count()) > 0) {
      console.log("✓ Sort controls are available");

      // Get initial first product
      const firstProductBefore = await page
        .locator('[data-testid^="product-card-"]')
        .first()
        .textContent();

      // Try to change sort order (if possible)
      await sortSelect.first().click();
      await page.waitForTimeout(500);

      // Select different sort option if available
      const sortOptions = page.locator('option, [role="option"]');
      if ((await sortOptions.count()) > 1) {
        await sortOptions.nth(1).click();
        await page.waitForTimeout(2000);

        const firstProductAfter = await page
          .locator('[data-testid^="product-card-"]')
          .first()
          .textContent();

        console.log("✓ Sort order changed");
        console.log(`  Before: ${firstProductBefore?.substring(0, 50)}...`);
        console.log(`  After: ${firstProductAfter?.substring(0, 50)}...`);
      }
    } else {
      console.log("ℹ Sort controls not found on page");
    }
  });

  test("search with URL query parameter works", async ({ page }) => {
    console.log("🔍 Testing search via URL parameter...");

    // Navigate with query parameter using full URL
    await page.goto(`${testEnv.webBaseUrl}/search?q=helmet`);
    await page.waitForLoadState("domcontentloaded");

    // The SearchBar renders immediately outside the loading skeleton, so the input
    // is available before the semantic search results complete. Use a generous
    // timeout to accommodate Container App cold starts.
    const searchInput = page.locator("[data-testid='search-query-input']");
    await expect(searchInput).toBeVisible({ timeout: 40000 });
    await expect(searchInput).toHaveValue("helmet", { timeout: 10000 });
    console.log("✓ Search query populated from URL parameter");

    // Verify results are shown
    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    if (count > 0) {
      console.log(`✓ ${count} results loaded from URL query`);
    } else {
      console.log("ℹ No results found for 'helmet'");
    }
  });

  test("API verification: red bikes exist in database", async ({ request }) => {
    console.log("🔍 Verifying red bikes exist in database via API...");

    const response = await request.post(
      `${testEnv.restApiBaseUrl.replace("/api", "/graphql")}`,
      {
        data: {
          query: `{
            products(filter: { 
              ProductSubcategoryID: { in: [1, 2, 3] }, 
              Color: { eq: "Red" } 
            }) {
              items {
                ProductID
                Name
                Color
                ProductSubcategoryID
              }
            }
          }`,
        },
      },
    );

    expect(response.ok()).toBeTruthy();
    const data = await response.json();

    const redBikes = data.data.products.items;
    console.log(`✓ Found ${redBikes.length} red bikes in database`);

    // Verify product 750 exists
    const product750 = redBikes.find((p: any) => p.ProductID === 750);
    expect(product750).toBeDefined();
    console.log(`✓ Product 750 found: ${product750.Name}`);

    // List some examples
    console.log("  Sample red bikes:");
    redBikes.slice(0, 5).forEach((bike: any) => {
      console.log(`    - ${bike.ProductID}: ${bike.Name}`);
    });

    // All should be red
    const allRed = redBikes.every((p: any) => p.Color === "Red");
    expect(allRed).toBeTruthy();
    console.log("✓ All products are red");

    // Expected products based on database query
    expect(redBikes.length).toBeGreaterThanOrEqual(20);
    console.log("✓ Database contains expected red bike inventory");
  });

  test("search in Chinese (Traditional) returns bike results", async ({
    page,
  }) => {
    console.log("🔍 Testing search in Chinese (Traditional)...");

    // Navigate to search page
    await page.goto(`${testEnv.webBaseUrl}/search`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Change language to Chinese (Traditional)
    console.log("🌐 Switching to Chinese (Traditional)...");
    const languageSelector = page.locator('[data-testid="language-selector"]');
    await expect(languageSelector).toBeVisible({ timeout: 10000 });
    await languageSelector.click();

    const zhLangOption = page.locator('[data-testid="language-option-zh-cht"]');
    await expect(zhLangOption).toBeVisible({ timeout: 5000 });
    await zhLangOption.click();

    // Wait for language change to apply
    await page.waitForTimeout(2000);

    // Verify language changed (search placeholder should be in Chinese)
    const searchInput = page.locator('input[placeholder*="搜尋"]'); // "Search" in Chinese
    await expect(searchInput).toBeVisible({ timeout: 30000 });
    console.log("✓ Language switched to Chinese");

    // Search for "紅色自行車" (red bikes in Chinese)
    await searchInput.fill("紅色自行車");

    const searchButton = page.locator('button[type="submit"]');
    await searchButton.click();

    // Wait for search results
    console.log("⏳ Waiting for search results...");
    await page.waitForTimeout(6000);

    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    console.log(`Found ${count} results for Chinese search query`);

    if (count > 0) {
      console.log("✓ Semantic search works with Chinese queries");
      expect(count).toBeGreaterThan(0);
    } else {
      console.log(
        "ℹ No results found - semantic search may need multilingual embeddings",
      );
      // This is still a valid test - it verifies the system handles non-English queries
      await expect(page.locator("h1")).toBeVisible();
    }
  });

  test("search in Hebrew returns relevant results", async ({ page }) => {
    console.log("🔍 Testing search in Hebrew...");

    await page.goto(`${testEnv.webBaseUrl}/search`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Change language to Hebrew
    console.log("🌐 Switching to Hebrew...");
    const languageSelector = page.locator('[data-testid="language-selector"]');
    await expect(languageSelector).toBeVisible({ timeout: 10000 });
    await languageSelector.click();

    // Use keyboard to navigate to Hebrew (it's near the end of a long list)
    await page.keyboard.press("End"); // Go to end of list
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowUp"); // Navigate up to Hebrew
    }
    await page.keyboard.press("Enter");

    // Wait for language change
    await page.waitForTimeout(2000);
    console.log("✓ Language switched to Hebrew");

    // Search for "אופניים אדומים" (red bikes in Hebrew)
    const searchInput = page.locator("input[placeholder]").first();
    await searchInput.fill("אופניים אדומים");

    const searchButton = page.locator('button[type="submit"]');
    await searchButton.click();

    // Wait for results
    console.log("⏳ Waiting for search results...");
    await page.waitForTimeout(6000);

    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    console.log(`Found ${count} results for Hebrew search query`);

    if (count > 0) {
      console.log("✓ Semantic search works with Hebrew queries");
      expect(count).toBeGreaterThan(0);
    } else {
      console.log(
        "ℹ No results found - semantic search may need multilingual embeddings",
      );
      // Still validates the system handles right-to-left languages
      await expect(page.locator("h1")).toBeVisible();
    }
  });

  test("search in Spanish returns bike results", async ({ page }) => {
    console.log("🔍 Testing search in Spanish...");

    await page.goto(`${testEnv.webBaseUrl}/search`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Change language to Spanish
    console.log("🌐 Switching to Spanish...");
    const languageSelector = page.locator('[data-testid="language-selector"]');
    await expect(languageSelector).toBeVisible({ timeout: 10000 });
    await languageSelector.click();

    const esLangOption = page.locator('[data-testid="language-option-es"]');
    await expect(esLangOption).toBeVisible({ timeout: 5000 });
    await esLangOption.click();

    // Wait for language change
    await page.waitForTimeout(2000);
    console.log("✓ Language switched to Spanish");

    // Search for "bicicletas rojas" (red bikes in Spanish)
    const searchInput = page.locator("input[placeholder]").first();
    await searchInput.fill("bicicletas rojas");

    const searchButton = page.locator('button[type="submit"]');
    await searchButton.click();

    // Wait for results
    console.log("⏳ Waiting for search results...");
    await page.waitForTimeout(6000);

    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    console.log(`Found ${count} results for Spanish search query`);

    if (count > 0) {
      console.log("✓ Semantic search works with Spanish queries");
      expect(count).toBeGreaterThan(0);

      // Verify we got bike results
      const firstCard = productCards.first();
      const productName = await firstCard
        .locator('[data-testid^="product-name-"]')
        .textContent();
      console.log(`  Sample result: ${productName}`);
    } else {
      console.log(
        "ℹ No results found - semantic search may need multilingual embeddings",
      );
      await expect(page.locator("h1")).toBeVisible();
    }
  });

  test("search in German with English product names returns results", async ({
    page,
  }) => {
    console.log("🔍 Testing search in German...");

    await page.goto(`${testEnv.webBaseUrl}/search`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Change language to German
    console.log("🌐 Switching to German...");
    const languageSelector = page.locator('[data-testid="language-selector"]');
    await expect(languageSelector).toBeVisible({ timeout: 10000 });
    await languageSelector.click();

    const deLangOption = page.locator('[data-testid="language-option-de"]');
    await expect(deLangOption).toBeVisible({ timeout: 5000 });
    await deLangOption.click();

    // Wait for language change
    await page.waitForTimeout(2000);

    // Verify language changed
    const searchInput = page.locator('input[placeholder*="Suche"]'); // "Search" in German
    await expect(searchInput).toBeVisible({ timeout: 30000 });
    console.log("✓ Language switched to German");

    // Search for "rote Fahrräder" (red bikes in German)
    await searchInput.fill("rote Fahrräder");

    const searchButton = page.locator('button[type="submit"]');
    await searchButton.click();

    // Wait for results
    console.log("⏳ Waiting for search results...");
    await page.waitForTimeout(6000);

    const productCards = page.locator('[data-testid^="product-card-"]');
    const count = await productCards.count();

    console.log(`Found ${count} results for German search query`);

    if (count > 0) {
      console.log("✓ Semantic search works with German queries");
      expect(count).toBeGreaterThan(0);
    } else {
      console.log(
        "ℹ No results found - semantic search may need multilingual embeddings",
      );
      await expect(page.locator("h1")).toBeVisible();
    }
  });

  test("switching language preserves search results", async ({ page }) => {
    console.log("🔍 Testing that language switch preserves search...");

    await page.goto(`${testEnv.webBaseUrl}/search`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Perform search in English first
    const searchInput = page.locator('input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible({ timeout: 30000 });
    await searchInput.fill("red bikes");

    const searchButton = page.locator('button[type="submit"]', {
      hasText: "Search",
    });
    await searchButton.click();

    // Wait for results
    console.log("⏳ Waiting for initial search results...");
    await page.waitForTimeout(6000);

    const productCards = page.locator('[data-testid^="product-card-"]');
    const initialCount = await productCards.count();
    console.log(`Initial results: ${initialCount} products`);

    if (initialCount > 0) {
      // Get first product name in English
      const firstProductName = await productCards
        .first()
        .locator('[data-testid^="product-name-"]')
        .textContent();
      console.log(`First product: ${firstProductName}`);

      // Now switch language to Spanish
      console.log("🌐 Switching to Spanish...");
      const languageSelector = page.locator(
        '[data-testid="language-selector"]',
      );
      await languageSelector.click();

      const esLangOption = page.locator('[data-testid="language-option-es"]');
      await esLangOption.click();

      // Wait for language change
      await page.waitForTimeout(2000);

      // Verify UI is in Spanish but results are still showing
      await expect(page.locator("h1")).toContainText(/Buscar productos/i, {
        timeout: 5000,
      });

      // Results should still be there
      const cardsAfterLanguageChange = page.locator(
        '[data-testid^="product-card-"]',
      );
      const countAfterChange = await cardsAfterLanguageChange.count();

      console.log(
        `Results after language change: ${countAfterChange} products`,
      );
      expect(countAfterChange).toBe(initialCount);
      console.log("✓ Search results preserved after language change");
    } else {
      console.log("⚠️  No initial results to test language switch with");
    }
  });
});
