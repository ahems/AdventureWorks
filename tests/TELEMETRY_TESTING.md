# Application Insights Telemetry Testing with Playwright

This document explains how to use Playwright to verify that Application Insights is receiving and storing telemetry from browsing activity.

## Overview

We have two approaches to validate Application Insights telemetry:

### 1. **Network Interception** (Fast, Real-time)

- **File**: `specs/telemetry.spec.ts`
- **Method**: Intercepts HTTP requests to Application Insights endpoints
- **Validates**: Telemetry is being **sent** from the browser
- **Runtime**: ~30 seconds
- **Pros**: Fast, no waiting for ingestion
- **Cons**: Only verifies data transmission, not storage

### 2. **Direct Query** (Comprehensive, Delayed)

- **File**: `specs/telemetry-validation.spec.ts`
- **Method**: Queries Application Insights API after browsing activity
- **Validates**: Telemetry is **stored and queryable** in Application Insights
- **Runtime**: ~3-4 minutes (includes 90s ingestion delay)
- **Pros**: Verifies complete end-to-end flow
- **Cons**: Slower due to Application Insights ingestion latency

## Prerequisites

### Authentication

Tests must be able to authenticate with Azure to query Application Insights:

```bash
# Login to Azure
az login

# Verify you can access the Application Insights resource
azd env get-values | grep APPINSIGHTS
```

### Environment Setup

The tests automatically read from `azd env` to get:

- `AZURE_RESOURCE_GROUP` - Resource group containing App Insights
- `SERVICE_APP_NAME` - Application Insights resource name
- `APP_REDIRECT_URI` - Web application URL
- `VITE_API_FUNCTIONS_URL` - Functions API URL

## Running the Tests

### Quick Network Validation (30 seconds)

```bash
cd tests
npx playwright test telemetry.spec.ts
```

This test:

- ✅ Verifies Application Insights SDK is initialized
- ✅ Intercepts telemetry requests to Azure endpoint
- ✅ Validates events are being transmitted
- ✅ Tests user signup, page views, and cart events

### Full End-to-End Validation (3-4 minutes)

```bash
cd tests
npx playwright test telemetry-validation.spec.ts
```

This test:

- ✅ Performs browsing activities (signup, page views, add to cart)
- ⏳ Waits 90 seconds for Application Insights ingestion
- 🔍 Queries Application Insights for the data
- ✅ Validates page views are stored
- ✅ Validates custom events are stored
- ✅ Validates backend requests are logged
- ✅ Verifies event properties and metadata

### Run Both Together

```bash
cd tests
npx playwright test telemetry
```

## What Gets Validated

### Network Interception Test

1. **Initialization Check**
   - Verifies `App Insights] Initialized successfully` console log
   - Confirms SDK loaded correctly

2. **Request Interception**
   - Monitors all requests to `*.applicationinsights.azure.com`
   - Counts telemetry batches sent

3. **Event Generation**
   - User signup/login events
   - Page view tracking
   - Add-to-cart events
   - Page navigation events

### Direct Query Test

1. **Page Views**

   ```kusto
   pageViews
   | where timestamp >= datetime('...')
   | project timestamp, name, url, duration
   ```

   - Verifies every page navigation is logged
   - Validates page load performance data

2. **Custom Events**

   ```kusto
   customEvents
   | where timestamp >= datetime('...')
   | where name in ("User_Signup", "Product_View", "Product_AddToCart", "Purchase_Complete")
   ```

   - Validates business-specific events
   - Checks event properties (productId, userId, etc.)

3. **Backend Requests**

   ```kusto
   requests
   | where timestamp >= datetime('...')
   | project name, url, resultCode, duration
   ```

   - Logs API calls to GraphQL and Functions
   - Validates request success/failure rates

4. **Performance Metrics**
   - Page load durations
   - Performance buckets
   - Browser timing data

## Understanding Application Insights Ingestion Delay

**Important**: Application Insights has a typical ingestion latency of **1-3 minutes**.

This means:

- ✅ Data is sent immediately from the browser
- ⏳ Data takes 1-3 minutes to appear in queries
- 🔍 The `telemetry-validation.spec.ts` waits 90 seconds by default

You can adjust the wait time in the test:

```typescript
// Wait for Application Insights to ingest the data
await waitForTelemetryIngestion(90000); // 90 seconds

// For slower ingestion, increase the delay:
await waitForTelemetryIngestion(120000); // 2 minutes
```

## Example Output

### Network Interception Test

```
📊 Telemetry request detected: v2/track
📊 Telemetry request detected: v2/track
✅ Added product to cart - telemetry should be sent
✅ Telemetry verification complete: 5 requests detected

📊 Telemetry Events Tracked:
- Application Insights initialization
- User signup/login
- Page views (home, product pages)
- Add to cart events
```

### Direct Query Test

```
🔍 Querying Application Insights: av-swa-ewphuc52etkbc in rg-adventureworks
📊 Query: pageViews | where timestamp >= datetime('...')
⏱️  Timespan: PT30M

Found 15 page views since test start
Sample page views:
  - Home | https://adventureworks.com/
  - Product | https://adventureworks.com/product/680
  - Cart | https://adventureworks.com/cart

Found 8 custom events since test start
Custom events logged:
  - User_Signup
  - User_Login
  - Product_View
  - Product_AddToCart

============================================================
📊 TELEMETRY VALIDATION SUMMARY
============================================================
✅ Telemetry requests sent: 12
✅ Page views logged: 15
✅ Custom events logged: 8
✅ Backend requests logged: 23
============================================================
```

## Troubleshooting

### "Error querying Application Insights"

**Cause**: Authentication or permission issue

**Solution**:

```bash
# Re-authenticate
az login

# Verify you have Reader role on the resource group
az role assignment list --assignee $(az ad signed-in-user show --query id -o tsv) \
  --scope "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$(azd env get-value AZURE_RESOURCE_GROUP)"
```

### "No telemetry requests detected"

**Cause**: Application Insights not properly configured

**Solution**:

1. Check connection string exists:

   ```bash
   azd env get-values | grep APPINSIGHTS_CONNECTIONSTRING
   ```

2. Verify it's injected into the frontend:

   ```bash
   curl "$(azd env get-value APP_REDIRECT_URI)/config.js"
   ```

3. Check browser console for initialization errors

### "Found 0 custom events"

**Cause**: Events not yet ingested or test ran too quickly

**Solution**:

1. Increase the ingestion wait time to 2 minutes:

   ```typescript
   await waitForTelemetryIngestion(120000);
   ```

2. Run the test again (data from previous run will still be there)

3. Manually query Application Insights:
   ```bash
   az monitor app-insights query \
     --app "$(azd env get-value SERVICE_APP_NAME)" \
     --resource-group "$(azd env get-value AZURE_RESOURCE_GROUP)" \
     --analytics-query "customEvents | where timestamp > ago(1h) | summarize count() by name"
   ```

## Customizing the Tests

### Test Different User Journeys

```typescript
test("checkout flow telemetry", async ({ page }) => {
  const testStartTime = new Date();

  await signupThroughUi(page);
  await page.goto(`${testEnv.webBaseUrl}/product/680`);
  // Add to cart
  await page.click('[data-testid="add-to-cart-button"]');
  // Go to checkout
  await page.goto(`${testEnv.webBaseUrl}/checkout`);

  await waitForTelemetryIngestion(90000);

  // Query for Purchase_Complete event
  const query = `
    customEvents
    | where timestamp >= datetime('${testStartTime.toISOString()}')
    | where name == "Purchase_Complete"
  `;

  const results = await queryApplicationInsights(query);
  // ... validate
});
```

### Query Specific Event Properties

```typescript
const query = `
  customEvents
  | where timestamp >= datetime('${testStartTime.toISOString()}')
  | where name == "Product_AddToCart"
  | extend productId = tostring(customDimensions.productId)
  | extend quantity = toint(customDimensions.quantity)
  | project timestamp, productId, quantity
`;
```

### Check User Tracking

```typescript
const query = `
  customEvents
  | where timestamp >= datetime('${testStartTime.toISOString()}')
  | extend userId = user_Id
  | extend sessionId = session_Id
  | summarize Events=count() by userId, sessionId
`;
```

## Best Practices

1. **Use Network Interception for Quick Validation** - Faster feedback, no ingestion delay
2. **Use Direct Queries for Comprehensive Testing** - Ensures end-to-end flow works
3. **Run Tests After Deployment** - Validate telemetry after `azd up` or `azd deploy`
4. **Add Unique Identifiers** - Include test run IDs in events for easier filtering
5. **Monitor Test Data** - Consider filtering test events when analyzing production usage

## Running Tests After Deployment

After deploying with `azd up` or `azd deploy`, run telemetry validation:

```bash
# Quick validation (30 seconds)
./test-telemetry.sh
# Choose option 1

# Or run directly
cd tests && npx playwright test telemetry.spec.ts
```

For comprehensive validation including Application Insights storage:

```bash
# Full validation (3-4 minutes)
./test-telemetry.sh
# Choose option 2
```

## Related Documentation

- [Application Insights Integration](../docs/features/monitoring/APP_INSIGHTS_INTEGRATION.md) - How telemetry is implemented
- [Playwright Configuration](./playwright.config.ts) - Test configuration
- [Test Utilities](./utils/) - Helper functions for testing

## Advanced: Real-time Stream

For near-real-time validation (5-10 second delay), you can use Application Insights Live Metrics:

```bash
# Open Live Metrics in browser
az monitor app-insights component show \
  --app "$(azd env get-value SERVICE_APP_NAME)" \
  --resource-group "$(azd env get-value AZURE_RESOURCE_GROUP)" \
  --query "appId" -o tsv | \
  xargs -I {} echo "https://portal.azure.com/#blade/AppInsightsExtension/QuickPulseBladeV2/ComponentId/{}"
```

Then run the network interception test while watching the Live Metrics stream.
