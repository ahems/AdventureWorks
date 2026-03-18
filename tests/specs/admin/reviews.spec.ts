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

  test("AI analyze button is present and disabled until reviews selected", async ({
    page,
  }) => {
    // Wait for review cards to load
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });
    const analyzeBtn = page.getByRole("button", { name: /run ai analysis/i });
    await expect(analyzeBtn).toBeVisible({ timeout: 15_000 });
    // Button must be disabled when nothing is selected
    await expect(analyzeBtn).toBeDisabled();
    // Select one review (nth(0) is the "select all" checkbox; individual cards start at nth(1))
    await page.getByRole("checkbox").nth(1).click();
    await expect(analyzeBtn).toBeEnabled();
  });

  test("clicking Run AI Analysis starts the analysis process", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // Wait for review cards to load and select 3 reviews before analyzing
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });
    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(1).click();
    await checkboxes.nth(2).click();
    await checkboxes.nth(3).click();
    const analyzeBtn = page.getByRole("button", {
      name: /run ai analysis \(3\)/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 5_000 });
    await analyzeBtn.click();
    // Button transitions: "Run AI Analysis" → "Analyzing..." → "Re-analyze"
    // Accept either in-progress or completed state (API may be fast on warm instances)
    await expect(
      page.getByRole("button", { name: /analyzing|re-analyze/i }),
    ).toBeVisible({ timeout: 200_000 });
  });

  test("AI analysis completes and Re-analyze button appears", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // Wait for review cards to load and select 3 reviews before analyzing
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });
    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(1).click();
    await checkboxes.nth(2).click();
    await checkboxes.nth(3).click();
    const analyzeBtn = page.getByRole("button", {
      name: /run ai analysis \(3\)/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 5_000 });
    await analyzeBtn.click();
    // After analysis completes the button label changes to "Re-analyze (3)"
    // Batch AI analysis can take up to ~3 minutes on a cold Azure Functions instance
    await expect(page.getByRole("button", { name: /re-analyze/i })).toBeVisible(
      { timeout: 200_000 },
    );
  });

  test("View AI Summary dialog shows Powered by Azure AI after analysis", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // Wait for review cards to load and select 3 reviews before analyzing
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });
    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(1).click();
    await checkboxes.nth(2).click();
    await checkboxes.nth(3).click();
    const analyzeBtn = page.getByRole("button", {
      name: /run ai analysis \(3\)/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 5_000 });
    await analyzeBtn.click();
    // Wait for analysis to finish (batch AI can take ~3 minutes on cold start)
    await expect(page.getByRole("button", { name: /re-analyze/i })).toBeVisible(
      { timeout: 200_000 },
    );
    // "View AI Summary" button appears after analysis
    const viewSummaryBtn = page.getByRole("button", {
      name: /view ai summary/i,
    });
    await expect(viewSummaryBtn).toBeVisible({ timeout: 10_000 });
    await viewSummaryBtn.click();
    // Dialog content should contain the Azure AI attribution
    await expect(page.getByText("Powered by Azure AI")).toBeVisible({
      timeout: 10_000,
    });
  });
});
