import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Reviews", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${testEnv.adminWebBaseUrl}/reviews`);
  });

  test("reviews page renders", async ({ page }) => {
    await expect(page.getByText(/reviews/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("review cards appear after API loads", async ({ page }) => {
    // Reviews rendered as cards or table rows
    await expect(page.locator("article, [class*=card], tr").nth(1)).toBeVisible(
      { timeout: 25_000 },
    );
  });

  test("search filter input is present", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i).first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
  });

  test("rating filter is available", async ({ page }) => {
    const ratingFilter = page.getByRole("combobox").first();
    await expect(ratingFilter).toBeVisible({ timeout: 15_000 });
  });

  test("AI analyze button is present", async ({ page }) => {
    const analyzeBtn = page
      .getByRole("button", { name: /analyze|ai|sparkle/i })
      .first();
    await expect(analyzeBtn).toBeVisible({ timeout: 15_000 });
  });
});
