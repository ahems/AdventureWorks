import { defineConfig, devices } from "@playwright/test";
import * as path from "path";
import { testEnv } from "./utils/env";

/**
 * Playwright configuration for the Admin Portal (app-admin).
 *
 * Local run:
 *   npx playwright test --config=tests/playwright.admin.config.ts
 *
 * Azure run (with PLAYWRIGHT_SERVICE_URL):
 *   npx playwright test --config=tests/playwright.admin.config.ts
 *
 * Prerequisites:
 *   - Admin Container App deployed and accessible at APP_ADMIN_REDIRECT_URI (or http://localhost:5174)
 *   - Demo admin user seeded: demo.admin@adventureworks.com / Admin1234!
 */

const isAzureRun = !!process.env.PLAYWRIGHT_SERVICE_URL;

export default defineConfig({
  testDir: path.join(__dirname, "specs/admin"),
  globalSetup: require.resolve("./global-setup-admin"),
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  retries: isAzureRun ? 2 : 0,
  workers: isAzureRun ? 10 : undefined,
  reporter: isAzureRun
    ? [
        [
          "html",
          {
            outputFolder: path.join(__dirname, "playwright-report-admin"),
            open: "never",
          },
        ],
        ["list"],
      ]
    : [
        ["list"],
        ["html", { outputFolder: "./playwright-report-admin", open: "never" }],
        ["json", { outputFile: "./test-results/admin-results.json" }],
      ],
  outputDir: path.join(__dirname, "test-results/admin"),
  use: {
    baseURL: testEnv.adminWebBaseUrl,
    trace: "retain-on-failure" as const,
    screenshot: "only-on-failure" as const,
    video: "retain-on-failure" as const,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: testEnv.adminWebBaseUrl,
      },
    },
  ],
});
