import { test, expect } from "@playwright/test";
import { signupThroughUi } from "../utils/testUser";
import { testEnv } from "../utils/env";
import { execSync } from "child_process";

/**
 * Query Application Insights for custom events
 * Requires Azure CLI to be authenticated (az login)
 */
async function queryApplicationInsights(
  query: string,
  timespan: string = "PT30M",
): Promise<any> {
  try {
    // Get App Insights resource name from azd env
    const appInsightsName = execSync('azd env get-value "SERVICE_APP_NAME"', {
      encoding: "utf8",
    })
      .trim()
      .replace(/^"|"$/g, "");

    const resourceGroup = execSync('azd env get-value "AZURE_RESOURCE_GROUP"', {
      encoding: "utf8",
    })
      .trim()
      .replace(/^"|"$/g, "");

    console.log(
      `\n🔍 Querying Application Insights: ${appInsightsName} in ${resourceGroup}`,
    );
    console.log(`📊 Query: ${query}`);
    console.log(`⏱️  Timespan: ${timespan}\n`);

    const command = `az monitor app-insights query \
      --app "${appInsightsName}" \
      --resource-group "${resourceGroup}" \
      --analytics-query "${query}" \
      --timespan "${timespan}" \
      --output json`;

    const result = execSync(command, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const parsed = JSON.parse(result);
    return parsed;
  } catch (error: any) {
    console.error("❌ Error querying Application Insights:", error.message);
    throw error;
  }
}

/**
 * Wait for telemetry to be ingested by Application Insights
 * App Insights has a delay of typically 1-3 minutes before data is queryable
 */
async function waitForTelemetryIngestion(delayMs: number = 90000) {
  console.log(
    `⏳ Waiting ${delayMs / 1000}s for telemetry ingestion to Application Insights...`,
  );
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

test.describe("Application Insights - End-to-End Telemetry Validation", () => {
  test.setTimeout(180000); // 3 minutes for ingestion delay

  test("browsing activity generates queryable telemetry in Application Insights", async ({
    page,
  }) => {
    const testStartTime = new Date();
    console.log(`\n🕐 Test started at: ${testStartTime.toISOString()}`);

    // Track telemetry requests to verify data is being sent
    const telemetryRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("applicationinsights.azure.com")) {
        telemetryRequests.push(url);
        console.log(`📊 Telemetry request: ${url.split("/").pop()}`);
      }
    });

    // Generate a unique test identifier to track this specific test run
    const testRunId = `test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    console.log(`\n🏷️  Test Run ID: ${testRunId}`);

    // Perform browsing activities
    console.log("\n👤 Creating test user...");
    await signupThroughUi(page);

    console.log("🏠 Navigating to home page...");
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    console.log("📦 Viewing product page...");
    await page.goto(`${testEnv.webBaseUrl}/product/680`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    // Try to add product to cart if available
    const outOfStockMessage = page.getByText(/out of stock/i);
    const isOutOfStock = (await outOfStockMessage.count()) > 0;

    if (!isOutOfStock) {
      console.log("🛒 Adding product to cart...");
      const addToCartButton = page.locator(
        '[data-testid="add-to-cart-button"]',
      );

      try {
        await page.waitForFunction(
          () => {
            const btn = document.querySelector(
              '[data-testid="add-to-cart-button"]',
            );
            return btn && !btn.hasAttribute("disabled");
          },
          { timeout: 5000 },
        );

        await addToCartButton.click();
        await page.waitForTimeout(2000);
        console.log("✅ Product added to cart");
      } catch (error) {
        console.log("⚠️  Could not add to cart");
      }
    }

    // Verify telemetry was sent to Application Insights endpoint
    expect(telemetryRequests.length).toBeGreaterThan(0);
    console.log(
      `\n✅ Verified ${telemetryRequests.length} telemetry requests sent to Application Insights`,
    );

    // Wait for Application Insights to ingest the data
    await waitForTelemetryIngestion(90000); // 90 seconds

    // Query 1: Check for page views
    console.log("\n📊 Query 1: Checking for page view events...");
    const pageViewQuery = `
      pageViews
      | where timestamp >= datetime('${testStartTime.toISOString()}')
      | project timestamp, name, url, duration
      | order by timestamp desc
      | take 50
    `;

    const pageViewResults = await queryApplicationInsights(pageViewQuery);
    const pageViews = pageViewResults?.tables?.[0]?.rows || [];

    console.log(`Found ${pageViews.length} page views since test start`);
    if (pageViews.length > 0) {
      console.log("Sample page views:");
      pageViews.slice(0, 5).forEach((row: any[]) => {
        console.log(`  - ${row[1]} | ${row[2]}`);
      });
    }

    expect(pageViews.length).toBeGreaterThan(0);

    // Query 2: Check for custom events (signup, login, add to cart, etc.)
    console.log("\n📊 Query 2: Checking for custom events...");
    const customEventsQuery = `
      customEvents
      | where timestamp >= datetime('${testStartTime.toISOString()}')
      | project timestamp, name, customDimensions
      | order by timestamp desc
      | take 50
    `;

    const customEventsResults =
      await queryApplicationInsights(customEventsQuery);
    const customEvents = customEventsResults?.tables?.[0]?.rows || [];

    console.log(`Found ${customEvents.length} custom events since test start`);
    if (customEvents.length > 0) {
      console.log("Custom events logged:");
      const eventNames = new Set<string>();
      customEvents.forEach((row: any[]) => {
        eventNames.add(row[1]);
      });
      eventNames.forEach((name) => {
        console.log(`  - ${name}`);
      });
    }

    // We expect at least one custom event (user signup/login)
    expect(customEvents.length).toBeGreaterThan(0);

    // Query 3: Check for browser requests (AJAX calls to backend)
    console.log("\n📊 Query 3: Checking for browser requests...");
    const browserRequestsQuery = `
      requests
      | where timestamp >= datetime('${testStartTime.toISOString()}')
      | project timestamp, name, url, resultCode, duration
      | order by timestamp desc
      | take 50
    `;

    const requestResults = await queryApplicationInsights(browserRequestsQuery);
    const requests = requestResults?.tables?.[0]?.rows || [];

    console.log(`Found ${requests.length} requests since test start`);
    if (requests.length > 0) {
      console.log("Sample requests:");
      requests.slice(0, 5).forEach((row: any[]) => {
        console.log(`  - ${row[1]} | Status: ${row[3]} | ${row[4]}ms`);
      });
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 TELEMETRY VALIDATION SUMMARY");
    console.log("=".repeat(60));
    console.log(`✅ Telemetry requests sent: ${telemetryRequests.length}`);
    console.log(`✅ Page views logged: ${pageViews.length}`);
    console.log(`✅ Custom events logged: ${customEvents.length}`);
    console.log(`✅ Backend requests logged: ${requests.length}`);
    console.log("=".repeat(60) + "\n");

    // Overall assertion - we should have data in Application Insights
    const totalEventsLogged =
      pageViews.length + customEvents.length + requests.length;
    expect(
      totalEventsLogged,
      "Application Insights should have captured telemetry data",
    ).toBeGreaterThan(0);
  });

  test("specific user events are captured with correct properties", async ({
    page,
  }) => {
    const testStartTime = new Date();

    // Create test user
    console.log("\n👤 Creating test user for event validation...");
    await signupThroughUi(page);

    // Capture user info for validation
    const userContext = await page.evaluate(() => {
      return localStorage.getItem("adventureworks_current_user");
    });

    if (!userContext) {
      console.log("⚠️  No user context found, skipping user-specific checks");
      return;
    }

    const user = JSON.parse(userContext);
    console.log(`📧 Test user email: ${user.EmailAddress}`);

    await page.waitForTimeout(3000);

    // Wait for ingestion
    await waitForTelemetryIngestion(90000);

    // Query for user signup event
    console.log("\n📊 Querying for User_Signup event...");
    const signupEventQuery = `
      customEvents
      | where timestamp >= datetime('${testStartTime.toISOString()}')
      | where name == "User_Signup"
      | project timestamp, name, customDimensions
      | order by timestamp desc
    `;

    const signupResults = await queryApplicationInsights(signupEventQuery);
    const signupEvents = signupResults?.tables?.[0]?.rows || [];

    console.log(`Found ${signupEvents.length} User_Signup events`);

    if (signupEvents.length > 0) {
      const recentSignup = signupEvents[0];
      console.log("✅ User_Signup event captured:");
      console.log(`   Timestamp: ${recentSignup[0]}`);
      console.log(`   Event Name: ${recentSignup[1]}`);
      console.log(`   Properties: ${JSON.stringify(recentSignup[2])}`);
    }

    expect(signupEvents.length).toBeGreaterThan(0);
  });

  test("product view events contain product metadata", async ({ page }) => {
    const testStartTime = new Date();
    const productId = "680";

    // View a specific product
    console.log(`\n📦 Viewing product ${productId}...`);
    await page.goto(`${testEnv.webBaseUrl}/product/${productId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Wait for ingestion
    await waitForTelemetryIngestion(90000);

    // Query for Product_View event
    console.log("\n📊 Querying for Product_View event...");
    const productViewQuery = `
      customEvents
      | where timestamp >= datetime('${testStartTime.toISOString()}')
      | where name == "Product_View"
      | project timestamp, name, customDimensions
      | order by timestamp desc
      | take 10
    `;

    const productViewResults = await queryApplicationInsights(productViewQuery);
    const productViews = productViewResults?.tables?.[0]?.rows || [];

    console.log(`Found ${productViews.length} Product_View events`);

    if (productViews.length > 0) {
      const recentView = productViews[0];
      console.log("✅ Product_View event captured:");
      console.log(`   Timestamp: ${recentView[0]}`);
      console.log(`   Properties: ${JSON.stringify(recentView[2])}`);

      // Verify the event has expected properties
      const dimensions = recentView[2];
      if (typeof dimensions === "object" && dimensions !== null) {
        expect(dimensions).toHaveProperty("productId");
        expect(dimensions).toHaveProperty("productName");
        console.log(
          `   ✅ Event includes product metadata (ID: ${dimensions.productId})`,
        );
      }
    }

    expect(productViews.length).toBeGreaterThan(0);
  });
});

test.describe("Application Insights - Performance Metrics", () => {
  test.setTimeout(180000);

  test("page load performance is tracked", async ({ page }) => {
    const testStartTime = new Date();

    console.log("\n⚡ Testing performance tracking...");
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("load");
    await page.waitForTimeout(3000);

    // Wait for ingestion
    await waitForTelemetryIngestion(90000);

    // Query for performance metrics
    console.log("\n📊 Querying for performance data...");
    const performanceQuery = `
      pageViews
      | where timestamp >= datetime('${testStartTime.toISOString()}')
      | project timestamp, name, duration, url, performanceBucket
      | order by timestamp desc
      | take 20
    `;

    const perfResults = await queryApplicationInsights(performanceQuery);
    const perfData = perfResults?.tables?.[0]?.rows || [];

    console.log(`Found ${perfData.length} page views with performance data`);

    if (perfData.length > 0) {
      console.log("Performance metrics:");
      perfData.slice(0, 5).forEach((row: any[]) => {
        console.log(`  - ${row[1]} | Duration: ${row[2]}ms`);
      });
    }

    expect(perfData.length).toBeGreaterThan(0);
  });
});
