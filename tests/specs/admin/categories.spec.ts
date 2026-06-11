import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Categories Management Page (/categories)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("/categories page loads with category table", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/categories`);
    await expect(page.getByRole("heading", { name: "Categories" })).toBeVisible(
      {
        timeout: 20_000,
      },
    );
    // Categories table should exist
    const table = page.getByTestId("categories-table");
    await expect(table).toBeVisible({ timeout: 20_000 });
  });

  test("categories table has at least 4 rows (Bikes, Components, Clothing, Accessories)", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/categories`);
    const table = page.getByTestId("categories-table");
    await expect(table).toBeVisible({ timeout: 20_000 });
    // At least 4 category rows
    const rows = page.locator("[data-testid^='category-row-']");
    await expect(rows.nth(3)).toBeVisible({ timeout: 15_000 });
  });

  test("Create Category button visible", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/categories`);
    await expect(page.getByRole("heading", { name: "Categories" })).toBeVisible(
      {
        timeout: 20_000,
      },
    );
    const createBtn = page.getByTestId("create-category-btn");
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
  });

  test("Create Category dialog has US English badge", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/categories`);
    const createBtn = page.getByTestId("create-category-btn");
    await expect(createBtn).toBeVisible({ timeout: 20_000 });
    await createBtn.click();
    await expect(page.getByText(/create new category/i)).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("us-english-badge")).toBeVisible({
      timeout: 3_000,
    });
  });

  test("Delete button is disabled for category with subcategories", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/categories`);
    const table = page.getByTestId("categories-table");
    await expect(table).toBeVisible({ timeout: 20_000 });
    // Bikes (category 1) has subcategories — its delete btn should be disabled
    const deleteBikesBtn = page.getByTestId("delete-category-1");
    await expect(deleteBikesBtn).toBeVisible({ timeout: 10_000 });
    await expect(deleteBikesBtn).toBeDisabled();
  });

  test("clicking a category row expands subcategories", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/categories`);
    const firstRow = page.locator("[data-testid^='category-row-']").first();
    await expect(firstRow).toBeVisible({ timeout: 20_000 });
    await firstRow.click();
    // Subcategory rows should appear
    const subRows = page.locator("[data-testid^='subcategory-row-']");
    await expect(subRows.first()).toBeVisible({ timeout: 5_000 });
  });

  test("admin header has Categories nav link", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/`);
    const catLink = page.getByRole("link", { name: /^categories$/i }).first();
    await expect(catLink).toBeVisible({ timeout: 10_000 });
    const href = await catLink.getAttribute("href");
    expect(href).toContain("/categories");
  });
});
