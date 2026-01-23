import { test, expect } from "@playwright/test";
import { faker } from "@faker-js/faker";
import { signupThroughUi } from "../utils/testUser";
import { testEnv } from "../utils/env";
import { execSync } from "child_process";

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
  test("user can complete full checkout process with order confirmation", async ({
    page,
  }) => {
    // Verify TEST_EMAIL is configured
    const testEmail = getTestEmail();
    console.log(`📧 Using TEST_EMAIL for order confirmation: ${testEmail}`);
    expect(testEmail).toBeTruthy();
    expect(testEmail).toContain("@");

    // Create a test user and sign up
    const user = await signupThroughUi(page);

    // Navigate to home page
    await page.goto(testEnv.webBaseUrl);

    // Add a product to cart
    const productLink = page.locator('[href*="/product/"]').first();
    await productLink.click();
    await expect(page).toHaveURL(/\/product\//);

    const addToCartButton = page.getByRole("button", { name: /add to cart/i });
    await expect(addToCartButton).toBeVisible();
    await addToCartButton.click();

    // Wait for cart confirmation
    await page.waitForTimeout(1000);

    // Add one more product for a more realistic order
    await page.goto(testEnv.webBaseUrl);
    const secondProductLink = page.locator('[href*="/product/"]').nth(1);
    if ((await secondProductLink.count()) > 0) {
      await secondProductLink.click();
      await expect(page).toHaveURL(/\/product\//);

      const addToCartButton2 = page.getByRole("button", {
        name: /add to cart/i,
      });
      if ((await addToCartButton2.count()) > 0) {
        await addToCartButton2.click();
        await page.waitForTimeout(1000);
      }
    }

    // Navigate to cart
    await page.goto(`${testEnv.webBaseUrl}/cart`);
    await expect(page).toHaveURL(/\/cart/);

    // Proceed to checkout
    const checkoutButton = page.getByRole("button", {
      name: /checkout|proceed to checkout/i,
    });
    await expect(checkoutButton).toBeVisible({ timeout: 5000 });
    await checkoutButton.click();

    // Should be on checkout page
    await expect(page).toHaveURL(/\/checkout/);

    // Fill shipping address
    const shippingAddress = createCheckoutAddress();

    // Look for address fields
    const addressLine1Input = page
      .getByLabel(/address line 1|street address/i)
      .or(page.locator('input[name*="address"]').first());

    if ((await addressLine1Input.count()) > 0) {
      await addressLine1Input.fill(shippingAddress.addressLine1);

      const cityInput = page.getByLabel(/city/i);
      await cityInput.fill(shippingAddress.city);

      // State selector
      const stateSelector = page.getByLabel(/state|province/i);
      await stateSelector.click();
      const stateOption = page.getByText(
        new RegExp(shippingAddress.stateLabel, "i"),
      );
      if ((await stateOption.count()) > 0) {
        await stateOption.first().click();
      }

      const postalCodeInput = page.getByLabel(/postal code|zip code/i);
      await postalCodeInput.fill(shippingAddress.postalCode);
    }

    // Fill contact email for order confirmation - MUST use TEST_EMAIL
    const contactEmailInput = page
      .getByLabel(/contact email|email for.*confirmation|order.*email/i)
      .or(page.locator('input[name*="contact"][type="email"]'))
      .or(page.locator('input[placeholder*="email"]'));

    if ((await contactEmailInput.count()) > 0) {
      await contactEmailInput.fill(testEmail);
      console.log(`✅ Set order confirmation email to: ${testEmail}`);
    } else {
      console.warn(
        "⚠️ Could not find contact email field - email may use user's primary email",
      );
    }

    // Fill payment information (if required)
    const cardNumberInput = page.getByLabel(/card number/i);
    if ((await cardNumberInput.count()) > 0) {
      // Use a test card number
      await cardNumberInput.fill("4111111111111111");

      const expiryInput = page.getByLabel(/expir/i);
      await expiryInput.fill("12/25");

      const cvvInput = page.getByLabel(/cvv|security code/i);
      await cvvInput.fill("123");
    }

    // Submit order
    const placeOrderButton = page.getByRole("button", {
      name: /place order|complete order|submit order/i,
    });
    await expect(placeOrderButton).toBeVisible();
    await placeOrderButton.click();

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

    // Add a product to cart
    await page.goto(testEnv.webBaseUrl);
    const productLink = page.locator('[href*="/product/"]').first();
    await productLink.click();

    const addToCartButton = page.getByRole("button", { name: /add to cart/i });
    await addToCartButton.click();
    await page.waitForTimeout(1000);

    // Navigate to checkout
    await page.goto(`${testEnv.webBaseUrl}/cart`);
    const checkoutButton = page.getByRole("button", { name: /checkout/i });
    await checkoutButton.click();

    await expect(page).toHaveURL(/\/checkout/);

    // Try to submit without filling required fields
    const submitButton = page.getByRole("button", {
      name: /place order|complete order/i,
    });

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

    // Add multiple products to cart
    await page.goto(testEnv.webBaseUrl);

    // Add first product
    const firstProduct = page.locator('[href*="/product/"]').first();
    await firstProduct.click();
    await page.getByRole("button", { name: /add to cart/i }).click();
    await page.waitForTimeout(500);

    // Add second product
    await page.goto(testEnv.webBaseUrl);
    const secondProduct = page.locator('[href*="/product/"]').nth(1);
    await secondProduct.click();
    await page.getByRole("button", { name: /add to cart/i }).click();
    await page.waitForTimeout(500);

    // Go to cart and verify items
    await page.goto(`${testEnv.webBaseUrl}/cart`);
    const cartItems = page.locator(
      '[data-testid*="cart-item"], [class*="cart"]',
    );
    const initialCount = await cartItems.count();
    expect(initialCount).toBeGreaterThan(0);

    // Proceed to checkout
    const checkoutButton = page.getByRole("button", { name: /checkout/i });
    await checkoutButton.click();
    await expect(page).toHaveURL(/\/checkout/);

    // Go back to cart
    await page.goto(`${testEnv.webBaseUrl}/cart`);

    // Verify items are still in cart
    const cartItemsAfter = page.locator(
      '[data-testid*="cart-item"], [class*="cart"]',
    );
    const finalCount = await cartItemsAfter.count();

    expect(finalCount).toBe(initialCount);
    console.log("✅ Cart persists correctly during checkout process");
  });
});
