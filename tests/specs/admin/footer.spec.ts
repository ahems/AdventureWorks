import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Footer System Status", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    // Footer is present on the dashboard (default page after login)
  });

  test("system status pill is visible with Systems: text", async ({ page }) => {
    await expect(page.locator("text=Systems:").first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("status pill reflects a known health state", async ({ page }) => {
    const pill = page
      .locator('[class*="cursor-pointer"]')
      .filter({ hasText: /Systems:/ })
      .first();
    await expect(pill).toBeVisible({ timeout: 20_000 });
    await expect(pill).toContainText(/Operational|Degraded|Down/i);
  });

  test("hovering status pill reveals service breakdown tooltip", async ({
    page,
  }) => {
    const pill = page
      .locator('[class*="cursor-pointer"]')
      .filter({ hasText: /Systems:/ })
      .first();
    await pill.waitFor({ state: "visible", timeout: 20_000 });
    await pill.hover();
    // Radix UI tooltip content portals to document.body – wait for it
    await expect(page.getByText("Database").first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText("API Server").first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText("Services").last()).toBeVisible({
      timeout: 5_000,
    });
  });
});
