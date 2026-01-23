import { test, expect } from "@playwright/test";
import { signupThroughUi } from "../utils/testUser";
import { testEnv } from "../utils/env";

test.describe("User Browsing and Shopping", () => {
  test("user can browse categories, view products, and add items to cart", async ({
    page,
  }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to home page
    await page.goto(testEnv.webBaseUrl);

    // Wait for the page to load
    await expect(page.locator("h1, h2").first()).toBeVisible();

    // Browse categories - look for category links in navigation or on page
    const categoryLinks = page.locator('[href*="/category/"]').first();
    await expect(categoryLinks).toBeVisible();

    // Click on the first category
    await categoryLinks.click();

    // Verify we're on a category page
    await expect(page).toHaveURL(/\/category\//);

    // Wait for products to load
    await page.waitForSelector('[data-testid*="product"], [class*="product"]', {
      timeout: 10000,
    });

    // Find and click on a product
    const productLink = page
      .locator('[href*="/product/"], a:has-text("View Details"), a:has(img)')
      .first();
    await productLink.click();

    // Verify we're on a product page
    await expect(page).toHaveURL(/\/product\//);

    // Wait for product details to load
    await expect(
      page.locator("h1, h2, [data-testid='product-name']").first(),
    ).toBeVisible({ timeout: 10000 });

    // Verify product images are shown
    const productImages = page.locator(
      "img[alt*='product'], img[src*='photo']",
    );
    await expect(productImages.first()).toBeVisible();

    // Add product to cart - look for add to cart button
    const addToCartButton = page.getByRole("button", {
      name: /add to cart/i,
    });
    await expect(addToCartButton).toBeVisible();
    await addToCartButton.click();

    // Verify cart was updated - look for success message or cart badge update
    await expect(
      page
        .getByText(/added to cart|item added|successfully added/i)
        .first()
        .or(page.locator('[data-testid="cart-count"]')),
    ).toBeVisible({ timeout: 5000 });

    // Browse another category
    await page.goto(testEnv.webBaseUrl);

    // Find a different category
    const allCategoryLinks = await page
      .locator('[href*="/category/"]')
      .elementHandles();
    if (allCategoryLinks.length > 1) {
      await allCategoryLinks[1].click();
      await expect(page).toHaveURL(/\/category\//);

      // Click on another product
      const secondProductLink = page
        .locator('[href*="/product/"], a:has-text("View Details")')
        .nth(1);
      await secondProductLink.click();

      // Add second product to cart
      await expect(page).toHaveURL(/\/product\//);
      const addToCartButton2 = page.getByRole("button", {
        name: /add to cart/i,
      });
      await addToCartButton2.click();
    }

    // Navigate to cart page
    await page.goto(`${testEnv.webBaseUrl}/cart`);

    // Verify cart page loaded
    await expect(page).toHaveURL(/\/cart/);

    // Verify we have items in cart
    const cartItems = page.locator(
      '[data-testid*="cart-item"], [class*="cart"]',
    );
    await expect(cartItems.first()).toBeVisible({ timeout: 5000 });

    console.log("✅ Successfully browsed categories and added items to cart");
  });

  test("user can view product details and images", async ({ page }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to home page
    await page.goto(testEnv.webBaseUrl);

    // Find and click on a featured or recommended product
    const productLink = page.locator('[href*="/product/"]').first();
    await expect(productLink).toBeVisible();
    await productLink.click();

    // Verify we're on a product page
    await expect(page).toHaveURL(/\/product\//);

    // Verify product name is visible
    const productName = page
      .locator("h1, h2, [data-testid='product-name']")
      .first();
    await expect(productName).toBeVisible();

    // Verify product price is visible
    const price = page
      .locator('[class*="price"], [data-testid*="price"]')
      .first();
    await expect(price).toBeVisible();

    // Verify product image gallery exists
    const images = page.locator("img[alt*='product'], img[src*='photo']");
    const imageCount = await images.count();
    expect(imageCount).toBeGreaterThan(0);

    // Verify at least one image is loaded
    const firstImage = images.first();
    await expect(firstImage).toBeVisible();

    // Check if product description exists
    const description = page.locator(
      'p:has-text("description"), [class*="description"], [data-testid*="description"]',
    );
    if ((await description.count()) > 0) {
      await expect(description.first()).toBeVisible();
    }

    console.log("✅ Product details and images displayed correctly");
  });

  test("user can navigate between multiple products", async ({ page }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to a category page
    await page.goto(testEnv.webBaseUrl);
    const categoryLink = page.locator('[href*="/category/"]').first();
    await categoryLink.click();

    // Store first product URL
    const firstProduct = page.locator('[href*="/product/"]').first();
    await firstProduct.click();
    const firstProductUrl = page.url();
    await expect(page).toHaveURL(/\/product\//);

    // Go back to category
    await page.goBack();
    await expect(page).toHaveURL(/\/category\//);

    // Click on a different product
    const secondProduct = page.locator('[href*="/product/"]').nth(1);
    await secondProduct.click();
    const secondProductUrl = page.url();
    await expect(page).toHaveURL(/\/product\//);

    // Verify we're on a different product
    expect(firstProductUrl).not.toBe(secondProductUrl);

    // Verify product details load correctly
    await expect(page.locator("h1, h2").first()).toBeVisible();
    await expect(page.locator("img").first()).toBeVisible();

    console.log("✅ Successfully navigated between multiple products");
  });
});
