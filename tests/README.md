# Playwright E2E Tests

These tests exercise the Azure Functions that power account management flows in the AdventureWorks storefront. They currently cover:

- Address CRUD (Functions: `GetAddressById`, `CreateAddress`, `UpdateAddress`, `DeleteAddress`)
- Password management (Functions: `SetPassword`, `VerifyPassword`)

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

- Tests run in Chromium only and target desktop viewport.
- Report output lives under `tests/playwright-report/` (HTML) and `tests/test-results/`.
- Each test signs up a fresh user via the public UI using Faker-generated data.
