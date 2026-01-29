import { test } from "@playwright/test";
import { testEnv } from "../utils/env";

test.describe("Demo Video - AdventureWorks Site Tour", () => {
  test("showcase main features of the site", async ({ page }) => {
    // Set a slower pace for better video visibility
    const waitTime = 2000;
    const scrollWait = 1000;

    // === 1. Homepage ===
    console.log("📍 Homepage");
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(waitTime);

    // === 2. Scroll to bottom of homepage (slowly) ===
    console.log("📍 Scrolling to bottom of homepage");
    await page.evaluate(() => {
      const scrollHeight = document.body.scrollHeight;
      const scrollStep = scrollHeight / 4;
      window.scrollBy(0, scrollStep);
    });
    await page.waitForTimeout(scrollWait);
    await page.evaluate(() => {
      const scrollHeight = document.body.scrollHeight;
      const scrollStep = scrollHeight / 4;
      window.scrollBy(0, scrollStep);
    });
    await page.waitForTimeout(scrollWait);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(waitTime);

    // === 3. Change language to French ===
    console.log("📍 Changing language to French");
    const languageSelector = page
      .locator(
        '[data-testid*="language"], select[name*="language"], button[aria-label*="language"]',
      )
      .first();
    if (await languageSelector.isVisible({ timeout: 3000 })) {
      await languageSelector.click();
      await page.waitForTimeout(500);

      const frenchOption = page.locator("text=/français|french/i").first();
      if (await frenchOption.isVisible({ timeout: 2000 })) {
        await frenchOption.click();
        await page.waitForTimeout(waitTime);
      }
    }

    // === 4. Scroll back to top of homepage ===
    console.log("📍 Scrolling back to top of homepage");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(waitTime);

    // === 5. Navigate to Sale page ===
    console.log("📍 Sale Page");
    await page.goto(`${testEnv.webBaseUrl}/sale`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(waitTime);

    // === 6. Scroll to bottom ===
    console.log("📍 Scrolling to bottom");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(waitTime);

    // === 7. Scroll to top ===
    console.log("📍 Scrolling to top");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(waitTime);

    // === 8. Click product 930 ===
    console.log("📍 Opening Product 930");
    await page.goto(`${testEnv.webBaseUrl}/product/930`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(waitTime);

    // === 9. Scroll to top of page ===
    console.log("📍 Scrolling to top of product page");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(scrollWait);

    // === 10. Click the 3rd image ===
    console.log("📍 Clicking 3rd image");
    const thirdImage = page
      .locator('img[alt*="Image"], [class*="image"], [data-testid*="image"]')
      .nth(2);
    if (await thirdImage.isVisible({ timeout: 3000 })) {
      await thirdImage.click();
      await page.waitForTimeout(waitTime);
    }

    // === 11. Scroll down all the way to the bottom ===
    console.log("📍 Scrolling to bottom of page");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(waitTime);

    console.log("✅ Demo video recording completed");
  });
});
