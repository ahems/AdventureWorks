# Azure Playwright Testing - Quick Start

Run your Playwright tests at cloud scale with Azure Playwright Testing!

## 🚀 One-Time Setup

### 1. Deploy Infrastructure

```bash
azd up
```

This provisions the Azure Playwright Testing workspace along with all other Azure resources.

### 2. Verify Deployment

```bash
../scripts/utilities/playwright-quick-ref.sh info
```

Expected output:

```
Workspace Name: av-playwright-xxxxx
Workspace ID: /subscriptions/.../av-playwright-xxxxx
Service URL: https://eastus.api.playwright.microsoft.com/...
Dashboard URL: https://playwright.microsoft.com/...
```

### 3. Authenticate

```bash
az login
```

You're ready to run tests!

## 🧪 Running Tests

### Option 1: Helper Script (Recommended)

```bash
# Run all tests
../tests/scripts/run-tests-on-azure-playwright.sh

# Run specific test file
../tests/scripts/run-tests-on-azure-playwright.sh product-reviews

# Run tests matching pattern
../tests/scripts/run-tests-on-azure-playwright.sh "checkout*"
```

### Option 2: NPM Script

```bash
npm run test:e2e:azure
```

### Option 3: Direct Command

```bash
export PLAYWRIGHT_SERVICE_URL=$(azd env get-value PLAYWRIGHT_SERVICE_URL)
cd tests
npx playwright test --config=playwright.azure.config.ts
```

## 📊 View Results

### In Terminal

Results display automatically after test execution.

### In Azure Portal

```bash
../scripts/utilities/playwright-quick-ref.sh dashboard
```

Or get the URL:

```bash
azd env get-value PLAYWRIGHT_DASHBOARD_URL
```

## 🔧 Troubleshooting

### "PLAYWRIGHT_SERVICE_URL not found"

```bash
azd up  # Deploy infrastructure
```

### "Authentication failed"

```bash
az login
az account show  # Verify correct subscription
```

### "Permission denied"

Contact your Azure admin to grant you the **Playwright Service User** role on the workspace.

### Install missing dependencies

```bash
../scripts/utilities/playwright-quick-ref.sh install
```

## 📈 Local vs Azure Testing

| When to Use               | Command                                      |
| ------------------------- | -------------------------------------------- |
| **Quick dev feedback**    | `npm run test:e2e` (local)                   |
| **Full suite validation** | `./run-tests-on-azure-playwright.sh` (Azure) |
| **Pre-merge checks**      | `npm run test:e2e:azure` (Azure)             |
| **Debugging failures**    | `npm run test:e2e` (local)                   |

## 🎯 Common Commands

```bash
# Show workspace info
../scripts/utilities/playwright-quick-ref.sh info

# Check workspace status
../scripts/utilities/playwright-quick-ref.sh status

# Open Azure Portal dashboard
../scripts/utilities/playwright-quick-ref.sh dashboard

# Install dependencies
../scripts/utilities/playwright-quick-ref.sh install

# Run tests
../scripts/utilities/playwright-quick-ref.sh test
```

## 📚 Learn More

- **Full Documentation**: [docs/testing/AZURE_PLAYWRIGHT_TESTING.md](../docs/testing/AZURE_PLAYWRIGHT_TESTING.md)
- **Implementation Details**: [docs/testing/AZURE_PLAYWRIGHT_TESTING_IMPLEMENTATION.md](../docs/testing/AZURE_PLAYWRIGHT_TESTING_IMPLEMENTATION.md)
- **Test Documentation**: [tests/README.md](README.md)

## 💡 Pro Tips

1. **Run locally first** - Catch obvious failures before using Azure
2. **Use helper script** - It handles all environment setup automatically
3. **Check Azure Portal** - Rich diagnostics available for failures
4. **Enable more browsers** - Edit `tests/playwright.azure.config.ts` to test Firefox/WebKit
5. **Adjust parallelism** - Increase workers in config for faster execution

## 🎉 That's It!

You're now running E2E tests at cloud scale. Happy testing! 🚀
