# Test Scripts

This directory contains shell-based API and integration tests for the AdventureWorks application.

## Overview

These scripts test the AdventureWorks APIs and Azure Functions directly using curl and jq.

## Prerequisites

- Deployed Azure environment (run `azd up` first)
- `jq` installed for JSON parsing: `sudo apt-get install jq`
- Environment variables set (automatically configured by `azd env`)

## Available Test Scripts

### AI & MCP Tests

- **test-ai-and-mcp-complete.sh** - Comprehensive test of AI Agent and MCP integration
- **test-ai-chat-and-mcp.sh** - Tests AI chat functionality with MCP tools
- **test-product-comparison.sh** - Tests AI-powered product comparison features
- **test-search-suggestions.sh** - Tests semantic search and AI suggestions

### Email & Communication Tests

- **test-send-email.sh** - Basic email sending functionality
- **test-email-with-attachment.sh** - Email with attachment (receipt PDFs)
- **test-receipt-generation.sh** - Order receipt PDF generation

### Authentication Tests

- **test-password-functions.sh** - Password hashing and verification
- **test-password-reset-flow.sh** - Complete password reset flow (request → validate → reset)
- **auth-smoke-tests.sh** - MCP OAuth discovery/authorization + authenticated data-access + core endpoint smoke test. Reads endpoint URLs from the current `azd` environment, prints a `PASS`/`FAIL` summary, and on failure emits per-check diagnostics (resolved URL, HTTP status, translated curl exit code, attempt count, and response headers/body). It validates three OAuth discovery/enforcement layers, a full authenticated data-access flow, and the AI agent endpoints in addition to basic reachability:
  - **MCP OAuth Discovery** — protected-resource metadata (RFC 9728) advertises the resource, its authorization server(s), the `mcp.access` scope and bearer-in-header delivery; authorization-server metadata is fetched at **both** `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/openid-configuration` (OIDC alias) and content-checked for HTTPS issuer/endpoints, Authorization Code + **PKCE S256 only (no `plain`)**, and the business scopes (`mcp.access`, `products.read`); the JWKS document is fetched from the **advertised** `jwks_uri` and asserted to contain **only public** RSA material (no `d`/`p`/`q`).
  - **MCP Authorization Enforcement** — an unauthenticated **POST** `/mcp` must return `401` with a `WWW-Authenticate` resource-metadata challenge (the Streamable HTTP endpoint is POST-only; a GET returns 405 before authorization runs), and a **forged bearer token** must be rejected with `401` (proving token validation, not mere presence checks).
  - **OAuth Endpoint Policy** — `/authorize` with an unknown client is rejected (`400`, no code redirect); `/token` rejects an unsupported `grant_type` (`400`) and a bogus `authorization_code` (`400 invalid_grant`).
  - **Authenticated Data Access (demo.admin)** — drives the **complete Authorization Code + PKCE S256 flow** as the seeded demo admin (`demo.admin@adventureworks.com`, seeded by `seed-job/seed-database.ps1`): a wrong password is rejected (no session), a correct login issues the AdventureWorks session cookie, the `/authorize` consent returns a code, and `/token` exchanges it (with the PKCE verifier) for a short-lived JWT. The access token is then **decoded and its claims asserted** (`sub`, `category=employee`, the `operations-admin` role, `aud` equal to the advertised MCP resource, granted scopes with none out-of-role, a ~10-minute lifetime, and no secret-bearing claims). Finally it proves **tool-level authorization** against the live token: `get_business_stats` (`sales.read`) returns seeded data, while `get_manufacturing_status` (`manufacturing.read`, not in the admin's role) is denied with an MCP `isError` result.
  - **AI Agent Endpoints** — exercises the anonymous agent Functions that must reach their managed-identity backends: *Help Me Choose* `catalog-meta` (reads seed data over SQL via managed identity), *Help Me Choose* `questions` (reachability), and *Generate Promotion with AI* (returns an AI `suggestion` from Azure OpenAI via managed identity). The promotion check uses a longer timeout (`SMOKE_AI_TIMEOUT`) because model inference is slower than a metadata fetch.

  Transient failures (timeouts, resets, `000`/`408`/`429`/`5xx`) are retried so a single run absorbs scaled-to-zero Container App cold starts. Exits non-zero if any check fails. Tunable via `SMOKE_TIMEOUT` (per-attempt seconds, default 60), `SMOKE_CONNECT_TIMEOUT` (default 15), `SMOKE_AI_TIMEOUT` (per-attempt seconds for the slower AI-agent calls, default 120), `SMOKE_RETRIES` (extra attempts on transient failure, default 2), `SMOKE_RETRY_DELAY` (seconds between attempts, default 3), `SMOKE_BODY_MAX` (bytes of body/headers **echoed on failure**, default 4000), `SMOKE_PARSE_MAX` (bytes captured for JSON **parsing**, default 1048576), and the demo-login credentials `SMOKE_DEMO_USER` / `SMOKE_DEMO_PASS` (default the seeded `demo.admin@adventureworks.com`). JSON is always parsed from the full captured body, so large metadata documents are never truncated before `jwks_uri` extraction or content validation — `SMOKE_BODY_MAX` caps the diagnostic display only. If URLs show as `(EMPTY)`, run `azd env refresh` first.

### Data & API Tests

- **test-product-reviews.sh** - Product review creation and retrieval
- **test-telemetry.sh** - Application Insights telemetry generation
- **test-robots-sitemap.sh** - SEO robots.txt and sitemap.xml generation

## Usage

### Running Individual Tests

```bash
# From repository root
cd tests/scripts

# Run a specific test
./test-ai-chat-and-mcp.sh

# Run password tests
./test-password-functions.sh
./test-password-reset-flow.sh
```

### Running All Tests

```bash
# Run all test scripts
cd tests/scripts
for script in test-*.sh; do
  echo "Running $script..."
  ./"$script"
done
```

### Testing Against Local Development

Most scripts default to Azure-deployed endpoints. To test locally:

1. Update `API_FUNCTIONS_URL` in each script to point to localhost
2. Ensure services are running locally (see main QUICKSTART.md)

## Environment Variables

Scripts automatically use these variables (set by `azd env`):

- `API_FUNCTIONS_URL` - Azure Functions endpoint
- `API_URL` - DAB GraphQL API endpoint
- `VITE_API_URL` - Frontend API endpoint
- `APPINSIGHTS_CONNECTIONSTRING` - Application Insights

## Test Data

- Tests use predefined customer IDs and product IDs
- Some tests create temporary data (reviews, emails) which is cleaned up
- Check individual script comments for specific test data requirements

## Expected Outputs

Each script:

- ✅ Prints success messages in green
- ❌ Prints errors in red
- Exits with code 0 on success, non-zero on failure

## Troubleshooting

### Common Issues

**"jq: command not found"**

```bash
sudo apt-get update && sudo apt-get install -y jq
```

**"API_FUNCTIONS_URL not set"**

```bash
azd env refresh
source <(azd env get-values)
```

**"401 Unauthorized"**

- Most API tests work without authentication
- Some tests require a valid customer context
- Check that Azure deployment is complete

### Service Warmup

Azure Functions may need warmup after deployment:

```bash
curl "$API_FUNCTIONS_URL/api/health"
```

## Contributing

When adding new test scripts:

1. Follow naming convention: `test-<feature>.sh`
2. Include clear comments and usage examples
3. Use proper exit codes (0 = success, non-zero = failure)
4. Validate required dependencies at script start
5. Clean up any test data created

## Related Documentation

- [Main Testing Guide](../../docs/testing/AI_AND_MCP_TESTING_GUIDE.md)
- [Test scripts](../README.md)
- [API Documentation](../../api/README.md)
