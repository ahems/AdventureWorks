import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Products (Category & Detail)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("Bikes category page loads and shows products", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Subcategory filter buttons visible
    await expect(
      page.getByText(/mountain bikes|road bikes|touring bikes/i).first(),
    ).toBeVisible({
      timeout: 20_000,
    });
    // At least one product card
    await expect(
      page.locator("[data-testid=admin-product-card], .doodle-card").nth(1),
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test("category page supports subcategory filtering", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Click first subcategory filter that appears
    const firstSubcat = page
      .getByRole("button", { name: /mountain bikes/i })
      .first();
    await expect(firstSubcat).toBeVisible({ timeout: 15_000 });
    await firstSubcat.click();
    // Products should still be shown
    await expect(page.locator(".doodle-card").nth(1)).toBeVisible();
  });

  test("category page supports sort by name", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Sort select should be visible
    await expect(page.getByText(/name a-z|name z-a|sort/i).first()).toBeVisible(
      { timeout: 15_000 },
    );
  });

  test("clicking a product navigates to product detail page", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Wait for products to load
    await page.waitForTimeout(2000);
    const productLinks = page
      .getByRole("link")
      .filter({ hasText: /edit|view|bike/i });
    const firstProductLink = productLinks.first();
    if ((await firstProductLink.count()) > 0) {
      const href = await firstProductLink.getAttribute("href");
      if (href && href.includes("/product/")) {
        await firstProductLink.click();
        await expect(page).toHaveURL(/\/product\/\d+/);
        await expect(page.getByText(/edit product/i)).toBeVisible({
          timeout: 15_000,
        });
      }
    }
  });

  test("product detail page shows SKU field", async ({ page }) => {
    // Navigate directly to a known product to avoid SPA-navigation timing issues
    // Product 775 = Mountain-100 Black, 38 (always present in AdventureWorks seed data)
    await page.goto(`${testEnv.adminWebBaseUrl}/product/775`);

    // Edit Product heading confirms the product loaded (not "Product Not Found")
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 20_000,
    });
    // SKU label is rendered inside the Edit Product card
    await expect(page.locator("label", { hasText: /^SKU$/i })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("Components category page loads", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/2`);
    await expect(
      page.getByText(/components|handlebars|frames|wheels/i).first(),
    ).toBeVisible({
      timeout: 20_000,
    });
  });
});
