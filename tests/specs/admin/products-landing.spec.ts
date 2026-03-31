import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Products Landing Page (/products)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("/products page loads with category cards", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/products`);
    // Heading visible
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({
      timeout: 20_000,
    });
    // At least 4 category cards (AdventureWorks has Bikes, Components, Clothing, Accessories)
    const cards = page.locator("[data-testid^='category-card-']");
    await expect(cards.nth(3)).toBeVisible({ timeout: 20_000 });
  });

  test("category cards show name and product count", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/products`);
    // Wait for cards
    await expect(
      page.locator("[data-testid^='category-card-']").first(),
    ).toBeVisible({ timeout: 20_000 });
    // Each card should contain a subcategory or product count text
    const firstCard = page.locator("[data-testid^='category-card-']").first();
    await expect(
      firstCard.getByText(/product|subcategor/i).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test("clicking a category card navigates to /category/:id", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/products`);
    const firstCard = page.locator("[data-testid^='category-card-']").first();
    await expect(firstCard).toBeVisible({ timeout: 20_000 });
    await firstCard.click();
    await expect(page).toHaveURL(/\/category\/\d+/, { timeout: 10_000 });
  });

  test("Products landing page has Create Product button", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/products`);
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({
      timeout: 20_000,
    });
    const createBtn = page.getByTestId("create-product-btn");
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
  });

  test("header Products link points to /products", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/`);
    const productsLink = page
      .getByRole("link", { name: /^products$/i })
      .first();
    await expect(productsLink).toBeVisible({ timeout: 10_000 });
    const href = await productsLink.getAttribute("href");
    expect(href).toContain("/products");
  });
});
