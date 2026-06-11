import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import {
  ADMIN_TEST_EMAIL,
  ADMIN_TEST_PASSWORD,
  loginAsAdmin,
} from "../../utils/adminTestUser";

test.describe("Admin Portal – Authentication", () => {
  test("login page renders with credential hint buttons", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/login`);
    await expect(
      page.getByRole("heading", { name: /sign in|login/i }),
    ).toBeVisible();
    // Demo credential hint should be visible
    await expect(
      page.getByText(/demo\.admin@adventureworks\.com/i),
    ).toBeVisible();
  });

  test("invalid credentials show an error message", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/login`);
    await page.getByLabel(/email/i).fill("wrong@example.com");
    await page.getByLabel(/password/i).fill("wrongpassword");
    await page.getByRole("button", { name: /sign in|login/i }).click();
    await expect(
      page.getByText(/invalid|incorrect|not found/i).first(),
    ).toBeVisible({
      timeout: 15_000,
    });
  });

  test("valid credentials redirect to dashboard", async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  });

  test("unauthenticated users are redirected to login", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/customers`);
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test("logout clears session and returns to login", async ({ page }) => {
    await loginAsAdmin(page);
    // Find and click logout button/link
    const logoutBtn = page.getByRole("button", { name: /logout|sign out/i });
    await logoutBtn.click();
    await expect(page).toHaveURL(/\/login|\/$/, { timeout: 10_000 });
    // Navigating to a protected route should redirect to login
    await page.goto(`${testEnv.adminWebBaseUrl}/orders`);
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
