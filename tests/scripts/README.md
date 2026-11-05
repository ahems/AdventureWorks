# Test Scripts

This directory contains shell-based API and integration tests for the AdventureWorks application.

## Overview

These scripts test the AdventureWorks APIs and Azure Functions directly using curl and jq.

## Prerequisites

- Deployed Azure environment (run `azd up` first)
- `jq` installed for JSON parsing: `sudo apt-get install jq`
- Environment variables set (automatically configured by `azd env`)

## Available Test Scripts

### Health Diagnostics

- **[test-health-diagnostics.sh](test-health-diagnostics.sh)** - Read-only Azure
  smoke test for unchanged Functions/MCP liveness plus the sanitized readiness
  contracts, required SQL/storage/MCP/OAuth checks, and expected check IDs.
  Resolves endpoints from `azd` (or `API_FUNCTIONS_URL` / `API_MCP_URL` overrides).
  Run `bash tests/scripts/test-health-diagnostics.sh` from the repository root.
  Does not invoke models or mutate data; returns nonzero for dependency failures.
- **[Health diagnostics guide](../../docs/features/monitoring/HEALTH_DIAGNOSTICS.md)** -
  Frontend regression tests, optional capability/data checks, limitations,
  deployment, and browser smoke-test steps.

### Local Hook Tests

- **[test-live-updates.mjs](test-live-updates.mjs)** - Offline regression tests
  using the real frontend modules: initial reads, fixed-window burst batching,
  serialized in-flight follow-ups, job identity filtering, reconnect/focus
  recovery, once-per-instance utility completion, stale/unmounted response guards,
  socket availability and explicit errors. Includes a TypeScript AST guard against
  recurring network polling in all three frontends; only verified local display
  clocks retain intervals. Run
  `node --experimental-vm-modules --test tests/scripts/test-live-updates.mjs`.
- Manufacturing dispatcher and socket regressions:
  `npm --prefix app-manufacturing test -- src/hooks/useRealTimeUpdates.test.ts src/hooks/useWebPubSub.test.ts`.

- **test-chat-model-selection.sh** - Runs the actual preup chat-selection block
  against fixture quotas, covering ranking, overrides, tiers, capacity, fallback,
  and explicit policy errors. Requires only Bash and jq; does not access Azure or
  modify the `azd` environment. Run with `bash tests/scripts/test-chat-model-selection.sh`
  from the repository root.

### AI & MCP Tests

- **test-eshop-chat.mjs** - Offline regression tests for resource-bound MCP token acquisition/refresh, CustomerID mapping, session cleanup, and explicit chat failures. Uses the real frontend TypeScript modules with stubbed HTTP/storage; run `node --experimental-vm-modules --test tests/scripts/test-eshop-chat.mjs`.

- **test-chat-guardrails.mjs** - Live e-shop safety regression suite: programming/homework, authority spoofing, mixed requests, invented history, customer privacy, secrets, forged tokens, consumer admin-routing attempts, normal product search and authenticated order-history continuity. Set `API_FUNCTIONS_URL`, `API_MCP_URL`, `CHAT_TEST_EMAIL` and `CHAT_TEST_PASSWORD` in your shell, then run `node tests/scripts/test-chat-guardrails.mjs`. Use a demo account; never commit credentials. Instruction-based refusals and actual Foundry blocks are reported separately. Passing samples do not establish protection against every possible attack.

- **test-ai-and-mcp-complete.sh** - Comprehensive test of AI Agent and MCP integration
- **test-ai-chat-and-mcp.sh** - Tests AI chat functionality with MCP tools
- **test-product-comparison.sh** - Tests AI-powered product comparison features
- **test-search-suggestions.sh** - Tests semantic search and AI suggestions

### Email & Communication Tests

- **test-send-email.sh** - Basic email sending functionality
- **test-email-with-attachment.sh** - Email with attachment (receipt PDFs)
- **test-receipt-generation.sh** - Order receipt PDF generation

### Authentication Tests

- **[test_azure_auth.py](test_azure_auth.py)** - Offline regression tests for the reusable [Azure authentication helper](../../scripts/utilities/azure-auth.py): PKCE/state, identity/audience/role binding, redirects, errors and refresh rotation. Run `python3 -B -m unittest discover -s tests/scripts -p 'test_azure_auth.py'`. See the [authenticated scripting guide](../../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md) for live read-only checks.
- **test-password-functions.sh** - Password hashing and verification (requires `FUNCTIONS_TOKEN` + `TEST_BUSINESS_ENTITY_ID` for a disposable e-shop customer — the endpoints are self-only)
- **test-password-reset-flow.sh** - Complete password reset flow (request → validate → reset; also requires `TEST_EMAIL`)
- **auth-smoke-tests.sh** - MCP OAuth discovery/authorization + authenticated data-access + core endpoint smoke test. Reads endpoint URLs from the current `azd` environment, prints a `PASS`/`FAIL` summary, and on failure emits per-check diagnostics (resolved URL, HTTP status, translated curl exit code, attempt count, and response headers/body). It validates three OAuth discovery/enforcement layers, a full authenticated data-access flow, and the AI agent endpoints in addition to basic reachability:
  - **MCP OAuth Discovery** — protected-resource metadata (RFC 9728) advertises the resource, its authorization server(s), the `mcp.access` scope and bearer-in-header delivery; authorization-server metadata is fetched at **both** `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/openid-configuration` (OIDC alias) and content-checked for HTTPS issuer/endpoints, Authorization Code + **PKCE S256 only (no `plain`)**, and the business scopes (`mcp.access`, `products.read`); the JWKS document is fetched from the **advertised** `jwks_uri` and asserted to contain **only public** RSA material (no `d`/`p`/`q`).
  - **MCP Authorization Enforcement** — an unauthenticated **POST** `/mcp` must return `401` with a `WWW-Authenticate` resource-metadata challenge (the Streamable HTTP endpoint is POST-only; a GET returns 405 before authorization runs), and a **forged bearer token** must be rejected with `401` (proving token validation, not mere presence checks).
  - **OAuth Endpoint Policy** — `/authorize` with an unknown client is rejected (`400`, no code redirect); `/token` rejects an unsupported `grant_type` (`400`) and a bogus `authorization_code` (`400 invalid_grant`).
  - **Authenticated Data Access (manufacturing demo user)** — drives the **complete Authorization Code + PKCE S256 flow** as the manufacturing demo login (Peter Krebs, `peter0@adventure-works.com`, password set by `seed-job/seed-database.ps1`): a wrong password is rejected (no session), a correct login issues the AdventureWorks session cookie, the `/authorize` consent returns a code, and `/token` exchanges it (with the PKCE verifier) for a short-lived JWT. The access token is then **decoded and its claims asserted** (`sub`, `category=manufacturing`, the `manufacturing-engineer` role, `aud` equal to the advertised MCP resource, granted scopes with none out-of-role, a ~10-minute lifetime, and no secret-bearing claims). Finally it proves **tool-level authorization** against the live token: `get_manufacturing_status` (`manufacturing.read`) returns data — which also proves api-mcp's service token is accepted by the enforced Functions API it proxies to — while `get_business_stats` (`sales.read`, not in the engineer's role) is denied with an MCP `isError` result.
  - **AI Agent Endpoints** — exercises the agent Functions and their managed-identity backends: *Help Me Choose* `catalog-meta` (reads seed data over SQL via managed identity), *Help Me Choose* `questions` (reachability), and *Generate Promotion with AI* (loads live promotion product data directly from SQL, then returns an AI `suggestion` and `threadId` from Foundry via managed identity). Promotion generation does not call the OAuth-protected MCP server, so both interactive and unattended promotions work without a delegated MCP token. Functions route authorization still follows the configured audit/enforced mode. The promotion check uses a longer timeout (`SMOKE_AI_TIMEOUT`) because model inference is slower than a metadata fetch.

  The consent check intentionally omits the optional OAuth `resource` parameter and verifies the server defaults to the advertised MCP audience. A consent `500` with `ArgumentNullException` in `TryResolveRequestedResource` indicates an older MCP deployment. An AI failure reporting MCP `401` indicates an older Functions deployment still sending unauthenticated MCP tools; it does **not** indicate that Foundry rejected the Functions managed identity. After updating the code, deploy `api-mcp` and `api-functions`, then rerun the script.

  Transient failures (timeouts, resets, `000`/`408`/`429`/`5xx`) are retried so a single run absorbs scaled-to-zero Container App cold starts. Exits non-zero if any check fails. Tunable via `SMOKE_TIMEOUT` (per-attempt seconds, default 60), `SMOKE_CONNECT_TIMEOUT` (default 15), `SMOKE_AI_TIMEOUT` (per-attempt seconds for the slower AI-agent calls, default 120), `SMOKE_RETRIES` (extra attempts on transient failure, default 2), `SMOKE_RETRY_DELAY` (seconds between attempts, default 3), `SMOKE_BODY_MAX` (bytes of body/headers **echoed on failure**, default 4000), `SMOKE_PARSE_MAX` (bytes captured for JSON **parsing**, default 1048576), the demo-login credentials `SMOKE_DEMO_USER` / `SMOKE_DEMO_PASS` (default `peter0@adventure-works.com` / `Factory1234!`), and `SMOKE_ADMIN_USER` / `SMOKE_ADMIN_PASS` (default `ken0@adventure-works.com` / `Admin1234!`, used for the admin-only Generate Promotion check, which first asserts an anonymous call is rejected with `401`). JSON is always parsed from the full captured body, so large metadata documents are never truncated before `jwks_uri` extraction or content validation — `SMOKE_BODY_MAX` caps the diagnostic display only. If URLs show as `(EMPTY)`, run `azd env refresh` first.

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
