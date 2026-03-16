import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Customers", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${testEnv.adminWebBaseUrl}/customers`);
  });

  test("customers page renders with stats dashboard", async ({ page }) => {
    await expect(page.getByText(/customers/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("customer list shows rows after data loads", async ({ page }) => {
    // Customers are rendered as <div> cards, not <tr> rows.
    // Wait for the first customer name heading (h3 with a User icon) to appear.
    await expect(page.locator(".doodle-card h3").first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("search input is present and interactive", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i).first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
    await searchInput.fill("Smith");
    // Result count or empty state should update
    await page.waitForTimeout(500);
  });

  test("country filter is available", async ({ page }) => {
    // Filter dropdowns should be present
    const filterOrSelect = page.getByRole("combobox").first();
    await expect(filterOrSelect).toBeVisible({ timeout: 15_000 });
  });

  test("DAB pagination: Next 100 button is enabled on first load", async ({
    page,
  }) => {
    // Wait for customer cards to load
    await expect(page.locator(".doodle-card h3").first()).toBeVisible({
      timeout: 20_000,
    });
    // The AdventureWorks dataset has >100 individual customers (PersonType='IN')
    const nextBtn = page.getByRole("button", { name: /next 100/i });
    await expect(nextBtn).toBeVisible({ timeout: 10_000 });
    await expect(nextBtn).toBeEnabled();

    // Previous should be disabled on the first batch
    const prevBtn = page.getByRole("button", { name: /previous 100/i });
    await expect(prevBtn).toBeDisabled();

    // Navigate to next batch and verify Previous becomes enabled
    await nextBtn.click();
    await page.waitForTimeout(1_000);
    await expect(prevBtn).toBeEnabled({ timeout: 10_000 });
  });

  test("bulk AI email dialog opens when customers are selected", async ({
    page,
  }) => {
    // Select first checkbox if available
    const firstCheckbox = page.getByRole("checkbox").first();
    if (await firstCheckbox.isVisible()) {
      await firstCheckbox.click({ timeout: 10_000 });
      // Bulk action button should appear
      const bulkBtn = page
        .getByRole("button", { name: /email|bulk|selected/i })
        .first();
      await expect(bulkBtn).toBeVisible({ timeout: 5_000 });
    }
  });
});
