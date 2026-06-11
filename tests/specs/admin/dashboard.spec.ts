import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("shows all four KPI cards", async ({ page }) => {
    await expect(page.getByText(/total products/i)).toBeVisible();
    await expect(page.getByText(/customers/i).first()).toBeVisible();
    await expect(page.getByText(/orders/i).first()).toBeVisible();
    await expect(page.getByText(/reviews/i).first()).toBeVisible();
  });

  test("KPI counts are numbers (not loading spinners)", async ({ page }) => {
    // Wait for at least one numeric count to appear in a card
    await expect(
      page.locator(".doodle-card").filter({ hasText: /\d+/ }).first(),
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test("recent orders panel is displayed", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: /recent orders/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("AI Data Assistant section is rendered", async ({ page }) => {
    await expect(page.getByText(/ai data assistant/i).first()).toBeVisible();
  });

  test("Business Intelligence section is rendered", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: /business intelligence/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("quick action category links navigate to correct category pages", async ({
    page,
  }) => {
    await page.getByRole("link", { name: /browse bikes/i }).click();
    await expect(page).toHaveURL(/\/category\/1/);
    await expect(page.getByText(/bikes/i).first()).toBeVisible();
  });
});
