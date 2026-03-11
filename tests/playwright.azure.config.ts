import { defineConfig, devices } from "@playwright/test";
import { createAzurePlaywrightConfig, ServiceOS } from "@azure/playwright";
import { DefaultAzureCredential } from "@azure/identity";
import * as path from "path";
import { testEnv } from "./utils/env";

/**
 * Playwright Workspaces (Azure LoadTest Service) configuration
 *
 * This config enables running tests on Playwright Workspaces for:
 * - Cloud-based parallel execution at scale
 * - Cross-browser testing across multiple OS versions
 * - Managed browser infrastructure
 *
 * To use Playwright Workspaces:
 * 1. Set PLAYWRIGHT_SERVICE_URL environment variable (from azd env)
 * 2. Authenticate via Azure CLI: az login --tenant <tenant-id>
 * 3. Run tests: npx playwright test --config=playwright.azure.config.ts
 *
 * To run tests locally (default):
 * - npx playwright test (uses playwright.config.ts)
 */

const isAzureRun = !!process.env.PLAYWRIGHT_SERVICE_URL;

// Base configuration shared between local and Azure runs
const baseConfig = defineConfig({
  testDir: "./specs",
  globalSetup: require.resolve("./global-setup"),
  timeout: 90_000, // Long flows (sale+cart+language, checkout) need headroom on Azure workers
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  retries: isAzureRun ? 2 : 0,
  workers: isAzureRun ? 20 : undefined,
  reporter: isAzureRun
    ? [
        [
          "html",
          {
            outputFolder: path.join(__dirname, "playwright-report"),
            open: "never",
          },
        ], // HTML reporter must come first
        ["@azure/playwright/reporter"], // Azure reporter uploads HTML report to storage
        ["list"],
      ]
    : [
        ["list"],
        ["html", { outputFolder: "./playwright-report", open: "never" }],
        ["json", { outputFile: "./test-results/results.json" }],
      ],
  outputDir: path.join(__dirname, "test-results"),
  use: {
    baseURL: testEnv.webBaseUrl,
    trace: "retain-on-failure" as const,
    screenshot: "only-on-failure" as const,
    video: "retain-on-failure" as const,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: testEnv.webBaseUrl,
      },
    },
  ],
});

// Export Azure-enhanced config if PLAYWRIGHT_SERVICE_URL is set
// Learn more about service configuration at https://aka.ms/pww/docs/config
export default isAzureRun
  ? defineConfig(
      baseConfig,
      createAzurePlaywrightConfig(baseConfig, {
        exposeNetwork: "<loopback>", // Expose localhost to cloud browsers for API calls
        connectTimeout: 3 * 60 * 1000, // 3 minutes
        os: ServiceOS.LINUX,
        credential: new DefaultAzureCredential(),
      }),
    )
  : baseConfig;
