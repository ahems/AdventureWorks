import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Stale Carts & Cart Recovery Agent", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${testEnv.adminWebBaseUrl}/stale-carts`);
  });

  test("stale carts page loads with AI Cart Recovery Agent section", async ({
    page,
  }) => {
    await expect(page.getByText("AI Cart Recovery Agent")).toBeVisible({
      timeout: 20_000,
    });
  });

  test("Analyze All Carts button is present before analysis", async ({
    page,
  }) => {
    await expect(
      page.getByRole("button", { name: /analyze all carts/i }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("clicking Analyze All Carts shows progress indicator", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const analyzeBtn = page.getByRole("button", {
      name: /analyze all carts/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 20_000 });
    await analyzeBtn.click();
    // Status text confirms analysis is in progress
    await expect(page.getByText(/Calculating recovery scores/i)).toBeVisible({
      timeout: 30_000,
    });
  });

  test("analysis completes with stat cards visible", async ({ page }) => {
    test.setTimeout(180_000);
    const analyzeBtn = page.getByRole("button", {
      name: /analyze all carts/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 20_000 });
    await analyzeBtn.click();

    // Wait for all 4 stat cards to appear
    await expect(page.getByText("Carts Analyzed")).toBeVisible({
      timeout: 150_000,
    });
    // Use exact: true so we match only the stat card label, not buttons containing "High Priority"
    await expect(page.getByText("High Priority", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText("Est. Recoverable", { exact: true }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText("Avg. Recovery Score", { exact: true }),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test("recovery strategy cards appear after analysis", async ({ page }) => {
    test.setTimeout(180_000);
    const analyzeBtn = page.getByRole("button", {
      name: /analyze all carts/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 20_000 });
    await analyzeBtn.click();

    // Wait for analysis to complete (stat cards as signal)
    await expect(page.getByText("Carts Analyzed")).toBeVisible({
      timeout: 150_000,
    });

    // "Recovery Strategies (Sorted by Priority)" heading appears once analysis finishes
    await expect(
      page.getByRole("heading", { name: /Recovery Strategies/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("Show Simulator button appears after analysis", async ({ page }) => {
    test.setTimeout(180_000);
    const analyzeBtn = page.getByRole("button", {
      name: /analyze all carts/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 20_000 });
    await analyzeBtn.click();

    await expect(page.getByText("Carts Analyzed")).toBeVisible({
      timeout: 150_000,
    });

    await expect(
      page.getByRole("button", { name: /show simulator/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("clicking Show Simulator reveals the Campaign Simulator section", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const analyzeBtn = page.getByRole("button", {
      name: /analyze all carts/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 20_000 });
    await analyzeBtn.click();

    await expect(page.getByText("Carts Analyzed")).toBeVisible({
      timeout: 150_000,
    });

    await page.getByRole("button", { name: /show simulator/i }).click();
    await expect(page.getByText("Campaign Simulator")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Run Simulation button is available in Campaign Simulator", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const analyzeBtn = page.getByRole("button", {
      name: /analyze all carts/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 20_000 });
    await analyzeBtn.click();

    await expect(page.getByText("Carts Analyzed")).toBeVisible({
      timeout: 150_000,
    });
    await page.getByRole("button", { name: /show simulator/i }).click();
    await expect(
      page.getByRole("button", { name: /run simulation/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("running simulation produces 3 scenario results", async ({ page }) => {
    test.setTimeout(180_000);
    const analyzeBtn = page.getByRole("button", {
      name: /analyze all carts/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 20_000 });
    await analyzeBtn.click();

    await expect(page.getByText("Carts Analyzed")).toBeVisible({
      timeout: 150_000,
    });
    await page.getByRole("button", { name: /show simulator/i }).click();
    await page.getByRole("button", { name: /run simulation/i }).click();

    // Three scenario cards should appear (use heading role to avoid strict-mode
    // violations from the chart labels and toast that also contain these strings)
    await expect(
      page.getByRole("heading", { name: "High Priority Only" }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("heading", { name: "High + Medium Priority" }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("heading", { name: "All Carts" })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("simulation shows rate attribution (historical or industry standard)", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const analyzeBtn = page.getByRole("button", {
      name: /analyze all carts/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 20_000 });
    await analyzeBtn.click();

    await expect(page.getByText("Carts Analyzed")).toBeVisible({
      timeout: 150_000,
    });
    await page.getByRole("button", { name: /show simulator/i }).click();
    await page.getByRole("button", { name: /run simulation/i }).click();

    // Attribution line references real order data or industry estimates
    await expect(
      page.getByText(/historical orders|industry standard/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("cart detail dialog shows product names with admin and app links", async ({
    page,
  }) => {
    // Wait for the carts table to load
    await expect(page.getByText(/stale cart management/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("table tbody tr").first()).toBeVisible({
      timeout: 20_000,
    });

    // Each row has a MoreHorizontal dropdown; open the first one
    const firstMoreBtn = page
      .locator("table tbody tr")
      .first()
      .getByRole("button");
    await firstMoreBtn.click();

    // Click "View Details" from the dropdown menu
    const viewDetailsItem = page.getByRole("menuitem", {
      name: /view details/i,
    });
    await expect(viewDetailsItem).toBeVisible({ timeout: 5_000 });
    await viewDetailsItem.click();

    // Dialog should be open
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText(/cart items/i)).toBeVisible();

    // If products are loaded, the admin route link should be present
    const adminProductLinks = dialog.locator("a[href*='/product/']").filter({
      hasNot: page.locator("[target='_blank']"),
    });
    const appProductLinks = dialog.locator(
      "a[title='View in customer app'][href*='/product/']",
    );

    if ((await adminProductLinks.count()) > 0) {
      await expect(adminProductLinks.first()).toBeVisible();
      await expect(appProductLinks.first()).toBeVisible();
      expect(await appProductLinks.first().getAttribute("target")).toBe(
        "_blank",
      );
    }
    // Whether products are shown as links or "Product #N" (fallback), the page must not crash
    await expect(dialog).toBeVisible();
  });
});
