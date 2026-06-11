import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Utilities & AI Features", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test.describe("Utilities page", () => {
    test("renders with function cards", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/utilities`);
      await expect(page.getByText(/utilities|utility/i).first()).toBeVisible({
        timeout: 20_000,
      });
      // At least one utility card should be visible
      await expect(page.locator("article, [class*=card]").first()).toBeVisible({
        timeout: 15_000,
      });
    });

    test("embellish products card is present", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/utilities`);
      // Embellish card is in the Product AI Enhancement tab
      await page
        .getByRole("button", { name: /product ai enhancement/i })
        .click();
      await expect(page.getByText(/embellish/i).first()).toBeVisible({
        timeout: 15_000,
      });
    });
  });

  test.describe("AI Features page", () => {
    test("AI features page renders feature cards", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/ai-features`);
      await expect(
        page.getByText(/ai|features|capabilities/i).first(),
      ).toBeVisible({
        timeout: 20_000,
      });
    });

    test("AI chat assistant is accessible", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/`);
      // AI Agent chat is on the dashboard
      await expect(page.getByText(/ai data assistant/i)).toBeVisible({
        timeout: 15_000,
      });
    });
  });

  test.describe("Search page", () => {
    test("search page renders with query from URL param", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/search?q=bike`);
      // Verify the search input is pre-populated from the URL query param
      await expect(page.getByRole("textbox").first()).toHaveValue("bike", {
        timeout: 20_000,
      });
    });

    test("search returns results for known product", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/search?q=road`);
      // Real DB has Road Bikes category
      await expect(page.getByText(/road/i).first()).toBeVisible({
        timeout: 20_000,
      });
    });
  });
});
