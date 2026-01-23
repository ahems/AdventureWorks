import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { testEnv } from "./utils/env";

export default defineConfig({
  testDir: "./specs",
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "./playwright-report", open: "never" }],
  ],
  outputDir: path.join(__dirname, "test-results"),
  use: {
    baseURL: testEnv.webBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
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
