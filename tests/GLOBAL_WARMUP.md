# Global Health Check Warmup for Playwright Tests

## Overview

All Playwright tests now use a **global warmup phase** that runs once before any tests execute. This replaces the individual warmup calls that were previously scattered across test files.

## How It Works

### Global Setup (`tests/global-setup.ts`)

Before any tests run, Playwright:

1. Opens the health check page at `/health`
2. Waits up to 90 seconds for all services to report healthy status
3. Verifies all 8 service checks pass (1 DAB + 1 MCP + 6 Functions)
4. **If any service is unhealthy, ALL tests are skipped**

### Configuration

Both Playwright configs include the global setup:

- `tests/playwright.config.ts` (local testing)
- `tests/playwright.azure.config.ts` (Azure Playwright Testing)

```typescript
export default defineConfig({
  globalSetup: require.resolve("./global-setup"),
  // ... other config
});
```

### Health Check Integration

The health check page at `/health` includes test IDs for reliable automation:

- `data-testid="overall-status-success"` - Badge shown when all systems healthy
- `data-testid="overall-status-failure"` - Badge shown when issues detected
- `data-testid="health-check-progress"` - Progress bar (aria-valuenow="100" when complete)
- `data-testid="healthy-count"` - Count of healthy services (should be 8)
- `data-testid="unhealthy-count"` - Count of unhealthy services (should be 0)
- `data-testid="checking-count"` - Count of in-progress checks (should be 0 when complete)

## Benefits

### 1. **Faster Test Execution**

- Single warmup at the start vs. warmup in every test suite
- Parallel health checks warm all services simultaneously
- Typical warmup: 5-15 seconds (already warm) or 30-60 seconds (cold start)

### 2. **Better Reliability**

- Comprehensive check of ALL services before tests run
- Catches infrastructure issues before test failures occur
- Clear distinction between test failures and infrastructure failures

### 3. **Simpler Test Code**

- No more `warmupEndpoint()` imports in test files
- No more `test.beforeAll()` warmup blocks
- Cleaner, more focused test code

### 4. **Fail-Fast Behavior**

- If services aren't ready, tests don't even start
- Saves time and resources by not running doomed tests
- Clear error message explains what's wrong

## Services Verified

The global warmup verifies these endpoints are healthy:

| Service                      | Endpoint                  | Purpose                 |
| ---------------------------- | ------------------------- | ----------------------- |
| GraphQL API (DAB)            | `/graphql/`               | Product catalog queries |
| Function: Health Check       | `/api/health`             | Functions app health    |
| Function: Agent Status       | `/api/agent/status`       | AI agent availability   |
| Function: Search Suggestions | `/api/search/suggestions` | Search autocomplete     |
| Function: Sitemap            | `/api/sitemap.xml`        | SEO sitemap             |
| Function: OpenAPI            | `/api/openapi.json`       | API documentation       |
| MCP API                      | `/health`                 | Model Context Protocol  |

## Migration

The following changes were made:

### Files Modified

1. **Test Configs** - Added `globalSetup` to both configs
2. **Test Files** - Removed these patterns:

   ```typescript
   import { warmupEndpoint } from "../utils/warmup";

   test.beforeAll(async () => {
     await Promise.all([
       warmupEndpoint({ ... }),
       warmupEndpoint({ ... }),
     ]);
   });
   ```

3. **Files cleaned up:**
   - `tests/specs/search.spec.ts`
   - `tests/specs/browsing-shopping.spec.ts`
   - `tests/specs/checkout.spec.ts`
   - `tests/specs/sale-discounts.spec.ts`
   - `tests/specs/product-reviews.spec.ts`

### Files Preserved

- `tests/utils/warmup.ts` - Kept for backward compatibility if needed
- `tests/manual/health-check.spec.ts` - Standalone health check test for manual verification

## Running Tests

Tests work exactly the same way, but now include automatic warmup:

```bash
# Local testing
npm run test:e2e

# Azure Playwright Testing
npm run test:e2e:azure

# Specific test
npx playwright test specs/search.spec.ts
```

### Example Output

```
🏥 Running global health check to warm up services...

   Navigating to: https://your-app.azurestaticapps.net/health
   ⏳ Waiting for health checks to complete (max 90s)...
   Progress: 100%
   ✅ Healthy: 8
   ❌ Unhealthy: 0
   ⏳ Checking: 0

✅ All services are healthy and warmed up!
🎭 Ready to run Playwright tests

Running 5 tests using 1 worker
  ✓  test 1...
  ✓  test 2...
```

## Troubleshooting

### Tests Skip Immediately

**Symptom:** Tests don't run, "All tests skipped" message

**Cause:** Global health check failed

**Solution:**

1. Check Azure resources are running: `az containerapp list --resource-group <rg-name>`
2. Visit `/health` page manually to see which services are failing
3. Check logs: `azd logs` or view in Application Insights

### Health Check Times Out

**Symptom:** "Health checks did not complete" error after 90 seconds

**Cause:** Services are cold starting or unresponsive

**Solution:**

1. Increase timeout in `global-setup.ts` if needed
2. Check if services are scaled to zero: Container Apps may need longer
3. Pre-warm services manually: `curl https://your-api.azurecontainerapps.io/graphql/`

### Wrong Service Count

**Symptom:** "Healthy: 7" instead of "Healthy: 8"

**Cause:** One service endpoint changed or is down

**Solution:**

1. Visit `/health` page to see which service is failing
2. Check if new endpoints were added to Functions app
3. Verify `API_MCP_URL` is configured correctly

## Manual Health Check Testing

To test the health check page itself:

```bash
cd tests
npx playwright test manual/health-check.spec.ts
```

This runs the comprehensive health check test suite without the global setup dependency.

## Future Enhancements

Potential improvements:

1. **Parallel Test Suites** - Run multiple test files in parallel after single warmup
2. **Selective Warmup** - Only warm services needed for specific test tags
3. **Health Metrics** - Collect warmup time metrics for monitoring
4. **Retry Logic** - Automatically retry failed warmup once before failing
5. **Service-Specific Timeouts** - Different timeouts for different services
