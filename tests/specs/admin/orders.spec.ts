import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Orders", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${testEnv.adminWebBaseUrl}/orders`);
  });

  test("orders page renders and shows order rows", async ({ page }) => {
    await expect(page.getByText(/orders/i).first()).toBeVisible();
    // Orders are rendered as <div> cards, not <tr> rows.
    // Wait for the first order heading (Order #XXXXX) to appear.
    await expect(page.locator(".doodle-card h3").first()).toBeVisible({
      timeout: 25_000,
    });
  });

  test("order search input is present", async ({ page }) => {
    const searchInput = page
      .getByPlaceholder(/search.*order|order.*search/i)
      .first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
  });

  test("status filter dropdown is present", async ({ page }) => {
    const statusFilter = page.getByRole("combobox").first();
    await expect(statusFilter).toBeVisible({ timeout: 15_000 });
  });

  test("expanding an order shows detail rows", async ({ page }) => {
    // Wait for orders to appear (div cards, not table rows)
    await expect(page.locator(".doodle-card h3").first()).toBeVisible({
      timeout: 25_000,
    });
    // Click first row expander
    const firstExpandBtn = page
      .getByRole("button", { name: /expand|details|chevron/i })
      .first();
    if (await firstExpandBtn.isVisible({ timeout: 5_000 })) {
      await firstExpandBtn.click();
      // Order details sub-table should appear
      await expect(
        page.getByText(/qty|unit price|line total|product/i).first(),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("DAB pagination: Next 100 button is enabled and navigates to next batch", async ({
    page,
  }) => {
    // Wait for order cards to load
    await expect(page.locator(".doodle-card h3").first()).toBeVisible({
      timeout: 25_000,
    });
    // The AdventureWorks dataset has >100 sales orders, so the DAB Next button must appear
    const nextBtn = page.getByRole("button", { name: /next 100/i });
    await expect(nextBtn).toBeVisible({ timeout: 10_000 });
    await expect(nextBtn).toBeEnabled();

    // Previous should be disabled on the first batch
    const prevBtn = page.getByRole("button", { name: /previous 100/i });
    await expect(prevBtn).toBeDisabled();

    // Navigate to the next batch
    const firstOrderText = await page
      .locator(".doodle-card h3")
      .first()
      .textContent();
    await nextBtn.click();
    await page.waitForTimeout(1_000);
    // Previous should now be enabled
    await expect(prevBtn).toBeEnabled();
    // The first order heading should have changed (different batch)
    const newFirstOrderText = await page
      .locator(".doodle-card h3")
      .first()
      .textContent({
        timeout: 15_000,
      });
    expect(newFirstOrderText).not.toEqual(firstOrderText);
  });
});
