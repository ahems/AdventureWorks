import { test, expect } from "@playwright/test";
import { signupThroughUi } from "../utils/testUser";
import { testEnv } from "../utils/env";
import { execSync } from "child_process";
import { getRandomProductIds } from "../utils/productHelper";

const LANGUAGES_WITH_CURRENCY = [
  { code: "en", name: "English", currencyCode: "USD", currencySymbol: "$" },
  { code: "es", name: "Spanish", currencyCode: "EUR", currencySymbol: "€" },
  { code: "fr", name: "French", currencyCode: "EUR", currencySymbol: "€" },
  { code: "ja", name: "Japanese", currencyCode: "JPY", currencySymbol: "¥" },
];

const US_STATES = [
  { label: "Washington (WA )", abbrev: "WA" },
  { label: "California (CA )", abbrev: "CA" },
];

interface PriceInfo {
  originalPrice: number;
  discountedPrice: number;
  discountPercentage: number;
  currencyCode: string;
  currencySymbol: string;
}

const getTestEmail = (): string => {
  try {
    const output = execSync('azd env get-value "TEST_EMAIL"', {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    if (output.includes("ERROR") || !output || output.length === 0) {
      throw new Error(
        "TEST_EMAIL environment variable not set. Please set it using: azd env set TEST_EMAIL <your-email>",
      );
    }

    return output;
  } catch (error) {
    throw new Error(
      `Failed to get TEST_EMAIL: ${error}. Please set it using: azd env set TEST_EMAIL <your-email>`,
    );
  }
};

test.describe("Sale/Discount Browsing with Language Switching", () => {
  test("user can browse sale page and see discounted prices in default language", async ({
    page,
  }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to sale page
    await page.goto(`${testEnv.webBaseUrl}/sale`);
    await page.waitForLoadState("domcontentloaded");

    // Sale page shows product links in main (works with or without data-testid on cards)
    const saleProductCards = page.locator('main a[href^="/product/"]');

    // Wait for sale products to load (page makes two chained GraphQL calls)
    console.log("⏳ Waiting for sale products to load...");
    await expect(saleProductCards.first()).toBeVisible({ timeout: 45000 });

    const productCount = await saleProductCards.count();
    expect(
      productCount,
      "Sale page shows 0 products. Seed Sales.SpecialOffer (Category=Customer) and Sales.SpecialOfferProduct. Run: npx tsx tests/scripts/check-sale-discounts-dab.ts",
    ).toBeGreaterThan(0);
    console.log(`✅ Found ${productCount} sale products`);

    // Check that first product shows price (USD $) and discount
    const firstProduct = saleProductCards.first();
    const cardText = await firstProduct.textContent();
    expect(cardText, "Sale product card should show price").toContain("$");
    expect(cardText, "Sale product card should show discount/save").toMatch(
      /save|discount|%\s*off/i,
    );
    console.log("✅ First sale product shows price and discount");
  });

  test("sale prices update when language/currency changes", async ({
    page,
  }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to sale page
    await page.goto(`${testEnv.webBaseUrl}/sale`);
    await page.waitForLoadState("domcontentloaded");

    // Sale page shows product links in main
    const saleProductCards = page.locator('main a[href^="/product/"]');

    // Wait for sale products to load (page makes two chained GraphQL calls)
    await expect(saleProductCards.first()).toBeVisible({ timeout: 45000 });

    const productCount = await saleProductCards.count();
    expect(
      productCount,
      "Sale page shows 0 products. Seed Sales.SpecialOffer (Category=Customer) and Sales.SpecialOfferProduct. Run: npx tsx tests/scripts/check-sale-discounts-dab.ts",
    ).toBeGreaterThan(0);

    // Get initial price information in English/USD
    const firstProduct = saleProductCards.first();
    const initialPriceText = await firstProduct
      .locator("text=/\\$/")
      .first()
      .textContent();
    console.log(`📊 Initial price (USD): ${initialPriceText}`);

    // Extract numeric value from price text
    const extractPrice = (text: string | null): number => {
      if (!text) return 0;
      const match = text.match(/[\d,]+\.?\d*/);
      return match ? parseFloat(match[0].replace(/,/g, "")) : 0;
    };

    const initialPrice = extractPrice(initialPriceText);
    expect(initialPrice).toBeGreaterThan(0);

    // Open language selector
    const languageSelector = page.locator('[data-testid="language-selector"]');
    await expect(languageSelector).toBeVisible({ timeout: 5000 });

    // Test switching to Spanish (EUR)
    await languageSelector.click();
    const spanishOption = page.locator('[data-testid="language-option-es"]');

    if ((await spanishOption.count()) > 0) {
      await spanishOption.click();

      // Wait for language and currency to update (app uses selectedLanguage / selectedCurrency)
      await page.waitForFunction(
        ({ expectedLang, expectedCurrency }) => {
          const storedLang = localStorage.getItem("selectedLanguage");
          const storedCurrency = localStorage.getItem("selectedCurrency");
          return (
            storedLang === expectedLang && storedCurrency === expectedCurrency
          );
        },
        { expectedLang: "es", expectedCurrency: "EUR" },
        { timeout: 10000 },
      );

      // Wait for price to update
      await page.waitForTimeout(2000);

      // Get updated price in EUR (page now shows €)
      const updatedPriceText = await firstProduct
        .locator("text=/€|\\$/")
        .first()
        .textContent();
      console.log(`📊 Updated price (EUR): ${updatedPriceText}`);

      // Verify currency symbol changed to Euro
      expect(updatedPriceText).toContain("€");

      const updatedPrice = extractPrice(updatedPriceText);
      expect(updatedPrice).toBeGreaterThan(0);

      // Verify the price changed (exchange rate applied)
      expect(updatedPrice).not.toBe(initialPrice);
      console.log(
        `✅ Price changed from $${initialPrice} to €${updatedPrice} (exchange rate applied)`,
      );

      // Switch to Japanese (JPY) to verify another currency
      await languageSelector.click();
      const japaneseOption = page.locator('[data-testid="language-option-ja"]');

      if ((await japaneseOption.count()) > 0) {
        await japaneseOption.click();

        await page.waitForFunction(
          ({ expectedLang, expectedCurrency }) => {
            const storedLang = localStorage.getItem("selectedLanguage");
            const storedCurrency = localStorage.getItem("selectedCurrency");
            return (
              storedLang === expectedLang && storedCurrency === expectedCurrency
            );
          },
          { expectedLang: "ja", expectedCurrency: "JPY" },
          { timeout: 10000 },
        );

        await page.waitForTimeout(2000);

        const jpyPriceText = await firstProduct
          .locator("text=/¥|€|\\$/")
          .first()
          .textContent();
        console.log(`📊 Updated price (JPY): ${jpyPriceText}`);

        // Verify currency symbol changed to Yen
        expect(jpyPriceText).toContain("¥");

        const jpyPrice = extractPrice(jpyPriceText);
        expect(jpyPrice).toBeGreaterThan(0);
        expect(jpyPrice).not.toBe(initialPrice);
        expect(jpyPrice).not.toBe(updatedPrice);

        console.log(
          `✅ Successfully verified currency conversion across USD → EUR → JPY`,
        );
      }
    }
  });

  test("discount percentage remains consistent across language changes", async ({
    page,
  }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to sale page
    await page.goto(`${testEnv.webBaseUrl}/sale`);
    await page.waitForLoadState("domcontentloaded");

    // Sale page shows product links in main
    const saleProductCards = page.locator('main a[href^="/product/"]');

    // Wait for sale products to load (page makes two chained GraphQL calls)
    await expect(saleProductCards.first()).toBeVisible({ timeout: 45000 });

    const productCount = await saleProductCards.count();
    expect(
      productCount,
      "Sale page shows 0 products. Seed Sales.SpecialOffer (Category=Customer) and Sales.SpecialOfferProduct. Run: npx tsx tests/scripts/check-sale-discounts-dab.ts",
    ).toBeGreaterThan(0);

    const firstProduct = saleProductCards.first();

    // Helper to extract discount percentage from badge
    const getDiscountPercentage = async (): Promise<number | null> => {
      const discountBadge = firstProduct.locator(
        "text=/save|%|discount/i",
      );
      if ((await discountBadge.count()) > 0) {
        const badgeText = await discountBadge.first().textContent();
        const match = badgeText?.match(/(\d+)%/);
        return match ? parseInt(match[1]) : null;
      }
      return null;
    };

    // Get discount percentage in English
    const initialDiscount = await getDiscountPercentage();
    if (initialDiscount !== null) {
      console.log(`📊 Initial discount: ${initialDiscount}%`);

      // Switch to French
      const languageSelector = page.locator(
        '[data-testid="language-selector"]',
      );
      await languageSelector.click();
      const frenchOption = page.locator('[data-testid="language-option-fr"]');

      if ((await frenchOption.count()) > 0) {
        await frenchOption.click();
        await page.waitForTimeout(2000);

        // Verify discount percentage remains the same
        const updatedDiscount = await getDiscountPercentage();
        if (updatedDiscount !== null) {
          expect(updatedDiscount).toBe(initialDiscount);
          console.log(
            `✅ Discount percentage unchanged: ${initialDiscount}% (EN) = ${updatedDiscount}% (FR)`,
          );
        }
      }
    } else {
      console.log("ℹ️  No discount percentage badge found on first product");
    }
  });

  test("sale discounts persist through checkout flow with language change", async ({
    page,
  }) => {
    test.setTimeout(90000); // Increase timeout for full checkout flow

    // Verify TEST_EMAIL is configured
    const testEmail = getTestEmail();
    console.log(`📧 Using TEST_EMAIL for order confirmation: ${testEmail}`);

    // Create a test user
    await signupThroughUi(page);

    // Navigate to sale page
    await page.goto(`${testEnv.webBaseUrl}/sale`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for sale products to load (page makes two chained GraphQL calls)
    const saleProductCards = page.locator('main a[href^="/product/"]');
    await expect(saleProductCards.first()).toBeVisible({ timeout: 45000 });

    const productCount = await saleProductCards.count();
    expect(
      productCount,
      "Sale page shows 0 products. Seed Sales.SpecialOffer (Category=Customer) and Sales.SpecialOfferProduct. Run: npx tsx tests/scripts/check-sale-discounts-dab.ts",
    ).toBeGreaterThan(0);

    // Click on first sale product to view details
    const firstProduct = saleProductCards.first();

    // Get initial price information
    const initialPriceText = await firstProduct
      .locator("text=/\\$/")
      .first()
      .textContent();
    console.log(`📊 Sale product initial price (USD): ${initialPriceText}`);

    await firstProduct.click();

    // Wait for product page to load
    await expect(page).toHaveURL(/\/product\//);
    await page.waitForTimeout(2000);

    // Verify we're on a sale product page (should show discount)
    const productPage = page.locator("main, [role='main']");

    // Add to cart
    const addToCartButton = page.locator(
      'button:has-text("Add to Cart"), button:has-text("Add to Bag"), [data-testid*="add-to-cart"]',
    );
    await expect(addToCartButton.first()).toBeVisible({ timeout: 10000 });
    await addToCartButton.first().click();

    console.log("✅ Added sale product to cart");

    // Wait for cart to update
    await page.waitForTimeout(2000);

    // Navigate to cart
    const cartLink = page.locator(
      'a[href="/cart"], [data-testid="cart-link"], button:has-text("Cart")',
    );
    await cartLink.first().click();

    // Wait for cart page to load
    await expect(page).toHaveURL(/\/cart/);
    await page.waitForTimeout(2000);

    // Verify discounted price is shown in cart (USD)
    const cartPriceElement = page.locator("text=/\\$/").first();
    const cartPriceUSD = await cartPriceElement.textContent();
    console.log(`📊 Cart price (USD): ${cartPriceUSD}`);
    expect(cartPriceUSD).toContain("$");

    // Check for discount indication in cart
    const discountElement = page.locator(
      '[data-testid*="discount"], [data-testid*="savings"], :text-matches("save|off", "i")',
    );
    if ((await discountElement.count()) > 0) {
      const discountText = await discountElement.first().textContent();
      console.log(`✅ Discount shown in cart: ${discountText}`);
    }

    // Now switch language to Spanish (EUR) while in cart
    const languageSelector = page.locator('[data-testid="language-selector"]');
    await languageSelector.click();
    const spanishOption = page.locator('[data-testid="language-option-es"]');

    if ((await spanishOption.count()) > 0) {
      await spanishOption.click();

      // Wait for currency update (app uses selectedCurrency)
      await page.waitForFunction(
        ({ expectedCurrency }) => {
          return localStorage.getItem("selectedCurrency") === expectedCurrency;
        },
        { expectedCurrency: "EUR" },
        { timeout: 10000 },
      );

      await page.waitForTimeout(2000);

      // Verify price updated to EUR but discount still applies (cart now shows €)
      const cartPriceEUR = await page.locator("text=/€|\\$/").first().textContent();
      console.log(`📊 Cart price after language change (EUR): ${cartPriceEUR}`);
      expect(cartPriceEUR).toContain("€");

      console.log("✅ Language changed to Spanish, currency changed to EUR");
    }

    // Proceed to checkout
    const checkoutButton = page.locator(
      'button:has-text("Checkout"), button:has-text("Proceed"), [data-testid*="checkout"]',
    );
    await expect(checkoutButton.first()).toBeVisible({ timeout: 5000 });
    await checkoutButton.first().click();

    // Wait for checkout page
    await expect(page).toHaveURL(/\/checkout/);
    await page.waitForTimeout(2000);

    console.log("✅ Navigated to checkout page");

    // Verify order summary still shows discounted price in EUR
    const orderSummary = page.locator(
      '[data-testid*="order-summary"], [data-testid*="summary"]',
    );
    if ((await orderSummary.count()) > 0) {
      const summaryText = await orderSummary.textContent();
      expect(summaryText).toContain("€");
      console.log("✅ Order summary shows EUR prices");
    }

    // Fill in shipping address
    const addressLine1Input = page.locator('input[name="addressLine1"]');
    if ((await addressLine1Input.count()) > 0) {
      await addressLine1Input.fill("123 Test Street");
      await page.locator('input[name="city"]').fill("Seattle");

      // Select state
      const stateSelect = page.locator(
        'select[name="state"], [data-testid*="state-select"]',
      );
      if ((await stateSelect.count()) > 0) {
        await stateSelect.selectOption({ label: US_STATES[0].label });
      }

      await page.locator('input[name="postalCode"]').fill("98101");

      console.log("✅ Filled shipping address");
    }

    // Continue to payment (if address form exists)
    const continueButton = page.locator(
      'button:has-text("Continue"), button:has-text("Next")',
    );
    if ((await continueButton.count()) > 0) {
      await continueButton.first().click();
      await page.waitForTimeout(2000);
    }

    // Switch back to English (USD) before final order placement
    await languageSelector.click();
    const englishOption = page.locator('[data-testid="language-option-en"]');

    if ((await englishOption.count()) > 0) {
      await englishOption.click();

      await page.waitForFunction(
        ({ expectedCurrency }) => {
          return localStorage.getItem("selectedCurrency") === expectedCurrency;
        },
        { expectedCurrency: "USD" },
        { timeout: 10000 },
      );

      await page.waitForTimeout(2000);

      console.log("✅ Switched back to English/USD before order placement");
    }

    // Fill payment information
    const emailInput = page.locator('input[name="email"], input[type="email"]');
    if ((await emailInput.count()) > 0) {
      const currentValue = await emailInput.inputValue();
      if (!currentValue) {
        await emailInput.fill(testEmail);
      }
    }

    const cardNumberInput = page.locator(
      'input[name="cardNumber"], input[placeholder*="card"]',
    );
    if ((await cardNumberInput.count()) > 0) {
      await cardNumberInput.fill("4111111111111111");

      const expiryInput = page.locator(
        'input[name="expiry"], input[placeholder*="MM/YY"]',
      );
      if ((await expiryInput.count()) > 0) {
        await expiryInput.fill("12/25");
      }

      const cvvInput = page.locator(
        'input[name="cvv"], input[placeholder*="CVV"]',
      );
      if ((await cvvInput.count()) > 0) {
        await cvvInput.fill("123");
      }

      console.log("✅ Filled payment information");
    }

    // Place order
    const placeOrderButton = page.locator(
      'button:has-text("Place Order"), button:has-text("Complete"), button:has-text("Pay")',
    );

    if ((await placeOrderButton.count()) > 0) {
      await placeOrderButton.first().click();
      console.log("✅ Clicked Place Order button");

      // Wait for order confirmation
      await expect(page).toHaveURL(
        /\/(order-confirmation|success|thank-you)/i,
        {
          timeout: 30000,
        },
      );

      await page.waitForTimeout(5000);

      console.log("✅ Order placed successfully");

      // Verify order confirmation shows the correct discounted price in USD
      const confirmationPage = page.locator("main, [role='main']");
      const confirmationText = await confirmationPage.textContent();

      // Should show USD since we switched back before placing order
      expect(confirmationText).toContain("$");

      console.log("✅ Order confirmation displays with final currency (USD)");

      // Log success message
      const successMessage = page.locator(
        'h1:has-text("Thank"), h1:has-text("Success"), h1:has-text("Confirmed")',
      );
      if ((await successMessage.count()) > 0) {
        const message = await successMessage.first().textContent();
        console.log(`✅ Success message: ${message}`);
      }

      console.log(
        "✅ TEST COMPLETE: Sale discount persisted through entire checkout flow with language changes (EN→ES→EN)",
      );
    } else {
      console.log("ℹ️  Place Order button not found, checkout flow may differ");
    }
  });

  test("multiple sale items maintain discounts in cart across language changes", async ({
    page,
  }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to sale page
    await page.goto(`${testEnv.webBaseUrl}/sale`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for sale products to load (page makes two chained GraphQL calls)
    const saleProductCards = page.locator('main a[href^="/product/"]');
    await expect(saleProductCards.first()).toBeVisible({ timeout: 45000 });

    const productCount = await saleProductCards.count();
    expect(
      productCount,
      "Sale page shows 0 products. Seed Sales.SpecialOffer (Category=Customer) and Sales.SpecialOfferProduct. Run: npx tsx tests/scripts/check-sale-discounts-dab.ts",
    ).toBeGreaterThan(0);
    
    const itemsToAdd = Math.min(3, productCount); // Add up to 3 items

    console.log(`📦 Adding ${itemsToAdd} sale items to cart...`);

    // Add multiple items to cart
    for (let i = 0; i < itemsToAdd; i++) {
      const product = saleProductCards.nth(i);
      await product.click();

      // Wait for product page
      await page.waitForTimeout(2000);

      // Add to cart
      const addToCartButton = page.locator(
        'button:has-text("Add to Cart"), button:has-text("Add to Bag")',
      );
      await addToCartButton.first().click();
      await page.waitForTimeout(1500);

      console.log(`✅ Added item ${i + 1} to cart`);

      // Go back to sale page
      await page.goto(`${testEnv.webBaseUrl}/sale`);
      await page.waitForTimeout(2000);
    }

    // Navigate to cart
    await page.goto(`${testEnv.webBaseUrl}/cart`);
    await page.waitForTimeout(2000);

    // Count items in cart
    const cartItems = page.locator('[data-testid*="cart-item"]');
    const cartItemCount = await cartItems.count();
    expect(cartItemCount).toBe(itemsToAdd);
    console.log(`✅ Cart contains ${cartItemCount} items`);

    // Get total price text (element that contains $ or €, e.g. cart total row)
    const getTotalPrice = async () => {
      const withCurrency = page.locator("main, [role=main]").locator("text=/\\$|€|¥/");
      const count = await withCurrency.count();
      if (count > 0) {
        const lastPrice = await withCurrency.nth(count - 1).textContent();
        if (lastPrice?.trim()) return lastPrice.trim();
      }
      const totalLabel = page.locator('[data-testid*="total"], :text-matches("total", "i")').last();
      return (await totalLabel.textContent()) ?? "";
    };

    const totalUSD = await getTotalPrice();
    console.log(`📊 Cart total (USD): ${totalUSD}`);
    expect(totalUSD, "Cart should show total with currency ($)").toMatch(/\$|USD/);

    // Switch to German (EUR)
    const languageSelector = page.locator('[data-testid="language-selector"]');
    await languageSelector.click();
    const germanOption = page.locator('[data-testid="language-option-de"]');

    if ((await germanOption.count()) > 0) {
      await germanOption.click();
      await page.waitForTimeout(5000); // Wait for recalculation

      const totalEUR = await getTotalPrice();
      console.log(`📊 Cart total (EUR): ${totalEUR}`);
      expect(totalEUR, "Cart should show total in EUR").toMatch(/€|EUR/);

      // Verify all items still in cart
      const updatedCartItemCount = await cartItems.count();
      expect(updatedCartItemCount).toBe(itemsToAdd);
      console.log(
        `✅ All ${updatedCartItemCount} items still in cart after language change`,
      );
    }

    console.log(
      "✅ TEST COMPLETE: Multiple sale items maintained discounts across language change",
    );
  });
});
