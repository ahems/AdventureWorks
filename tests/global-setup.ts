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

    await page.goto(healthUrl, { waitUntil: "domcontentloaded" });

    // The health check page auto-refreshes every 10 seconds when services are unhealthy
    // We need to wait for all services to become healthy, allowing for multiple refresh cycles
    // Azure services can take 2-3 minutes for cold starts
    console.log(
      "   ⏳ Waiting for all services to become healthy (max 5 minutes)...",
    );
    console.log(
      "   💡 Page will auto-refresh every 10s until services are ready\n",
    );

    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();
    let lastLogTime = startTime;

    // Poll until we get the success badge or timeout
    while (Date.now() - startTime < maxWaitTime) {
      // Wait for either success or failure status to appear
      await page
        .waitForSelector(
          '[data-testid="overall-status-success"], [data-testid="overall-status-failure"]',
          { timeout: 30000 },
        )
        .catch(() => {
          // Ignore timeout - page might be refreshing
        });

      // Log status every 10 seconds
      const now = Date.now();
      if (now - lastLogTime >= 10000) {
        const healthyCount = await page
          .textContent('[data-testid="healthy-count"]')
          .catch(() => "?");
        const unhealthyCount = await page
          .textContent('[data-testid="unhealthy-count"]')
          .catch(() => "?");
        const checkingCount = await page
          .textContent('[data-testid="checking-count"]')
          .catch(() => "?");

        console.log(
          `   Status: ✅ ${healthyCount?.trim()} healthy | ❌ ${unhealthyCount?.trim()} unhealthy | ⏳ ${checkingCount?.trim()} checking`,
        );
        lastLogTime = now;
      }

      // Check if all services are healthy
      const successBadge = page.locator(
        '[data-testid="overall-status-success"]',
      );
      const isSuccess = await successBadge.isVisible().catch(() => false);

      if (isSuccess) {
        // Success! Get final counts
        const healthyCount = await page.textContent(
          '[data-testid="healthy-count"]',
        );
        const unhealthyCount = await page.textContent(
          '[data-testid="unhealthy-count"]',
        );
        const checkingCount = await page.textContent(
          '[data-testid="checking-count"]',
        );

        console.log("\n   Final Status:");
        console.log(`   ✅ Healthy: ${healthyCount?.trim()}`);
        console.log(`   ❌ Unhealthy: ${unhealthyCount?.trim()}`);
        console.log(`   ⏳ Checking: ${checkingCount?.trim()}`);
        console.log(
          `   ⏱️  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`,
        );

        console.log("✅ All services are healthy and warmed up!");
        console.log("🎭 Ready to run Playwright tests\n");
        await browser.close();
        return;
      }

      // Wait a bit before checking again (page auto-refreshes every 10s)
      await page.waitForTimeout(2000);
    }

    // Timeout reached - get final status for error message
    const healthyCount = await page
      .textContent('[data-testid="healthy-count"]')
      .catch(() => "unknown");
    const unhealthyCount = await page
      .textContent('[data-testid="unhealthy-count"]')
      .catch(() => "unknown");

    throw new Error(
      `Health check timeout after 5 minutes. Services still unhealthy: ${unhealthyCount} (${healthyCount} healthy).\n` +
        `Azure services may need more time to cold start. Check ${healthUrl} manually.`,
    );
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
}

export default globalSetup;
