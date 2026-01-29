import { test, expect } from "@playwright/test";
import { testEnv } from "../utils/env";
import { getRandomProductIds } from "../utils/productHelper";

test.describe("Demo Video - AdventureWorks Site Tour", () => {
  test("showcase main features of the site", async ({ page }) => {
    // Set a slower pace for better video visibility
    const waitTime = 2000;

    // Navigate to home page
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(waitTime);

    // Verify homepage loaded
    await expect(page.locator("h1, h2").first()).toBeVisible({
      timeout: 10000,
    });

    // Scroll down to show featured categories
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(waitTime);

    // Browse to a category
    const categoryLinks = page
      .locator('[data-testid*="category-card"]')
      .first();
    if (await categoryLinks.isVisible({ timeout: 5000 })) {
      await categoryLinks.click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(waitTime);

      // Wait for products to load
      await page.waitForTimeout(3000);

      // Scroll to show products
      await page.evaluate(() => window.scrollBy(0, 300));
      await page.waitForTimeout(waitTime);

      // Click on a product if available
      const productCards = page.locator('[data-testid*="product-card"]');
      if ((await productCards.count()) > 0) {
        await productCards.first().click();
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(waitTime);
      }
    } else {
      // Go directly to a product page
      const productIds = await getRandomProductIds(1);
      await page.goto(`${testEnv.webBaseUrl}/product/${productIds[0]}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(waitTime);
    }

    // Verify product page loaded
    await expect(
      page.locator("h1, h2, [data-testid='product-name']").first(),
    ).toBeVisible({ timeout: 10000 });

    // Scroll to show product details
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(waitTime);

    // Look for Add to Cart button and click it if visible
    const addToCartButton = page
      .locator('button:has-text("Add to Cart")')
      .first();
    if (await addToCartButton.isVisible({ timeout: 3000 })) {
      await addToCartButton.click();
      await page.waitForTimeout(waitTime);

      // Check if cart updated (look for cart icon or notification)
      const cartIndicator = page.locator(
        '[data-testid*="cart"], [class*="cart"]',
      );
      if (await cartIndicator.isVisible({ timeout: 3000 })) {
        await page.waitForTimeout(1000);
      }
    }

    // Navigate to search/explore more features
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(waitTime);

    // Final scroll to show footer/additional content
    await page.evaluate(() => window.scrollBy(0, 300));
    await page.waitForTimeout(waitTime);

    console.log("✅ Demo video recording completed");
  });
});
