import { Page, expect } from "@playwright/test";
import { testEnv } from "./env";

export const ADMIN_TEST_EMAIL =
  process.env.ADMIN_TEST_EMAIL || "demo.admin@adventureworks.com";
export const ADMIN_TEST_PASSWORD =
  process.env.ADMIN_TEST_PASSWORD || "Admin1234!";

/**
 * Navigate to the admin login page and sign in with the seeded demo credentials.
 * Waits for the dashboard to appear before returning.
 */
export const loginAsAdmin = async (page: Page): Promise<void> => {
  await page.goto(`${testEnv.adminWebBaseUrl}/login`);

  // Fill credentials
  await page.getByLabel(/email/i).fill(ADMIN_TEST_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in|login/i }).click();

  // Wait for redirect to dashboard
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  // Confirm dashboard KPI cards rendered
  await expect(
    page.getByText(/total products|customers|orders/i).first(),
  ).toBeVisible({ timeout: 15_000 });
};
