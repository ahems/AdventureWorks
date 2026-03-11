import { test, expect } from "@playwright/test";

test.describe("Health Check Page", () => {
  test("should load and show all services as healthy", async ({ page }) => {
    // Navigate to the health check page
    await page.goto("/health");

    // Wait for health checks to complete (max 90 seconds for cold starts + processing)
    await page.waitForSelector(
      '[data-testid="overall-status-success"], [data-testid="overall-status-failure"]',
      {
        timeout: 90000,
      },
    );

    // Wait a bit more to ensure progress bar completes
    await page.waitForTimeout(2000);

    // Check that progress bar reached 100%
    const progress = await page.getAttribute(
      '[data-testid="health-check-progress"]',
      "aria-valuenow",
    );
    expect(progress).toBe("100");

    // Verify no checks are still in progress
    const checkingCount = await page.textContent(
      '[data-testid="checking-count"]',
    );
    expect(checkingCount?.trim()).toBe("0");

    // Get the counts
    const healthyCount = await page.textContent(
      '[data-testid="healthy-count"]',
    );
    const unhealthyCount = await page.textContent(
      '[data-testid="unhealthy-count"]',
    );

    console.log(`Healthy: ${healthyCount}, Unhealthy: ${unhealthyCount}`);

    // Check overall status - should be success
    const overallStatus = await page.locator(
      '[data-testid="overall-status-success"]',
    );
    await expect(overallStatus).toBeVisible();
    await expect(overallStatus).toHaveText("All Systems Operational");

    // Verify all checks are healthy (9 total: 1 DAB + 1 MCP + 1 AI Generated Images + 1 Seed Job + 5 Functions)
    expect(healthyCount?.trim()).toBe("9");
    expect(unhealthyCount?.trim()).toBe("0");
  });

  test("should show individual service statuses", async ({ page }) => {
    await page.goto("/health");

    // Wait for checks to complete
    await page.waitForSelector(
      '[data-testid="overall-status-success"], [data-testid="overall-status-failure"]',
      {
        timeout: 90000,
      },
    );

    // Verify service checks container is present
    const serviceChecks = page.locator('[data-testid="service-checks"]');
    await expect(serviceChecks).toBeVisible();

    // Check for specific services
    const graphqlCheck = page.locator('[data-testid="check-graphql-api-dab"]');
    await expect(graphqlCheck).toBeVisible();

    const mcpCheck = page.locator('[data-testid="check-mcp-api"]');
    await expect(mcpCheck).toBeVisible();

    const healthCheck = page.locator(
      '[data-testid="check-function-health-check"]',
    );
    await expect(healthCheck).toBeVisible();

    const seedJobCheck = page.locator('[data-testid="check-seed-job"]');
    await expect(seedJobCheck).toBeVisible();
  });

  test("should handle failures gracefully", async ({ page }) => {
    await page.goto("/health");

    // Wait for checks to complete
    await page.waitForSelector(
      '[data-testid="overall-status-success"], [data-testid="overall-status-failure"]',
      {
        timeout: 90000,
      },
    );

    // Check if there are any failures
    const unhealthyCount = await page.textContent(
      '[data-testid="unhealthy-count"]',
    );
    const hasFailures = parseInt(unhealthyCount?.trim() || "0") > 0;

    if (hasFailures) {
      // If there are failures, verify the failure status is shown
      const failureStatus = page.locator(
        '[data-testid="overall-status-failure"]',
      );
      await expect(failureStatus).toBeVisible();
      await expect(failureStatus).toHaveText("Issues Detected");
    }
  });

  test("should complete all checks within timeout", async ({ page }) => {
    const startTime = Date.now();

    await page.goto("/health");

    // Wait for completion
    await page.waitForSelector(
      '[data-testid="overall-status-success"], [data-testid="overall-status-failure"]',
      {
        timeout: 90000,
      },
    );

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    console.log(`Health checks completed in ${duration.toFixed(1)} seconds`);

    // Verify it completed within reasonable time (90 seconds including cold starts)
    expect(duration).toBeLessThan(90);

    // Verify progress reached 100%
    const progress = await page.getAttribute(
      '[data-testid="health-check-progress"]',
      "aria-valuenow",
    );
    expect(progress).toBe("100");
  });
});
