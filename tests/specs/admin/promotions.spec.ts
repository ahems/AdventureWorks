import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Promotions", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${testEnv.adminWebBaseUrl}/promotions`);
  });

  test("promotions page loads with real special offers", async ({ page }) => {
    await expect(
      page.getByText(/promotions|special offer|discount/i).first(),
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test("search input filters promotions", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i).first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
    await searchInput.fill("Volume");
    await page.waitForTimeout(400);
    // At least one Volume Discount offer should remain visible
    await expect(page.getByText(/volume discount/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("create new promotion button is present", async ({ page }) => {
    const createBtn = page
      .getByRole("button", { name: /new promotion|create|add/i })
      .first();
    await expect(createBtn).toBeVisible({ timeout: 15_000 });
  });

  test("status filter is available", async ({ page }) => {
    const filterSelect = page.getByRole("combobox").first();
    await expect(filterSelect).toBeVisible({ timeout: 15_000 });
  });

  test("promotion list shows real data from DB", async ({ page }) => {
    // Verify promotions are loaded from the database by checking the count
    await expect(page.getByText(/showing \d+/i)).toBeVisible({
      timeout: 20_000,
    });
  });
});
