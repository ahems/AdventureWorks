import { chromium, FullConfig } from "@playwright/test";
import { testEnv } from "./utils/env";

/**
 * Global setup for Playwright tests
 * Runs the health check page to warm up all services before any tests execute
 * If the health check fails, all tests will be skipped
 */
async function globalSetup(config: FullConfig) {
  console.log("🏥 Running global health check to warm up services...\n");

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const healthUrl = `${testEnv.webBaseUrl}/health`;
    console.log(`   Navigating to: ${healthUrl}`);

    await page.goto(healthUrl);

    // Wait for health checks to complete (max 90 seconds for cold starts)
    console.log("   ⏳ Waiting for health checks to complete (max 90s)...");
    await page.waitForSelector(
      '[data-testid="overall-status-success"], [data-testid="overall-status-failure"]',
      { timeout: 90000 },
    );

    // Give it a moment to finish updating
    await page.waitForTimeout(2000);

    // Check progress reached 100%
    const progress = await page.getAttribute(
      '[data-testid="health-check-progress"]',
      "aria-valuenow",
    );

    // Get the status counts
    const healthyCount = await page.textContent(
      '[data-testid="healthy-count"]',
    );
    const unhealthyCount = await page.textContent(
      '[data-testid="unhealthy-count"]',
    );
    const checkingCount = await page.textContent(
      '[data-testid="checking-count"]',
    );

    console.log(`   Progress: ${progress}%`);
    console.log(`   ✅ Healthy: ${healthyCount?.trim()}`);
    console.log(`   ❌ Unhealthy: ${unhealthyCount?.trim()}`);
    console.log(`   ⏳ Checking: ${checkingCount?.trim()}\n`);

    // Verify all checks completed
    if (checkingCount?.trim() !== "0") {
      throw new Error(
        `Health checks did not complete. ${checkingCount} still in progress.`,
      );
    }

    // Check if we have the success badge
    const successBadge = page.locator('[data-testid="overall-status-success"]');
    const isSuccess = await successBadge.isVisible();

    if (!isSuccess) {
      // Get details about failures
      const failureDetails = await page
        .locator('[data-testid="service-checks"] .text-red-500')
        .allTextContents();
      throw new Error(
        `Health check failed. Unhealthy services: ${unhealthyCount}\nDetails: ${failureDetails.join(", ")}`,
      );
    }

    console.log("✅ All services are healthy and warmed up!");
    console.log("🎭 Ready to run Playwright tests\n");
  } catch (error) {
    console.error("\n❌ Global health check failed:");
    console.error(
      `   ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      "\n⚠️  All tests will be skipped. Please check Azure resources.\n",
    );
    await browser.close();
    throw error; // This will prevent tests from running
  }

  await browser.close();
}

export default globalSetup;
