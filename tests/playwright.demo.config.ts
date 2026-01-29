import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { testEnv } from "./utils/env";

export default defineConfig({
  testDir: "./specs",
  testMatch: "**/demo-video.spec.ts",
  globalSetup: require.resolve("./global-setup"),
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "./playwright-report-demo", open: "never" }],
  ],
  outputDir: path.join(__dirname, "test-results-demo"),
  use: {
    baseURL: testEnv.webBaseUrl,
    trace: "on",
    screenshot: "on",
    video: "on", // Always record video for demo
    viewport: { width: 1920, height: 1080 }, // Full HD for better quality
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
