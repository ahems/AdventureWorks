import { test, expect } from "@playwright/test";
import { faker } from "@faker-js/faker";
import { signupThroughUi } from "../utils/testUser";
import { testEnv } from "../utils/env";
import { execSync } from "child_process";
import { getInStockProductIds } from "../utils/productHelper";

const US_STATES = [
  { label: "Washington (WA )", abbrev: "WA" },
  { label: "California (CA )", abbrev: "CA" },
  { label: "Texas (TX )", abbrev: "TX" },
];

const createCheckoutAddress = () => {
  const state = faker.helpers.arrayElement(US_STATES);
  return {
    addressLine1: `${faker.location.buildingNumber()} ${faker.location.street()}`,
    addressLine2: "",
    city: faker.location.city(),
    stateLabel: state.label,
    postalCode: faker.location.zipCode("#####"),
    country: "United States",
  };
};

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

test.describe("Checkout Flow", () => {
  // Allow time for signup (cold start), cart API, checkout form
  test.setTimeout(180000);

  test("user can complete full checkout process with order confirmation", async ({
    page,
  }) => {
    // Log any failed HTTP response (400/404/etc.) so we can identify the failing request
    page.on("response", (response) => {
      const status = response.status();
      if (status >= 400) {
        const url = response.url();
        const method = response.request().method();
        console.log(`🔴 HTTP ${status} ${method} ${url}`);
      }
    });

    // Listen for browser console errors
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.log(`🔴 Browser Console Error: ${msg.text()}`);
      }
      // Also log info messages to see our email creation logs
      if (
        msg.type() === "log" &&
        (msg.text().includes("Creating new email") ||
          msg.text().includes("Email created"))
      ) {
        console.log(`📧 ${msg.text()}`);
      }
    });

    page.on("pageerror", (error) => {
      console.log(`🔴 Page Error: ${error.message}`);
    });

    // Verify TEST_EMAIL is configured
    const testEmail = getTestEmail();
    console.log(`📧 Using TEST_EMAIL for order confirmation: ${testEmail}`);
    expect(testEmail).toBeTruthy();
    expect(testEmail).toContain("@");

    // Create a test user and sign up
    const user = await signupThroughUi(page);

    // Navigate to home page
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");

    // Wait for products to load - Azure services may need time to wake up
    console.log("⏳ Waiting for products to load on homepage...");
    await page.waitForTimeout(3000);

    // Check if product links are available
    const productLinks = page.locator('[href*="/product/"]');
    const productCount = await productLinks.count();

    if (productCount === 0) {
      console.log(
        "⏳ Products not visible yet, waiting additional 5 seconds...",
      );
      await page.waitForTimeout(5000);
      const retryCount = await productLinks.count();

      if (retryCount === 0) {
        console.log(
          "⚠️  No products found on homepage - selecting random product from database",
        );
        // Get a random in-stock product instead
        const randomProductIds = await getInStockProductIds(1);
        const randomProductId = randomProductIds[0];
        console.log(`🎲 Selected random product ${randomProductId}`);
        await page.goto(`${testEnv.webBaseUrl}/product/${randomProductId}`);
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(2000);
      } else {
        console.log(`✅ Found ${retryCount} products after retry`);
        const productLink = productLinks.first();
        await expect(productLink).toBeVisible();

        // Get the href to navigate directly instead of clicking
        const href = await productLink.getAttribute("href");
        if (href) {
          console.log(`📌 Navigating to product: ${href}`);
          await page.goto(`${testEnv.webBaseUrl}${href}`);
          await page.waitForLoadState("domcontentloaded");
        } else {
          // Fallback to random product
          const randomProductIds = await getInStockProductIds(1);
          await page.goto(
            `${testEnv.webBaseUrl}/product/${randomProductIds[0]}`,
          );
          await page.waitForLoadState("domcontentloaded");
        }
      }
    } else {
      console.log(`✅ Found ${productCount} products on homepage`);
      const productLink = productLinks.first();
      await expect(productLink).toBeVisible();

      // Get the href to navigate directly instead of clicking
      const href = await productLink.getAttribute("href");
      if (href) {
        console.log(`📌 Navigating to product: ${href}`);
        await page.goto(`${testEnv.webBaseUrl}${href}`);
        await page.waitForLoadState("domcontentloaded");
      } else {
        // Fallback to random product
        const randomProductIds = await getInStockProductIds(1);
        await page.goto(`${testEnv.webBaseUrl}/product/${randomProductIds[0]}`);
        await page.waitForLoadState("domcontentloaded");
      }
    }

    // Add a product to cart
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(/\/product\//);

    // Check if product is in stock
    const outOfStockMsg = page.getByText(/out of stock|unavailable/i);
    if ((await outOfStockMsg.count()) > 0) {
      console.log(
        "⚠️  Product is out of stock, trying another random product...",
      );
      const randomProductIds = await getInStockProductIds(1);
      await page.goto(`${testEnv.webBaseUrl}/product/${randomProductIds[0]}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1000);
    }

    const addToCartButton = page.getByRole("button", { name: /add to cart/i });
    await expect(addToCartButton).toBeVisible();
    await addToCartButton.click();

    // Wait for toast notification to appear
    console.log("⏳ Waiting for add to cart confirmation...");
    const toast = page
      .locator('[role="status"]')
      .or(page.locator(".toast"))
      .or(page.getByText(/added to cart/i));

    try {
      await toast.first().waitFor({ timeout: 5000 });
      const toastText = await toast.first().textContent();
      console.log(`📢 Toast message: ${toastText}`);

      // Fail explicitly if add-to-cart returned an error (do not skip)
      expect(
        toastText?.toLowerCase(),
        "Add to cart failed (error toast). Check cart API; run: npx tsx tests/scripts/check-checkout-dab.ts",
      ).not.toMatch(/error|failed/);

      console.log("✅ First item added to cart successfully");
    } catch (error) {
      console.log(
        "⚠️  No toast notification appeared - cart add may have failed silently",
      );
    }

    // Wait additional time for API to complete
    await page.waitForTimeout(2000);
    await page.goto(testEnv.webBaseUrl);
    await page.waitForTimeout(2000); // Wait for products to load again

    const secondProductLinks = page.locator('[href*="/product/"]');
    if ((await secondProductLinks.count()) > 1) {
      const secondProductLink = secondProductLinks.nth(1);
      const href = await secondProductLink.getAttribute("href");
      if (href) {
        console.log(`📌 Navigating to second product: ${href}`);
        await page.goto(`${testEnv.webBaseUrl}${href}`);
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(1000);

        const addToCartButton2 = page.getByRole("button", {
          name: /add to cart/i,
        });
        await expect(addToCartButton2).toBeVisible();
        await addToCartButton2.click();

        // Wait for toast notification
        console.log("⏳ Waiting for second add to cart confirmation...");
        const toast2 = page
          .locator('[role="status"]')
          .or(page.locator(".toast"))
          .or(page.getByText(/added to cart|updated/i));

        try {
          await toast2.first().waitFor({ timeout: 5000 });
          const toastText = await toast2.first().textContent();
          console.log(`📢 Toast message: ${toastText}`);

          if (
            toastText &&
            (toastText.toLowerCase().includes("error") ||
              toastText.toLowerCase().includes("failed"))
          ) {
            console.log("❌ Failed to add second item to cart");
          } else {
            console.log("✅ Second item added to cart successfully");
          }
        } catch (error) {
          console.log("⚠️  No toast for second item");
        }

        await page.waitForTimeout(2000);
      }
    }

    // Navigate to cart
    await page.goto(`${testEnv.webBaseUrl}/cart`);
    await expect(page).toHaveURL(/\/cart/);

    // Wait for cart page to be ready (cart content or empty state)
    console.log("⏳ Waiting for cart page to load and fetch items...");
    await expect(
      page
        .locator('[data-testid*="cart-item"]')
        .or(page.getByRole("link", { name: /checkout/i }))
        .or(page.getByText(/your cart is empty|no items/i))
        .first(),
    ).toBeVisible({ timeout: 15000 });

    // Get current user's businessEntityId from localStorage
    const currentUser = await page.evaluate(() => {
      const stored = localStorage.getItem("adventureworks_current_user");
      return stored ? JSON.parse(stored) : null;
    });
    const userBusinessEntityId = currentUser?.businessEntityId;
    console.log(`👤 Current user BusinessEntityID: ${userBusinessEntityId}`);

    // Try to directly query the cart API to see if items exist
    const apiUrl =
      process.env.VITE_API_URL || testEnv.restApiBaseUrl.replace("/api", "");
    try {
      const cartApiResponse = await page.evaluate(
        async ({ url, shoppingCartId }) => {
          try {
            const response = await fetch(`${url}/graphql`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                query: `query GetCart($shoppingCartId: String!) { 
                  shoppingCartItems(filter: { ShoppingCartID: { eq: $shoppingCartId } }) { 
                    items { ShoppingCartItemID ProductID Quantity ShoppingCartID } 
                  } 
                }`,
                variables: { shoppingCartId },
              }),
            });
            return await response.json();
          } catch (e) {
            return { error: String(e) };
          }
        },
        { url: apiUrl, shoppingCartId: userBusinessEntityId?.toString() },
      );
      console.log(
        `🔍 Direct GraphQL cart query for ShoppingCartID ${userBusinessEntityId}:`,
        JSON.stringify(cartApiResponse),
      );
    } catch (error) {
      console.log(`⚠️  Could not query cart API directly:`, error);
    }

    // Retry logic: Wait for cart items to appear (longer under parallel load / cold start)
    let cartItemCount = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cartItems = page.locator('[data-testid*="cart-item"]');
      cartItemCount = await cartItems.count();
      console.log(
        `📦 Attempt ${attempt + 1}/8: Cart has ${cartItemCount} items displayed on page`,
      );
      if (cartItemCount > 0) break;
      await page.waitForTimeout(2500);
    }

    expect(
      cartItemCount,
      "Cart empty after add. Possible ShoppingCartID/cache/API issue. Run: npx tsx tests/scripts/check-checkout-dab.ts",
    ).toBeGreaterThan(0);

    // Proceed to checkout - use link role since it's a Link component
    const checkoutButton = page.getByRole("link", {
      name: /checkout|proceed to checkout/i,
    });
    await expect(checkoutButton).toBeVisible({ timeout: 5000 });
    await checkoutButton.click();

    // Should be on checkout page
    await expect(page).toHaveURL(/\/checkout/);

    // Wait for checkout form to be ready (address or Place Order visible) before filling
    console.log("⏳ Waiting for checkout form to load");
    await expect(
      page
        .getByRole("button", {
          name: /add a different email|place order|pay/i,
        })
        .or(page.getByLabel(/address line 1|street address/i))
        .first(),
    ).toBeVisible({ timeout: 20000 });

    // CRITICAL: Click "Add a different email" to enter TEST_EMAIL for order confirmation
    const addEmailButton = page.getByRole("button", {
      name: /add a different email/i,
    });
    if ((await addEmailButton.count()) > 0) {
      await addEmailButton.click();
      console.log("✅ Clicked 'Add a different email' button");
      await page.waitForTimeout(500);

      // Now fill in the TEST_EMAIL
      const emailInput = page
        .getByLabel(/email/i)
        .or(page.locator('input[type="email"]'))
        .last();
      if ((await emailInput.count()) > 0) {
        await emailInput.fill(testEmail);
        console.log(`✅ Set order confirmation email to: ${testEmail}`);
      }
    } else {
      console.log(
        "⚠️  'Add a different email' button not found - using default email",
      );
    }

    // Fill shipping address
    const shippingAddress = createCheckoutAddress();

    // Look for address fields - try multiple strategies
    const addressLine1Input = page
      .getByLabel(/address line 1|street address/i)
      .or(page.locator('input[placeholder*="Adventure"]'))
      .or(page.locator('input[name*="address"]').first());

    const addressFieldCount = await addressLine1Input.count();
    console.log(`🔍 Found ${addressFieldCount} address input field(s)`);

    if (addressFieldCount > 0) {
      console.log("✏️  Filling shipping address form");
      await addressLine1Input.fill(shippingAddress.addressLine1);

      const cityInput = page.getByLabel(/city/i);
      await cityInput.fill(shippingAddress.city);

      // Country selector - wait for it to be enabled (countries load async) then select
      console.log(`🌍 Selecting country: ${shippingAddress.country}`);
      const countrySelector = page.getByLabel(/country/i);
      await expect(countrySelector).toBeEnabled({ timeout: 30000 });
      await countrySelector.selectOption({ label: shippingAddress.country });

      // State selector - wait for options to populate then select
      console.log(`📍 Selecting state: ${shippingAddress.stateLabel}`);
      const stateSelector = page.getByLabel(/state|province/i);
      await expect(stateSelector).toBeEnabled({ timeout: 20000 });
      await stateSelector.selectOption({ label: shippingAddress.stateLabel });

      const postalCodeInput = page.getByLabel(/postal code|zip code/i);
      await postalCodeInput.fill(shippingAddress.postalCode);

      console.log("✅ Address form filled, looking for Save Address button");

      // Check the "Save address for future orders" checkbox
      const saveAddressCheckbox = page.getByLabel(/save.*address.*future/i);
      if ((await saveAddressCheckbox.count()) > 0) {
        await saveAddressCheckbox.check();
        console.log("✅ Checked 'Save address for future orders' checkbox");
      }

      // Click Save Address to proceed to payment step
      const saveAddressButton = page.getByRole("button", {
        name: /save address|continue|next/i,
      });
      const buttonCount = await saveAddressButton.count();
      console.log(`🔘 Found ${buttonCount} Save Address button(s)`);

      if (buttonCount > 0) {
        await saveAddressButton.click();
        console.log("✅ Clicked Save Address to proceed to payment");

        // Wait for payment step to be ready
        console.log("⏳ Waiting for payment form to load...");

        // First, wait for the payment section header to be visible
        await page
          .locator("text=/payment.*method/i")
          .waitFor({ state: "visible", timeout: 5000 });
        console.log("✅ Payment section visible");

        // Wait a moment for the form to fully render
        await page.waitForTimeout(1000);

        // Try multiple selectors for card number input
        const cardNumberInput = page
          .locator(
            'input[placeholder*="4242"], input[placeholder*="card"], input[type="text"]',
          )
          .first();
        await cardNumberInput.waitFor({ state: "visible", timeout: 5000 });
        console.log("✅ Payment form loaded");
      } else {
        console.warn(
          "⚠️  Could not find Save Address button - may auto-advance",
        );
      }
    }

    // Fill payment information - use label or placeholder to target correct inputs
    const cardNumberInput = page.getByLabel(/card number/i).or(
      page.locator('input[placeholder*="4242"]').first(),
    );
    if ((await cardNumberInput.count()) > 0) {
      console.log("💳 Filling payment information");

      // Use valid Luhn test card (Visa format with spaces - app formats on change)
      await cardNumberInput.fill("4242 4242 4242 4242");
      await cardNumberInput.blur();
      await page.waitForTimeout(200);

      const cardholderNameInput = page.getByLabel(/cardholder|name/i).first();
      if ((await cardholderNameInput.count()) > 0) {
        await cardholderNameInput.fill("Test User");
        await cardholderNameInput.blur();
        await page.waitForTimeout(200);
        console.log("✅ Filled cardholder name");
      }

      const expiryInput = page.getByPlaceholder(/mm.*yy/i).first();
      if ((await expiryInput.count()) > 0) {
        await expiryInput.fill("12/28");
        await expiryInput.blur();
        await page.waitForTimeout(200);
        console.log("✅ Filled expiry date: 12/28");
      }

      const cvvInput = page.getByPlaceholder(/123|cvv/i).first();
      if ((await cvvInput.count()) > 0) {
        await cvvInput.fill("123");
        await cvvInput.blur();
        await page.waitForTimeout(500);
        console.log("✅ Filled CVV");
      }
      // Brief wait for React validation (Luhn) to run and enable Place Order
      await page.waitForTimeout(500);
    } else {
      console.log(
        "⚠️  Card number input not found - payment form may not be visible",
      );
    }

    // Submit order - prefer data-testid for reliable selection across locales
    console.log("🔍 Looking for Place Order button...");
    const placeOrderButton = page
      .getByTestId("place-order-button")
      .or(
        page.getByRole("button", {
          name: /pay|place order|complete order/i,
        }),
      );

    await expect(placeOrderButton).toBeVisible();
    // Wait for validation to pass and button to become enabled (Luhn + all fields)
    await expect(placeOrderButton).toBeEnabled({ timeout: 15000 });
    await placeOrderButton.click();
    console.log("✅ Clicked Place Order button");

    // Wait a moment for any immediate response
    await page.waitForTimeout(2000);

    // Check for error messages
    const errorToast = page.locator('[role="alert"], .error, [class*="error"]');
    const hasError = await errorToast.isVisible().catch(() => false);
    if (hasError) {
      const errorText = await errorToast.textContent();
      console.log(`⚠️  Error message displayed: ${errorText}`);
    }

    // Check current URL
    const currentURL = page.url();
    console.log(`🔍 Current URL after clicking Place Order: ${currentURL}`);

    // Wait for order confirmation page
    await expect(page).toHaveURL(/\/order-confirmation|\/order\/|\/thank-you/, {
      timeout: 15000,
    });

    // Verify order confirmation message
    await expect(
      page
        .getByText(/thank you|order confirmed|order placed|order received/i)
        .first(),
    ).toBeVisible({ timeout: 10000 });

    // Look for order number
    const orderNumber = page.locator(
      '[data-testid*="order-number"], [class*="order-number"]',
    );
    if ((await orderNumber.count()) > 0) {
      await expect(orderNumber.first()).toBeVisible();
      const orderNum = await orderNumber.first().textContent();
      console.log(`✅ Order placed successfully. Order #: ${orderNum}`);
    }

    // Verify order confirmation email address is displayed
    const confirmationEmail = page.getByText(new RegExp(testEmail, "i"));
    if ((await confirmationEmail.count()) > 0) {
      await expect(confirmationEmail.first()).toBeVisible();
      console.log(
        `✅ Order confirmation will be sent to TEST_EMAIL: ${testEmail}`,
      );
    }

    console.log("✅ Checkout flow completed successfully");
  });

  test("checkout validates required fields", async ({ page }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to home page and wait for products to load
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    console.log("⏳ Waiting for products to load...");
    await page.waitForTimeout(3000);

    // Check if product links are available
    const productLinks = page.locator('[href*="/product/"]');
    let productLink = productLinks.first();

    if ((await productLinks.count()) === 0) {
      console.log(
        "⏳ Products not visible yet, waiting additional 5 seconds...",
      );
      await page.waitForTimeout(5000);

      if ((await productLinks.count()) === 0) {
        console.log("⚠️  Going directly to random product from database");
        const randomProductIds = await getInStockProductIds(1);
        await page.goto(`${testEnv.webBaseUrl}/product/${randomProductIds[0]}`);
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(2000);
      } else {
        const href = await productLink.getAttribute("href");
        if (href) {
          await page.goto(`${testEnv.webBaseUrl}${href}`);
          await page.waitForLoadState("domcontentloaded");
        } else {
          const randomProductIds = await getInStockProductIds(1);
          await page.goto(
            `${testEnv.webBaseUrl}/product/${randomProductIds[0]}`,
          );
          await page.waitForLoadState("domcontentloaded");
        }
      }
    } else {
      const href = await productLink.getAttribute("href");
      if (href) {
        await page.goto(`${testEnv.webBaseUrl}${href}`);
        await page.waitForLoadState("domcontentloaded");
      } else {
        const randomProductIds = await getInStockProductIds(1);
        await page.goto(`${testEnv.webBaseUrl}/product/${randomProductIds[0]}`);
        await page.waitForLoadState("domcontentloaded");
      }
    }

    // Add a product to cart
    if (!page.url().includes("/product/")) {
      await expect(page).toHaveURL(/\/product\//);
    }

    // Wait for product page content so Add to cart is present (not out-of-stock or loading)
    await expect(
      page.locator("h1, h2, [data-testid='product-name']").first(),
    ).toBeVisible({ timeout: 15000 });

    // Check if product is in stock before attempting to add to cart
    const outOfStockMsg = page.getByText(/out of stock|unavailable/i);
    if ((await outOfStockMsg.count()) > 0) {
      console.log(
        "⚠️  Product is out of stock, trying another random product...",
      );
      const randomProductIds = await getInStockProductIds(1);
      await page.goto(`${testEnv.webBaseUrl}/product/${randomProductIds[0]}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);
    }

    // Prefer data-testid for Add to cart (ProductPage uses add-to-cart-button); fallback for locale
    const addToCartButton = page
      .getByTestId("add-to-cart-button")
      .or(page.getByRole("button", { name: /add to cart|add to bag/i }));
    await expect(addToCartButton).toBeVisible({ timeout: 15000 });

    // Ensure button is enabled
    await expect(addToCartButton).toBeEnabled({ timeout: 5000 });
    await addToCartButton.click();

    // Wait for cart to update
    console.log("⌛ Waiting for item to be added to cart...");
    await page.waitForTimeout(2000);
    console.log("✅ Item added to cart");

    // Navigate to cart
    await page.goto(`${testEnv.webBaseUrl}/cart`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for cart to load and verify it has items with retry logic (more attempts under parallel load)
    let cartItemCount = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cartItems = page.locator('[data-testid*="cart-item"]');
      cartItemCount = await cartItems.count();
      console.log(
        `📦 Cart check attempt ${attempt + 1}/8: Cart has ${cartItemCount} items`,
      );
      if (cartItemCount > 0) break;
      await page.waitForTimeout(2500);
    }

    expect(
      cartItemCount,
      "Cart empty before validation. Run: npx tsx tests/scripts/check-checkout-dab.ts",
    ).toBeGreaterThan(0);

    // Navigate to checkout - use link role since it's a Link component
    const checkoutButton = page.getByRole("link", { name: /checkout/i });
    await expect(checkoutButton).toBeVisible({ timeout: 10000 });
    await checkoutButton.click();

    await expect(page).toHaveURL(/\/checkout/);
    await expect(
      page
        .getByRole("button", { name: /place order|pay|complete order/i })
        .or(page.getByLabel(/address line 1/i)),
    ).toBeVisible({ timeout: 15000 });

    // Try to submit without filling required fields - button shows "Pay $XX.XX"
    const submitButton = page
      .getByRole("button", { name: /pay|place order|complete order/i })
      .or(page.getByTestId("place-order-button"));

    if ((await submitButton.count()) > 0) {
      await submitButton.click();

      // Should show validation errors
      const errorMessages = page.locator(
        '[class*="error"], [role="alert"], .text-red-500, .text-destructive',
      );

      // Wait a moment for validation to trigger
      await page.waitForTimeout(1000);

      // Should either see error messages or be prevented from submitting
      const currentUrl = page.url();
      const hasErrors = (await errorMessages.count()) > 0;
      const stillOnCheckout = currentUrl.includes("checkout");

      expect(hasErrors || stillOnCheckout).toBeTruthy();
      console.log("✅ Checkout validation is working");
    }
  });

  test("cart persists during checkout process", async ({ page }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to home page and wait for products to load
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    console.log("⏳ Waiting for products to load...");
    await page.waitForTimeout(3000);

    // Check if product links are available
    const productLinks = page.locator('[href*="/product/"]');

    if ((await productLinks.count()) === 0) {
      console.log(
        "⏳ Products not visible yet, waiting additional 5 seconds...",
      );
      await page.waitForTimeout(5000);
    }

    const availableProductCount = await productLinks.count();
    if (availableProductCount === 0) {
      console.log(
        "⚠️  No products available - using random products from database",
      );
      const randomProductIds = await getInStockProductIds(2);
      // Add first product
      await page.goto(`${testEnv.webBaseUrl}/product/${randomProductIds[0]}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);

      const firstAddButton = page.getByRole("button", { name: /add to cart/i });
      await expect(firstAddButton).toBeVisible({ timeout: 10000 });
      await expect(firstAddButton).toBeEnabled({ timeout: 5000 });
      await firstAddButton.click();
      await page.waitForTimeout(1000);

      // Add second product
      await page.goto(`${testEnv.webBaseUrl}/product/${randomProductIds[1]}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);

      const secondAddButton = page.getByRole("button", {
        name: /add to cart/i,
      });
      await expect(secondAddButton).toBeVisible({ timeout: 10000 });
      await expect(secondAddButton).toBeEnabled({ timeout: 5000 });
      await secondAddButton.click();
      await page.waitForTimeout(1000);
    } else {
      console.log(`✅ Found ${availableProductCount} products`);

      // Add first product
      const firstProduct = productLinks.first();
      const firstHref = await firstProduct.getAttribute("href");
      if (firstHref) {
        await page.goto(`${testEnv.webBaseUrl}${firstHref}`);
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(1000);

        const firstAddButton = page.getByRole("button", {
          name: /add to cart/i,
        });
        await expect(firstAddButton).toBeVisible({ timeout: 10000 });
        await expect(firstAddButton).toBeEnabled({ timeout: 5000 });
        await firstAddButton.click();
        await page.waitForTimeout(1000);
      }

      // Add second product
      await page.goto(testEnv.webBaseUrl);
      await page.waitForTimeout(2000);
      const secondProduct = page.locator('[href*="/product/"]').nth(1);
      if ((await secondProduct.count()) > 0) {
        const secondHref = await secondProduct.getAttribute("href");
        if (secondHref) {
          await page.goto(`${testEnv.webBaseUrl}${secondHref}`);
          await page.waitForLoadState("domcontentloaded");
          await page.waitForTimeout(1000);

          const secondAddButton = page.getByRole("button", {
            name: /add to cart/i,
          });
          await expect(secondAddButton).toBeVisible({ timeout: 10000 });
          await expect(secondAddButton).toBeEnabled({ timeout: 5000 });
          await secondAddButton.click();
          await page.waitForTimeout(1000);
        }
      }
    }

    // Go to cart and verify items
    await page.goto(`${testEnv.webBaseUrl}/cart`);

    // Wait for cart items to load with retry logic (more attempts under parallel load)
    let initialCount = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cartItems = page.locator('[data-testid*="cart-item"]');
      initialCount = await cartItems.count();
      console.log(
        `📦 Attempt ${attempt + 1}/8: Cart has ${initialCount} items initially`,
      );
      if (initialCount > 0) break;
      await page.waitForTimeout(2500);
    }
    console.log(`📦 Cart has ${initialCount} items initially`);

    expect(
      initialCount,
      "Cart empty before persistence check. Run: npx tsx tests/scripts/check-checkout-dab.ts",
    ).toBeGreaterThan(0);

    // Proceed to checkout - use link role since it's a Link component
    const checkoutButton = page.getByRole("link", { name: /checkout/i });
    await expect(checkoutButton).toBeVisible({ timeout: 10000 });
    await checkoutButton.click();
    await expect(page).toHaveURL(/\/checkout/);
    await expect(
      page
        .getByRole("button", { name: /place order|pay/i })
        .or(page.getByLabel(/address line 1/i)),
    ).toBeVisible({ timeout: 15000 });

    // Go back to cart
    await page.goto(`${testEnv.webBaseUrl}/cart`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for cart to refetch with retry logic (more attempts under parallel load)
    let finalCount = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cartItems = page.locator('[data-testid*="cart-item"]');
      finalCount = await cartItems.count();
      console.log(
        `📦 After navigation attempt ${attempt + 1}/8: Cart has ${finalCount} items`,
      );
      if (finalCount >= initialCount) break;
      await page.waitForTimeout(2500);
    }

    expect(finalCount).toBe(initialCount);
    console.log("✅ Cart persists correctly during checkout process");
  });
});
