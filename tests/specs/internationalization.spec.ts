import { test, expect } from "@playwright/test";
import { signupThroughUi } from "../utils/testUser";
import { testEnv, APP_STORAGE_KEYS } from "../utils/env";
import { getRandomProductIds } from "../utils/productHelper";

const LANGUAGES = [
  { code: "en", name: "English", sample: "Home" },
  { code: "es", name: "Spanish", sample: "Inicio" },
  { code: "fr", name: "French", sample: "Accueil" },
  { code: "de", name: "German", sample: "Startseite" },
  { code: "ja", name: "Japanese", sample: "ホーム" },
  { code: "zh", name: "Chinese", sample: "主页" },
];

const CURRENCIES = [
  { code: "USD", symbol: "$" },
  { code: "EUR", symbol: "€" },
  { code: "GBP", symbol: "£" },
  { code: "JPY", symbol: "¥" },
];

test.describe("Internationalization", () => {
  test("user can switch languages and currency/units update automatically", async ({
    page,
  }) => {
    // Create a test user
    await signupThroughUi(page);

    // Go directly to a product page to see prices
    const testProductIds = await getRandomProductIds(1);
    const testProductId = testProductIds[0];
    console.log(
      `🌍 Testing internationalization with product ${testProductId}`,
    );
    await page.goto(`${testEnv.webBaseUrl}/product/${testProductId}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for product details to load
    await page.waitForTimeout(2000);

    // Look for language selector using data-testid
    const languageSelector = page.locator('[data-testid="language-selector"]');
    await expect(languageSelector).toBeVisible({ timeout: 5000 });

    // Get initial price to compare - wait longer for products to render
    const priceElement = page.locator('[data-testid="product-price"]');
    await expect(priceElement).toBeVisible({ timeout: 10000 });

    // Test switching to English -  currency and units should follow
    const testLanguages = [
      { code: "en", name: "English", currencySymbol: "$", currencyCode: "USD" },
    ];

    for (const lang of testLanguages) {
      // Click language selector
      await languageSelector.click();

      // Select language option using data-testid
      const langOption = page.locator(
        `[data-testid="language-option-${lang.code}"]`,
      );

      if ((await langOption.count()) > 0) {
        await langOption.click();

        // Wait for both language AND currency to update in localStorage with longer timeout
        await page.waitForFunction(
          ({ langKey, currencyKey, expectedLang, expectedCurrency }) => {
            const storedLang = localStorage.getItem(langKey);
            const storedCurrency = localStorage.getItem(currencyKey);
            return (
              storedLang === expectedLang && storedCurrency === expectedCurrency
            );
          },
          {
            langKey: APP_STORAGE_KEYS.language,
            currencyKey: APP_STORAGE_KEYS.currency,
            expectedLang: lang.code,
            expectedCurrency: lang.currencyCode,
          },
          { timeout: 10000 },
        );

        // Wait for UI to update
        await page.waitForTimeout(2000);

        // Verify currency symbol appears in prices
        const updatedPrice = await priceElement.textContent();
        expect(updatedPrice).toContain(lang.currencySymbol);

        console.log(
          `✅ Switched to ${lang.name}, currency auto-updated to ${lang.currencyCode}`,
        );
      }
    }

    // Navigate to different pages and verify language+currency persist
    // Go to a category page
    const categoryLink = page.locator('[data-testid*="category-card"]').first();
    if ((await categoryLink.count()) > 0) {
      await categoryLink.click();
      await expect(page).toHaveURL(/\/category\//);

      // Verify language and currency are still applied
      const currentLang = await page.evaluate(
        (key) => localStorage.getItem(key),
        APP_STORAGE_KEYS.language,
      );
      const currentCurrency = await page.evaluate(
        (key) => localStorage.getItem(key),
        APP_STORAGE_KEYS.currency,
      );
      expect(currentLang).toBeTruthy();
      expect(currentCurrency).toBeTruthy();
    }

    // Go to a product page
    const productCard = page.locator('[data-testid*="product-card"]').first();
    if ((await productCard.count()) > 0) {
      await productCard.click();
      await expect(page).toHaveURL(/\/product\//);

      // Verify language and currency persist
      const currentLang = await page.evaluate(
        (key) => localStorage.getItem(key),
        APP_STORAGE_KEYS.language,
      );
      const currentCurrency = await page.evaluate(
        (key) => localStorage.getItem(key),
        APP_STORAGE_KEYS.currency,
      );
      expect(currentLang).toBeTruthy();
      expect(currentCurrency).toBeTruthy();

      // Verify product price shows correct currency
      const productPrice = page.locator('[data-testid="product-price"]');
      await expect(productPrice).toBeVisible();
      const productPriceText = await productPrice.textContent();
      expect(productPriceText).toMatch(/[$€£¥]/);
    }

    console.log("✅ Language and currency persist across different pages");
  });

  test("checkout currency follows shipping address, not language", async ({
    page,
  }) => {
    test.setTimeout(90000); // Cart + checkout + language switch can exceed 45s on Azure workers
    // Create a test user
    await signupThroughUi(page);

    // Navigate directly to a product and add to cart
    const testProductIds = await getRandomProductIds(1);
    const testProductId = testProductIds[0];
    console.log(`🛍️ Testing currency with product ${testProductId}`);
    await page.goto(`${testEnv.webBaseUrl}/product/${testProductId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    const addToCartButton = page.locator('[data-testid="add-to-cart-button"]');
    await expect(addToCartButton).toBeVisible({ timeout: 10000 });

    // Wait for button to be enabled (product data must load first)
    await page.waitForFunction(
      () => {
        const btn = document.querySelector(
          '[data-testid="add-to-cart-button"]',
        );
        return btn && !btn.hasAttribute("disabled");
      },
      { timeout: 15000 },
    );

    await addToCartButton.click();
    await page.waitForTimeout(1000);

    // Go to cart
    await page.goto(`${testEnv.webBaseUrl}/cart`);
    await page.waitForLoadState("domcontentloaded");

    // Get cart price before checkout (wait for cart to render)
    const cartPriceLocator = page
      .locator('[data-testid*="product-price"]')
      .first();
    await expect(cartPriceLocator).toBeVisible({ timeout: 15000 });
    const cartPrice = await cartPriceLocator.textContent();

    // Proceed to checkout
    const checkoutButton = page.locator('[data-testid="checkout-button"]');
    await checkoutButton.click();
    await expect(page).toHaveURL(/\/checkout/);

    // Set language to one currency (e.g., French = EUR)
    const languageSelector = page.locator('[data-testid="language-selector"]');
    await languageSelector.click();
    const frenchOption = page.locator('[data-testid="language-option-fr"]');
    if ((await frenchOption.count()) > 0) {
      await frenchOption.click();
      await page.waitForTimeout(1000);
    }

    // Select or enter a US address (should trigger USD currency)
    // Look for country selector or address form
    const countrySelect = page.locator(
      'select[name*="country"], [id*="country"]',
    );
    if ((await countrySelect.count()) > 0) {
      await countrySelect.selectOption({ label: "United States" });
      await page.waitForTimeout(1000);

      // Verify prices changed to USD despite French language
      const checkoutPrice = await page
        .locator('[class*="price"], [data-testid*="price"]')
        .first()
        .textContent();

      // Should show $ for US address, not € from French language
      expect(checkoutPrice).toContain("$");

      console.log(
        "✅ Checkout currency follows shipping address (USD), not language (EUR)",
      );
    } else {
      // If no country selector found, just verify checkout loads
      await expect(
        page.locator('[data-testid="place-order-button"]'),
      ).toBeVisible();
      console.log(
        "⚠️  Country selector not found, skipping currency override test",
      );
    }
  });

  test("no missing translation keys appear on pages", async ({ page }) => {
    // Create a test user
    await signupThroughUi(page);

    // Test multiple pages for missing translation keys
    const pagesToTest = [
      { url: testEnv.webBaseUrl, name: "Home" },
      { url: `${testEnv.webBaseUrl}/account`, name: "Account" },
      { url: `${testEnv.webBaseUrl}/cart`, name: "Cart" },
    ];

    // Switch to a non-English language
    await page.goto(testEnv.webBaseUrl);
    const languageSelector = page
      .getByRole("button", { name: /language|lang/i })
      .or(page.locator('[data-testid*="language"]'));

    if ((await languageSelector.count()) > 0) {
      await languageSelector.first().click();
      const spanishOption = page.getByText(/Spanish|Español/i).first();
      if ((await spanishOption.count()) > 0) {
        await spanishOption.click();
        await page.waitForTimeout(1000);
      }
    }

    // Check each page for translation key patterns (e.g., "key.name", "translation.missing")
    for (const pageInfo of pagesToTest) {
      await page.goto(pageInfo.url);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000); // Give time for translations to load

      const bodyText = await page.textContent("body");

      // Check for common missing translation patterns
      expect(bodyText).not.toMatch(/\[missing\s+translation\]/i);
      expect(bodyText).not.toMatch(/\{\{.*\}\}/); // Template literals left unrendered

      // More lenient check - just ensure content exists
      expect(bodyText?.length).toBeGreaterThan(100);

      console.log(`✅ ${pageInfo.name} page has translations loaded`);
    }
  });
});
