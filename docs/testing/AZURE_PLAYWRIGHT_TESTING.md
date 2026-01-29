# Azure Playwright Testing Integration

This project includes Azure Playwright Testing workspace for running E2E tests at scale in the cloud.

## Overview

Azure Playwright Testing provides:

- **Cloud-scale parallel execution**: Run tests across multiple browsers and OS versions simultaneously
- **Managed infrastructure**: No need to maintain test runners or browser environments
- **Centralized reporting**: View test results and artifacts in Azure Portal
- **Cost-effective**: Pay only for test execution time
- **CI/CD integration**: Easy integration with GitHub Actions and Azure Pipelines

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Azure Playwright Testing Workspace                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Chromium   │  │   Firefox    │  │    WebKit    │     │
│  │  (Windows)   │  │   (Linux)    │  │    (macOS)   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                             │
│  Tests run in parallel across browsers and configurations  │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
                    ┌─────────┴─────────┐
                    │  Test Execution   │
                    │                   │
                    │ • Local Dev       │
                    │ • CI/CD Pipeline  │
                    │ • Manual Runs     │
                    └───────────────────┘
```

## Infrastructure

The Playwright workspace is defined in Bicep and deployed with the rest of the Azure infrastructure:

### Files

- **`infra/modules/playwright.bicep`**: Bicep module defining the Playwright Testing workspace
- **`infra/main.bicep`**: Main infrastructure file that deploys the Playwright module
- **`tests/playwright.azure.config.ts`**: Playwright configuration for Azure execution
- **`run-tests-on-azure-playwright.sh`**: Helper script to run tests on Azure

### Deployment

The Playwright workspace is automatically created when you deploy the application:

```bash
azd up
```

This provisions:

1. Azure Playwright Testing workspace with regional affinity
2. Role assignments for admin user and managed identity
3. Configuration exported to azd environment variables

### Environment Variables

After deployment, these variables are available via `azd env get-values`:

- `PLAYWRIGHT_WORKSPACE_ID`: Resource ID of the workspace
- `PLAYWRIGHT_WORKSPACE_NAME`: Name of the workspace
- `PLAYWRIGHT_DASHBOARD_URL`: URL to view test results in Azure Portal
- `PLAYWRIGHT_SERVICE_URL`: Service endpoint for test execution

## Running Tests on Azure

### Prerequisites

1. **Deploy infrastructure**:

   ```bash
   azd up
   ```

2. **Azure CLI authentication**:

   ```bash
   az login
   ```

3. **Install test dependencies**:
   ```bash
   cd tests
   npm install
   ```

### Using the Helper Script (Recommended)

The `run-tests-on-azure-playwright.sh` script handles environment setup automatically:

```bash
# Run all tests
./run-tests-on-azure-playwright.sh

# Run specific test file
./run-tests-on-azure-playwright.sh product-reviews

# Run tests matching a pattern
./run-tests-on-azure-playwright.sh "product-*"
```

The script:

- ✓ Validates Azure CLI authentication
- ✓ Retrieves Playwright service URL from azd environment
- ✓ Installs missing dependencies
- ✓ Executes tests on Azure with proper configuration
- ✓ Displays dashboard link for results

### Manual Execution

If you prefer to run tests manually:

```bash
cd tests

# Set the Playwright service URL
export PLAYWRIGHT_SERVICE_URL=$(azd env get-value PLAYWRIGHT_SERVICE_URL)

# Run tests with Azure configuration
npx playwright test --config=playwright.azure.config.ts
```

### Configuration Options

The Azure configuration (`playwright.azure.config.ts`) enables:

- **Parallel execution**: 20 workers by default (configurable)
- **Retries**: 2 retries for failed tests
- **Multiple browsers**: Chromium, Firefox, WebKit (uncomment in config)
- **Authentication**: Entra ID via Azure CLI or Managed Identity

To customize parallelism:

```typescript
// In playwright.azure.config.ts
getServiceConfig({
  serviceAuthType: ServiceAuth.EntraId,
  timeout: 60_000,
  workers: 50, // Increase for more parallelism
});
```

## Local vs Azure Testing

| Feature         | Local Testing          | Azure Testing                |
| --------------- | ---------------------- | ---------------------------- |
| **Config File** | `playwright.config.ts` | `playwright.azure.config.ts` |
| **Execution**   | Sequential (1 worker)  | Parallel (20+ workers)       |
| **Environment** | Dev container          | Azure-managed browsers       |
| **Retries**     | 0                      | 2                            |
| **Cost**        | Free                   | Pay per test minute          |
| **Speed**       | Slower                 | Faster (parallel)            |

**When to use local testing:**

- Quick feedback during development
- Debugging specific test failures
- Limited test scope

**When to use Azure testing:**

- Full test suite validation
- Pre-merge/pre-deploy checks
- Cross-browser compatibility testing
- Performance testing at scale

## Viewing Test Results

### Azure Portal Dashboard

After test execution, view detailed results:

```bash
# Get dashboard URL
azd env get-value PLAYWRIGHT_DASHBOARD_URL
```

The dashboard shows:

- Test pass/fail rates
- Execution duration
- Browser-specific results
- Screenshots and videos of failures
- Trace files for debugging

### Local Reports

HTML reports are generated locally regardless of where tests run:

```bash
cd tests
npx playwright show-report
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Tests

on:
  push:
    branches: [main, dev]
  pull_request:

jobs:
  playwright-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Install dependencies
        run: |
          cd tests
          npm ci

      - name: Run tests on Azure Playwright Testing
        env:
          PLAYWRIGHT_SERVICE_URL: ${{ secrets.PLAYWRIGHT_SERVICE_URL }}
        run: |
          cd tests
          npx playwright test --config=playwright.azure.config.ts

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: tests/playwright-report/
```

### Required Secrets

Configure these in your GitHub repository settings:

- `AZURE_CREDENTIALS`: Service principal credentials for Azure login
- `PLAYWRIGHT_SERVICE_URL`: From `azd env get-value PLAYWRIGHT_SERVICE_URL`

## Authentication & Permissions

### Local Development

Uses **Azure CLI credentials**:

```bash
az login
```

Your user account must have the **Playwright Service User** role on the workspace.

### CI/CD (Managed Identity)

The user-assigned managed identity is automatically granted the **Playwright Service User** role during deployment (see `infra/modules/playwright.bicep`).

Use the managed identity in CI/CD pipelines:

```yaml
- uses: azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

## Troubleshooting

### Error: "PLAYWRIGHT_SERVICE_URL not found"

**Solution**: Ensure infrastructure is deployed:

```bash
azd up
```

### Error: "Authentication failed"

**Solution**: Login to Azure CLI:

```bash
az login
az account show  # Verify correct subscription
```

### Error: "Permission denied"

**Solution**: Request Playwright Service User role from your Azure admin:

```bash
# Get workspace name
WORKSPACE_NAME=$(azd env get-value PLAYWRIGHT_WORKSPACE_NAME)

# Get your user ID
USER_ID=$(az ad signed-in-user show --query id -o tsv)

# Have admin run:
az role assignment create \
  --role "Playwright Service User" \
  --assignee $USER_ID \
  --scope "/subscriptions/{subscription-id}/resourceGroups/{rg-name}/providers/Microsoft.AzurePlaywrightService/accounts/$WORKSPACE_NAME"
```

### Tests timing out

**Solution**: Increase timeout in Azure config:

```typescript
// playwright.azure.config.ts
getServiceConfig({
  serviceAuthType: ServiceAuth.EntraId,
  timeout: 120_000, // Increase to 2 minutes
});
```

### Slow test execution

**Solution**: Increase parallel workers:

```typescript
// playwright.azure.config.ts
getServiceConfig({
  workers: 50, // More parallelism
});
```

## Cost Optimization

Azure Playwright Testing charges per test minute. To optimize costs:

1. **Run critical tests frequently, full suite less often**

   ```bash
   # Critical path only
   ./run-tests-on-azure-playwright.sh "checkout.spec.ts"

   # Full suite nightly/pre-release
   ./run-tests-on-azure-playwright.sh
   ```

2. **Use local testing for development**

   ```bash
   cd tests
   npx playwright test  # Uses local config
   ```

3. **Optimize test parallelism**
   - More workers = faster but higher cost
   - Balance based on test suite size

4. **Set execution time limits**
   ```typescript
   timeout: 30_000, // Fail fast on stuck tests
   ```

## Best Practices

1. **Keep local and Azure configs in sync**: Only parallelism and retries should differ
2. **Use the helper script**: It handles environment setup correctly
3. **Test locally first**: Catch obvious failures before running on Azure
4. **Review failures in Azure Portal**: Rich diagnostics available in dashboard
5. **Clean up old workspaces**: Delete unused Playwright workspaces to avoid costs

## Additional Resources

- [Azure Playwright Testing Documentation](https://learn.microsoft.com/azure/playwright-testing/)
- [Playwright Documentation](https://playwright.dev/)
- [Azure Bicep Documentation](https://learn.microsoft.com/azure/azure-resource-manager/bicep/)

## Support

For issues specific to:

- **Infrastructure**: Check `infra/modules/playwright.bicep`
- **Test configuration**: Check `tests/playwright.azure.config.ts`
- **Test execution**: Check `tests/specs/*.spec.ts`
- **Azure service**: See [Azure Playwright Testing docs](https://learn.microsoft.com/azure/playwright-testing/)
