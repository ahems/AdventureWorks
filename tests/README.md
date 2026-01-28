# Playwright E2E Tests

These tests exercise the Azure Functions that power account management flows in the AdventureWorks storefront. They currently cover:

- Address CRUD (Functions: `GetAddressById`, `CreateAddress`, `UpdateAddress`, `DeleteAddress`)
- Password management (Functions: `SetPassword`, `VerifyPassword`)
- Application Insights telemetry validation (network interception + direct queries)
- User flows: browsing, shopping, checkout
- AI features integration
- Internationalization
- Search functionality

## Test Execution Options

### Local Testing (Default)

Sequential execution in dev container - best for development and debugging:

```bash
npm run test:e2e
```

### Azure Playwright Testing (Cloud Scale)

Parallel execution across 20+ workers with cross-browser support:

```bash
./run-tests-on-azure-playwright.sh
# or
npm run test:e2e:azure
```

**📖 See [Azure Playwright Testing Guide](../docs/AZURE_PLAYWRIGHT_TESTING.md) for detailed documentation.**

## Prerequisites

These tests run directly against the Azure deployment—no local services (DAB, Functions, or Vite) are needed.

1. Sign in to Azure: `az login` (or `azd login`).
2. Select the environment: `azd env refresh` (or ensure `AZURE_ENV_NAME` is set).
3. Confirm the required values exist by running:
   - `azd env get-value "APP_REDIRECT_URI"`
   - `azd env get-value "VITE_API_FUNCTIONS_URL"`
   - `azd env get-value "VITE_API_URL"`

> Playwright is already installed in the dev container. No GitHub runners are required.

## Environment variables

The helper in `tests/utils/env.ts` automatically pulls remote URLs from `azd env get-value`. Override them only if you need to point at a different deployment:

| Variable             | Default source                               |
| -------------------- | -------------------------------------------- |
| `WEB_BASE_URL`       | `azd env get-value "APP_REDIRECT_URI"`       |
| `FUNCTIONS_BASE_URL` | `azd env get-value "VITE_API_FUNCTIONS_URL"` |
| `REST_API_BASE_URL`  | `azd env get-value "VITE_API_URL"` → `/api`  |

## Running tests

```bash
npm run test:e2e
```

The test suite automatically warms up Azure services before running tests to avoid cold-start timeouts. The warm-up process:

- Calls the DAB API REST endpoint (`/api/Product`)
- Calls the Azure Functions addresses endpoint (`/api/addresses`)
- Retries up to 5 times with 3-second delays if services are waking up
- Runs both warm-up calls in parallel for faster startup

You can also run the warm-up independently:

```bash
npm run test:e2e:warmup
```

**Test execution details:**

- Tests run in Chromium only and target desktop viewport.
- Report output lives under `tests/playwright-report/` (HTML) and `tests/test-results/`.
- Each test signs up a fresh user via the public UI using Faker-generated data.
- **Test credentials are logged to console** for manual reproduction:
  ```
  📧 Test User Created:
     Email: user@example.com
     Password: AwXyZ123!9
  ```

## Telemetry Testing

The project includes comprehensive Application Insights telemetry validation:

### Quick Start

```bash
# From project root
./test-telemetry.sh
```

This interactive script offers:

1. **Quick Network Validation (30s)** - Intercepts telemetry requests
2. **Full E2E Validation (3-4 min)** - Queries Application Insights storage
3. **Both Tests** - Runs complete validation suite
4. **Manual Query** - Execute custom Kusto queries
5. **Recent Telemetry** - View last 30 minutes of events

### Test Files

- [`specs/telemetry.spec.ts`](specs/telemetry.spec.ts) - Network interception tests (fast)
- [`specs/telemetry-validation.spec.ts`](specs/telemetry-validation.spec.ts) - End-to-end storage validation

### What Gets Validated

- ✅ Telemetry SDK initialization
- ✅ Page view tracking
- ✅ Custom events (signup, product views, cart actions, purchases)
- ✅ Backend request logging
- ✅ Performance metrics
- ✅ Event properties and metadata

See [TELEMETRY_TESTING.md](TELEMETRY_TESTING.md) for detailed documentation.

- The HTML report is not automatically opened after tests complete. To view it manually, run:
  ```bash
  npx playwright show-report tests/playwright-report
  ```
