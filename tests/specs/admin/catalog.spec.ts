import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Cultures & Currencies", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test.describe("Cultures page", () => {
    test("loads and shows culture entries from DB", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/cultures`);
      // 'en' culture is always in AdventureWorks
      await expect(page.getByText(/\ben\b/i).first()).toBeVisible({
        timeout: 20_000,
      });
    });

    test("search input filters cultures", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/cultures`);
      const searchInput = page.getByPlaceholder(/search/i).first();
      await expect(searchInput).toBeVisible({ timeout: 15_000 });
      await searchInput.fill("en");
      await page.waitForTimeout(400);
      await expect(page.getByText(/english/i).first()).toBeVisible({
        timeout: 10_000,
      });
    });

    test("create culture button is visible", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/cultures`);
      const addBtn = page
        .getByRole("button", { name: /add culture|new culture|create/i })
        .first();
      await expect(addBtn).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe("Currencies page", () => {
    test("loads and shows currency entries from DB", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/currencies`);
      // USD is always present in AdventureWorks
      await expect(page.getByText(/USD|US dollar/i).first()).toBeVisible({
        timeout: 20_000,
      });
    });

    test("currency rates tab shows exchange rates", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/currencies`);
      const ratesTab = page.getByRole("tab", { name: /rate|exchange/i });
      if (await ratesTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await ratesTab.click();
        await expect(
          page.getByText(/average rate|end of day/i).first(),
        ).toBeVisible({
          timeout: 10_000,
        });
      }
    });

    test("stale carts page loads", async ({ page }) => {
      await page.goto(`${testEnv.adminWebBaseUrl}/stale-carts`);
      await expect(page.getByText(/cart|abandoned|stale/i).first()).toBeVisible(
        {
          timeout: 20_000,
        },
      );
    });
  });
});
