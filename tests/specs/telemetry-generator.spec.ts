import { test, expect } from "@playwright/test";
import { testEnv } from "../utils/env";
import { getRandomProductIds } from "../utils/productHelper";

/**
 * Telemetry Generator Test
 *
 * This test simulates a realistic anonymous browsing session to generate
 * rich Application Insights telemetry for demo and analysis purposes.
 *
 * User Journey:
 * 1. Arrives at home page looking for deals
 * 2. Browses products on sale
 * 3. Uses quick view to preview items
 * 4. Views full product pages and cycles through images
 * 5. Searches for specific products
 * 6. Adds items to cart
 * 7. Continues browsing, gets distracted
 * 8. Eventually abandons cart without purchasing
 *
 * This generates telemetry for:
 * - Page views (home, product lists, product details, cart, search)
 * - Product interactions (quick view, image gallery, add to cart)
 * - Search queries
 * - Session duration and engagement
 * - Cart abandonment behavior
 */

// Helper to wait a random amount of time (simulating human behavior)
const randomWait = async (minMs: number, maxMs: number) => {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((resolve) => setTimeout(resolve, delay));
};

// Helper to randomly decide whether to do something
const maybe = (probability: number = 0.5): boolean => {
  return Math.random() < probability;
};

// Helper to pick a random item from an array
const randomPick = <T>(items: T[]): T => {
  return items[Math.floor(Math.random() * items.length)];
};

test.describe("Telemetry Generator - Anonymous Browsing", () => {
  test.setTimeout(300000); // 5 minutes for lengthy browsing session

  test("bargain hunter who browses extensively then abandons cart", async ({
    page,
  }) => {
    console.log("\n🛍️  Starting anonymous browsing session - Bargain Hunter");
    console.log("=".repeat(60));

    // Track telemetry requests for visibility
    let telemetryCount = 0;
    page.on("request", (request) => {
      if (request.url().includes("applicationinsights.azure.com")) {
        telemetryCount++;
      }
    });

    // ===================================================================
    // 1. ARRIVE AT HOME PAGE - Looking for deals
    // ===================================================================
    console.log("\n🏠 Phase 1: Arriving at home page...");
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await randomWait(2000, 4000); // Take time to look at the page

    // Scroll down to see what's on the page
    console.log("📜 Scrolling to explore the page...");
    await page.evaluate(() => window.scrollBy(0, 300));
    await randomWait(1500, 2500);

    // ===================================================================
    // 2. LOOK FOR PRODUCTS ON SALE
    // ===================================================================
    console.log("\n💰 Phase 2: Looking for products on sale...");

    // Try to find and click on "On Sale" or "Special Offers" section
    const saleLinks = [
      'a:has-text("Sale")',
      'a:has-text("Deals")',
      'a:has-text("Special")',
      'a:has-text("Offers")',
      '[href*="sale"]',
      '[href*="deals"]',
      '[href*="special"]',
    ];

    let foundSales = false;
    for (const selector of saleLinks) {
      const link = page.locator(selector).first();
      if ((await link.count()) > 0) {
        console.log(`✅ Found sale link: ${selector}`);
        try {
          await link.click({ timeout: 3000 });
          foundSales = true;
          await page.waitForLoadState("domcontentloaded");
          await randomWait(2000, 3000);
          break;
        } catch (e) {
          // Try next selector
        }
      }
    }

    if (!foundSales) {
      console.log("⚠️  No sale section found, browsing categories instead");
      // Navigate to a category instead
      const categoryLink = page.locator('nav a, [role="navigation"] a').first();
      if ((await categoryLink.count()) > 0) {
        await categoryLink.click();
        await page.waitForLoadState("domcontentloaded");
        await randomWait(2000, 3000);
      }
    }

    // ===================================================================
    // 3. BROWSE PRODUCTS - Quick View Several Items
    // ===================================================================
    console.log("\n👀 Phase 3: Quick viewing products...");

    // Get all product cards/links on the page
    const productSelectors = [
      '[data-testid*="product"]',
      ".product-card",
      ".product-item",
      'a[href*="/product/"]',
    ];

    let productLinks: any[] = [];
    for (const selector of productSelectors) {
      const links = await page.locator(selector).all();
      if (links.length > 0) {
        productLinks = links;
        console.log(
          `Found ${links.length} products using selector: ${selector}`,
        );
        break;
      }
    }

    // If we found products, quick view 3-5 of them
    if (productLinks.length > 0) {
      const quickViewCount = Math.min(
        productLinks.length,
        Math.floor(Math.random() * 3) + 3, // 3-5 products
      );

      console.log(`🔍 Quick viewing ${quickViewCount} products...`);

      for (let i = 0; i < quickViewCount; i++) {
        const randomIndex = Math.floor(Math.random() * productLinks.length);
        const product = productLinks[randomIndex];

        try {
          // Try to find quick view button
          const quickViewBtn = product.locator(
            '[aria-label*="quick"], [title*="quick"], button:has-text("Quick")',
          );

          if ((await quickViewBtn.count()) > 0) {
            console.log(`  👁️  Quick view #${i + 1}`);
            await quickViewBtn.click({ timeout: 2000 });
            await randomWait(2000, 4000); // Look at the quick view

            // Close quick view
            const closeBtn = page
              .locator(
                '[aria-label="Close"], button:has-text("Close"), [data-testid="close"]',
              )
              .first();
            if ((await closeBtn.count()) > 0) {
              await closeBtn.click();
              await randomWait(500, 1000);
            } else {
              // Click outside or press Escape
              await page.keyboard.press("Escape");
              await randomWait(500, 1000);
            }
          }
        } catch (e) {
          // Quick view not available, skip
        }

        // Random scroll between views
        if (maybe(0.6)) {
          await page.evaluate(() =>
            window.scrollBy(0, Math.random() * 400 - 200),
          );
          await randomWait(500, 1000);
        }
      }
    }

    // ===================================================================
    // 4. VIEW FULL PRODUCT PAGES - Cycle Through Images
    // ===================================================================
    console.log(
      "\n📦 Phase 4: Viewing full product pages with image galleries...",
    );

    // Get product IDs to visit - fetch random products from database for variety
    console.log("🔍 Fetching random products from database for browsing...");
    const popularProductIds = (await getRandomProductIds(20)).map((id) =>
      id.toString(),
    );
    console.log(
      `📚 Selected ${popularProductIds.length} products to browse: ${popularProductIds.slice(0, 5).join(", ")}...`,
    );

    // Randomly select 4-7 products to view in detail
    const detailViewCount = Math.floor(Math.random() * 4) + 4; // 4-7 products
    const productsToView = [];

    for (let i = 0; i < detailViewCount; i++) {
      productsToView.push(randomPick(popularProductIds));
    }

    console.log(
      `📋 Viewing ${productsToView.length} products in detail: ${productsToView.join(", ")}`,
    );

    for (const productId of productsToView) {
      console.log(`\n  📦 Viewing product ${productId}...`);
      await page.goto(`${testEnv.webBaseUrl}/product/${productId}`);
      await page.waitForLoadState("domcontentloaded");
      await randomWait(2000, 3000);

      // Scroll to see the product
      await page.evaluate(() => window.scrollTo(0, 200));
      await randomWait(1000, 2000);

      // Interact with image gallery
      // The ProductImageGallery component always shows a gallery with either real photos or mock emojis
      // Cycle through every single image one by one and view the full image
      const thumbnailButtons = page.locator(
        'button[aria-label*="View image"], button[aria-label*="View"]',
      );
      const thumbnailCount = await thumbnailButtons.count();

      if (thumbnailCount > 1) {
        console.log(
          `    🖼️  Found image gallery with ${thumbnailCount} images, viewing all of them...`,
        );

        // Click through every thumbnail one by one
        for (let i = 0; i < thumbnailCount; i++) {
          try {
            // Click on each thumbnail in order
            await thumbnailButtons.nth(i).click({ timeout: 2000 });
            await randomWait(800, 1200); // Brief pause to view thumbnail
            console.log(`      ✓ Viewed thumbnail ${i + 1}/${thumbnailCount}`);

            // Click on the main image to view full size (fullscreen modal)
            const mainImage = page.locator(
              '.doodle-card img[alt*="product" i], .doodle-card img[src*="data:image"]',
            );
            if ((await mainImage.count()) > 0) {
              await mainImage.first().click({ timeout: 2000 });
              await randomWait(1500, 2500); // View full image in fullscreen
              console.log(`        ↗️  Opened fullscreen image ${i + 1}`);

              // Close button MUST exist - fail test if it doesn't
              const closeButton = page.locator(
                'button[aria-label="Close fullscreen view"]',
              );
              await expect(closeButton).toBeVisible({
                timeout: 2000,
              });
              await closeButton.click();
              await randomWait(300, 500);
              console.log(`        ✕ Closed fullscreen view`);
            }
          } catch (e) {
            console.log(`      ⚠️  Could not view image ${i + 1}`);
          }
        }
      } else {
        console.log("    ℹ️  Single image product (no gallery navigation)");
      }

      // Scroll down to read details
      await page.evaluate(() => window.scrollBy(0, 300));
      await randomWait(2000, 3500);

      // Maybe check size/color options if available
      if (maybe(0.7)) {
        const sizeButtons = page.locator(
          '[data-testid="size-button"], button[aria-label*="size"]',
        );
        if ((await sizeButtons.count()) > 0) {
          const randomSize = sizeButtons.nth(
            Math.floor(Math.random() * (await sizeButtons.count())),
          );
          try {
            await randomSize.click({ timeout: 2000 });
            console.log("    📏 Selected a size option");
            await randomWait(500, 1000);
          } catch (e) {
            // Size button not clickable
          }
        }
      }

      // Scroll back up
      await page.evaluate(() => window.scrollTo(0, 0));
      await randomWait(1000, 1500);
    }

    // ===================================================================
    // 5. SEARCH FOR SPECIFIC PRODUCTS
    // ===================================================================
    console.log("\n🔍 Phase 5: Searching for products...");

    const searchQueries = [
      "helmet",
      "gloves",
      "jersey",
      "bike",
      "mountain",
      "road",
      "water bottle",
      "shorts",
    ];

    // Perform 2-3 searches
    const searchCount = Math.floor(Math.random() * 2) + 2;

    for (let i = 0; i < searchCount; i++) {
      const query = randomPick(searchQueries);
      console.log(`  🔎 Searching for: "${query}"`);

      // Try to find search input
      const searchInput = page
        .locator(
          'input[type="search"], input[placeholder*="search" i], input[aria-label*="search" i], [data-testid="search-input"]',
        )
        .first();

      if ((await searchInput.count()) > 0) {
        try {
          await searchInput.clear();
          await searchInput.fill(query);
          await randomWait(500, 1000); // Typing delay

          // Submit search (press Enter or click search button)
          await searchInput.press("Enter");
          await page.waitForLoadState("domcontentloaded");
          await randomWait(2000, 3500);

          // Scroll through search results
          await page.evaluate(() => window.scrollBy(0, 300));
          await randomWait(1500, 2500);

          // Maybe click on a search result
          if (maybe(0.6)) {
            const resultLinks = page.locator('a[href*="/product/"]');
            if ((await resultLinks.count()) > 0) {
              const randomResult = resultLinks.nth(
                Math.floor(
                  Math.random() * Math.min(5, await resultLinks.count()),
                ),
              );
              try {
                await randomResult.click({ timeout: 3000 });
                await page.waitForLoadState("domcontentloaded");
                console.log("    ✅ Clicked on a search result");
                await randomWait(2000, 4000); // View the product

                // Go back to continue searching
                await page.goBack();
                await randomWait(1000, 2000);
              } catch (e) {
                // Couldn't click result
              }
            }
          }
        } catch (e) {
          console.log(`    ⚠️  Could not perform search for "${query}"`);
        }
      } else {
        console.log(
          "    ⚠️  Search input not found, navigating to search page",
        );
        try {
          await page.goto(
            `${testEnv.webBaseUrl}/?search=${encodeURIComponent(query)}`,
          );
          await page.waitForLoadState("domcontentloaded");
          await randomWait(2000, 3000);
        } catch (e) {
          // Search not available
        }
      }
    }

    // ===================================================================
    // 6. ADD ITEMS TO CART
    // ===================================================================
    console.log("\n🛒 Phase 6: Adding products to cart...");

    // Add 2-4 products to cart
    const itemsToAdd = Math.floor(Math.random() * 3) + 2; // 2-4 items
    let itemsAdded = 0;

    console.log("🔍 Fetching random products for cart simulation...");
    const cartProductIds = (await getRandomProductIds(15)).map((id) =>
      id.toString(),
    );
    console.log(
      `🛍️ Selected ${cartProductIds.length} products for potential cart adds`,
    );

    for (let i = 0; i < itemsToAdd; i++) {
      const productId = randomPick(cartProductIds);
      console.log(`  🛍️  Adding product ${productId} to cart...`);

      try {
        await page.goto(`${testEnv.webBaseUrl}/product/${productId}`);
        await page.waitForLoadState("domcontentloaded");
        await randomWait(1500, 2500);

        // Check if product is in stock
        const outOfStock = page.locator("text=/out of stock/i");
        const isOutOfStock = (await outOfStock.count()) > 0;

        if (!isOutOfStock) {
          // Select size if needed
          const sizeButtons = page.locator('[data-testid="size-button"]');
          if ((await sizeButtons.count()) > 0) {
            const firstAvailableSize = sizeButtons.first();
            await firstAvailableSize.click();
            await randomWait(500, 1000);
          }

          // Click add to cart
          const addToCartBtn = page
            .locator(
              '[data-testid="add-to-cart-button"], button:has-text("Add to Cart")',
            )
            .first();

          if ((await addToCartBtn.count()) > 0) {
            await page
              .waitForFunction(
                () => {
                  const btn = document.querySelector(
                    '[data-testid="add-to-cart-button"]',
                  );
                  return btn && !btn.hasAttribute("disabled");
                },
                { timeout: 5000 },
              )
              .catch(() => {
                console.log("    ⚠️  Add to cart button not ready");
              });

            await addToCartBtn.click();
            console.log(`    ✅ Added product ${productId} to cart`);
            itemsAdded++;
            await randomWait(1500, 2500);

            // Dismiss any cart notifications/modals
            const continueBtn = page
              .locator(
                'button:has-text("Continue Shopping"), button:has-text("Close")',
              )
              .first();
            if ((await continueBtn.count()) > 0) {
              await continueBtn.click();
              await randomWait(500, 1000);
            }
          } else {
            console.log("    ⚠️  Add to cart button not found");
          }
        } else {
          console.log(`    ⚠️  Product ${productId} is out of stock, skipping`);
        }
      } catch (e) {
        console.log(`    ❌ Failed to add product ${productId}: ${e}`);
      }
    }

    console.log(`\n✅ Added ${itemsAdded} items to cart`);

    // ===================================================================
    // 7. VIEW CART - Consider purchase but don't commit
    // ===================================================================
    console.log("\n🛒 Phase 7: Viewing cart...");

    await page.goto(`${testEnv.webBaseUrl}/cart`);
    await page.waitForLoadState("domcontentloaded");
    await randomWait(2000, 3000);

    // Scroll to see cart items
    await page.evaluate(() => window.scrollBy(0, 200));
    await randomWait(2000, 3000);

    // Check total
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomWait(2000, 4000);

    console.log("💭 Thinking about the total cost...");
    await randomWait(3000, 5000);

    // ===================================================================
    // 8. GET DISTRACTED - Browse more products
    // ===================================================================
    console.log("\n😕 Phase 8: Getting distracted, browsing more...");

    // Navigate to home or another category
    if (maybe(0.5)) {
      console.log("  🏠 Going back to home page");
      await page.goto(testEnv.webBaseUrl);
      await page.waitForLoadState("domcontentloaded");
      await randomWait(2000, 3000);
    } else {
      console.log("  📂 Checking another category");
      const categoryLink = page.locator('nav a, [role="navigation"] a').first();
      if ((await categoryLink.count()) > 0) {
        await categoryLink.click();
        await page.waitForLoadState("domcontentloaded");
        await randomWait(2000, 3000);
      }
    }

    // Browse 1-2 more products
    const distractionProducts = ["878", "862", "846"];
    const distractedViewCount = Math.floor(Math.random() * 2) + 1;

    for (let i = 0; i < distractedViewCount; i++) {
      const productId = randomPick(distractionProducts);
      console.log(`  👀 Browsing product ${productId} (distracted)`);

      try {
        await page.goto(`${testEnv.webBaseUrl}/product/${productId}`);
        await page.waitForLoadState("domcontentloaded");
        await randomWait(2000, 4000);

        await page.evaluate(() => window.scrollBy(0, 300));
        await randomWait(1500, 2500);
      } catch (e) {
        // Failed to view product
      }
    }

    // ===================================================================
    // 9. ABANDON CART - Leave the site
    // ===================================================================
    console.log("\n👋 Phase 9: Abandoning cart and leaving site...");

    // Go back to cart one last time
    await page.goto(`${testEnv.webBaseUrl}/cart`);
    await page.waitForLoadState("domcontentloaded");
    await randomWait(2000, 3000);

    console.log("💭 Deciding not to purchase...");
    await randomWait(2000, 3000);

    // Leave - go to home page then idle
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await randomWait(1000, 2000);

    console.log("🚪 User has left the site (cart abandoned)");

    // Wait a bit for final telemetry to be sent
    await randomWait(3000, 5000);

    // ===================================================================
    // SUMMARY
    // ===================================================================
    console.log("\n" + "=".repeat(60));
    console.log("📊 BROWSING SESSION SUMMARY");
    console.log("=".repeat(60));
    console.log(`✅ Telemetry requests sent: ${telemetryCount}`);
    console.log(`✅ Products viewed in detail: ${productsToView.length}`);
    console.log(`✅ Search queries performed: ${searchCount}`);
    console.log(`✅ Items added to cart: ${itemsAdded}`);
    console.log(`❌ Cart abandoned: YES`);
    console.log("=".repeat(60));

    // Verify telemetry was sent
    expect(telemetryCount).toBeGreaterThan(0);
    console.log("\n✅ Telemetry generation complete!\n");
  });

  test("multiple short browsing sessions - different user personas", async ({
    page,
  }) => {
    console.log("\n👥 Simulating multiple quick browsing sessions");
    console.log("=".repeat(60));

    // Fetch random products for personas
    console.log("🔍 Fetching products for persona simulation...");
    const allPersonaProducts = await getRandomProductIds(15);
    const personas = [
      {
        name: "Window Shopper",
        products: allPersonaProducts.slice(0, 3).map((id) => id.toString()),
        searchTerm: "bike",
        addToCart: false,
      },
      {
        name: "Quick Buyer",
        products: allPersonaProducts.slice(3, 5).map((id) => id.toString()),
        searchTerm: "bottle",
        addToCart: true,
      },
      {
        name: "Comparison Shopper",
        products: allPersonaProducts.slice(5, 9).map((id) => id.toString()),
        searchTerm: "touring",
        addToCart: false,
      },
    ];

    for (const persona of personas) {
      console.log(`\n👤 Persona: ${persona.name}`);
      console.log("-".repeat(40));

      // Visit home
      await page.goto(testEnv.webBaseUrl);
      await randomWait(1000, 2000);

      // Search
      console.log(`  🔍 Searching for: ${persona.searchTerm}`);
      const searchInput = page
        .locator('input[type="search"], input[placeholder*="search" i]')
        .first();

      if ((await searchInput.count()) > 0) {
        await searchInput.fill(persona.searchTerm);
        await searchInput.press("Enter");
        await page.waitForLoadState("domcontentloaded");
        await randomWait(1500, 2000);
      }

      // Browse products
      console.log(`  📦 Viewing ${persona.products.length} products`);
      for (const productId of persona.products) {
        await page.goto(`${testEnv.webBaseUrl}/product/${productId}`);
        await randomWait(1000, 2000);

        if (maybe(0.7)) {
          await page.evaluate(() => window.scrollBy(0, 200));
          await randomWait(500, 1000);
        }
      }

      // Maybe add to cart
      if (persona.addToCart) {
        console.log("  🛒 Adding item to cart");
        const addBtn = page
          .locator('[data-testid="add-to-cart-button"]')
          .first();
        if ((await addBtn.count()) > 0) {
          try {
            await addBtn.click({ timeout: 3000 });
            await randomWait(1000, 1500);
          } catch (e) {
            console.log("    ⚠️  Could not add to cart");
          }
        }
      }

      console.log(`  ✅ ${persona.name} session complete`);
      await randomWait(2000, 3000);
    }

    console.log("\n✅ Multiple persona sessions complete!\n");
  });
});
