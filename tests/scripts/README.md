---
title: Test scripts catalog (tests/scripts) — offline regressions, authentication assurance and deployed checks
summary: Per-script usage for every runner in tests/scripts, with prerequisites, flags, environment variables and a safety label (offline, read-only, mutating, email or AI cost) for each command.
audience: [developer, operator, security-reviewer, ai-agent]
components: [tests, api-functions, api-mcp, api, app, app-admin, app-manufacturing, mcp-inspector, seed-job]
related:
  - tests/README.md
  - docs/testing/testing-strategy.md
  - docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md
  - docs/testing/AI_CHAT_MCP_TESTING.md
  - docs/testing/AI_AND_MCP_TESTING_GUIDE.md
  - docs/features/authentication/END_TO_END_AUTHENTICATION.md
---

# Test scripts catalog (`tests/scripts/`)

This folder holds the repository's test runners: offline regression tests for the
frontends and deployment hooks, the authentication assurance runner and scripts
that call the deployed demo. This page gives each script's command, inputs and
side effects. The [testing strategy](../../docs/testing/testing-strategy.md)
explains what each layer proves and when to run it. The
[end-to-end authentication guide](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md)
describes the assurance evidence in detail.

## Contents

- [Safety labels](#safety-labels)
- [Prerequisites](#prerequisites)
- [Read-only GET routes](#read-only-get-routes)
- [Offline tests](#offline-tests)
- [Authentication tests](#authentication-tests)
- [Runtime identity probes](#runtime-identity-probes)
- [Browser runners](#browser-runners)
- [Deployed smoke and health checks](#deployed-smoke-and-health-checks)
- [Feature and legacy scripts](#feature-and-legacy-scripts)
- [DAB check scripts](#dab-check-scripts)
- [Seed log mount authentication](#seed-log-mount-authentication)
- [Seed SQL principal diagnostic](#seed-sql-principal-diagnostic)
- [Helper files](#helper-files)
- [Results, exit codes and source control](#results-exit-codes-and-source-control)
- [Troubleshooting](#troubleshooting)
- [Adding a script](#adding-a-script)
- [Related](#related)

## Safety labels

Every command below carries one or more of these labels. Commands are listed
individually because there is no safe "run everything" loop: several scripts
write data, send email or call paid models.

| Label | Meaning |
| --- | --- |
| **Offline** | No Azure calls; local processes and fixtures only |
| **Read-only** | Calls the deployed demo without changing business data |
| **Mutating** | Creates, changes or deletes data or Azure resources (fixtures are cleaned up unless the row says otherwise) |
| **Email** | Can send a real email through Azure Communication Services |
| **AI cost** | Makes potentially billable Foundry model calls |

## Prerequisites

- Run every command from the repository root.
- Deployed checks read the selected azd environment with `azd env get-value`, so
  `azd auth login` and an environment deployed by the user are required. Scripts
  never need, and must not be given, the whole `.env` file.
- `curl`, `jq` and `python3` for shell scripts; Node.js for `.mjs`/`.cjs` files.
- Deployed assurance profiles need the Python packages in
  [`tests/auth/container/requirements.txt`](../auth/container/requirements.txt),
  installed in an isolated virtual environment. Offline unit tests use only the
  standard library, plus `pyyaml` and `cryptography` for `tests/auth`.
- Browser runners use the storefront's Playwright dependency and need Chromium and
  its OS packages installed.
- Protected endpoints need tokens from
  [`azure-auth.py`](../../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md). Prefer the
  `manufacturing` identity (Peter) for manufacturing work and `admin` (Ken) for
  customers, orders and reporting.

## Read-only GET routes

Functions `GET` routes do not change state, so any reviewed `GET` is safe as a
read-only probe. The offline auth gate requires every protected `GET` to be listed
in `safeFunctionReadRoutes` in [`tests/auth/contracts.json`](../auth/contracts.json).
On-demand jobs are `POST`: `orders/delivery/trigger`, `archive/trigger` and
`TranslateLanguageFile_Terminate`. Seeding, agent auto-shutoff, proposal expiry and
shortage pruning run in the `SimulationMaintenance_Timer` function instead of in reads.

For a harmless authenticated read, use `/api/manufacturing/scrap-events` or
`/api/manufacturing/vendor-quality` as Peter, or `/api/ai-job-queue/status` as Ken.

## Offline tests

**Offline.** These tests need no Azure login. Most of them also run inside the
[offline assurance profile](#authentication-tests).

### Node regression tests

Run with `node --experimental-vm-modules --test <file>...`. They load the real
frontend modules with stubbed HTTP and storage.

| File | Covers | In offline profile |
| --- | --- | --- |
| [`test-live-updates.mjs`](test-live-updates.mjs) | Web PubSub dispatchers: fixed-window batching, in-flight follow-ups, reconnect and focus recovery, utility completion once per instance, cleanup. Its source scan rejects recurring network polling in all three frontends. | Yes |
| [`test-route-auth.mjs`](test-route-auth.mjs) | Frontend route guards | Yes |
| [`test-eshop-chat.mjs`](test-eshop-chat.mjs) | Storefront chat: MCP-audience token acquisition and refresh, customer mapping, session cleanup, explicit failures | Yes |
| [`test-auth-browser-network-policy.mjs`](test-auth-browser-network-policy.mjs) | The request allow-list used by the browser runners | Yes |
| [`test-review-auth.mjs`](test-review-auth.mjs) | Review submission and voting guards | Yes |
| [`test-guest-cart-auth.mjs`](test-guest-cart-auth.mjs) | Guest-cart sessions, audience selection, logout isolation, merge and redirect rules | Yes |
| [`test-cart-provider-auth.mjs`](test-cart-provider-auth.mjs) | Cart provider merge, retry, account-switch and logout races | Yes |
| [`test-payment-methods-auth.mjs`](test-payment-methods-auth.mjs), [`test-address-auth.mjs`](test-address-auth.mjs), [`test-order-detail-auth.mjs`](test-order-detail-auth.mjs) | Consumer ownership handling in the storefront | Yes |
| [`test-runtime-rbac.cjs`](test-runtime-rbac.cjs), [`test-read-auth-reports.cjs`](test-read-auth-reports.cjs) | Runtime probe parsing and report reading (`node --test` is enough) | Yes |
| [`test-internal-session-races.mjs`](test-internal-session-races.mjs), [`test-internal-request-sessions.mjs`](test-internal-request-sessions.mjs) | Admin and manufacturing session switching and stale-request rejection | Yes, as a required gate |
| [`test-receipt-download.mjs`](test-receipt-download.mjs) | Admin receipt download handling (`node --experimental-vm-modules --test`) | No |
| [`test-frontend-telemetry-envelopes.mjs`](test-frontend-telemetry-envelopes.mjs) | Frontend telemetry envelope parsing (`node --test`) | No |
| [`test-internal-session-browser.mjs`](test-internal-session-browser.mjs) | Internal session switching in a local Chromium (`node --test`; needs Chromium) | No |

Run `test-frontend-telemetry-envelopes.mjs` by name. A
`test-frontend-telemetry*.mjs` glob also matches the deployed runner
`test-frontend-telemetry.mjs`, which exits with `--output is required`.

Manufacturing app Vitest suites run separately, for example
`npm --prefix app-manufacturing test -- src/hooks/useRealTimeUpdates.test.ts src/hooks/useWebPubSub.test.ts`;
`npm --prefix app-admin test` runs the admin suite.

The Build-Checker `offline-tests` job runs `test-live-updates.mjs`,
`test-receipt-download.mjs`, `test-internal-request-sessions.mjs`,
`test-internal-session-races.mjs` and `test-frontend-telemetry-envelopes.mjs`, plus
both Vitest suites. The harnesses stub only external dependencies (`dabAuth`,
`@/lib/utils`, `graphql-request`); other `@/` imports load the real app source, so
a stub must export every name the module under test imports.

### Python unit tests

All use `unittest`. Run one module with
`python3 -B -m unittest discover -s tests/scripts -p '<file>'`, or all of them with
`-p 'test_*.py'`. The Build-Checker `offline-tests` job runs them all with
`python3 -B -m pytest tests/scripts` (needs `pytest`, `pyyaml` and `cryptography`).

| File | Covers | In offline profile |
| --- | --- | --- |
| [`test_azure_auth.py`](test_azure_auth.py) | `scripts/utilities/azure-auth.py` login, PKCE, refresh and request handling | Yes |
| [`test_observability_verifier.py`](test_observability_verifier.py) | Selected-trace metadata query bounds, role/parent evidence, missing data and duplicate spans | No |
| [`test_hosted_agent_mcp_trust.py`](test_hosted_agent_mcp_trust.py) | Hosted Manufacturing agent trust configuration for api-mcp | Yes |
| [`test_agent_tools_config.py`](test_agent_tools_config.py) | Foundry agent definition tool lists | Yes |
| [`test_manufacturing_agent_tools.py`](test_manufacturing_agent_tools.py) | The hosted Manufacturing agent's MCP tool service and its authentication | Yes |
| [`test_keyvault_firewall.py`](test_keyvault_firewall.py) | Postprovision Key Vault certificate block with mocked `az`. Run directly: `python3 -B tests/scripts/test_keyvault_firewall.py`. A template test also needs the Bicep CLI. | `KeyVaultFirewallTests` only |
| [`test_localized_catalog_queries.py`](test_localized_catalog_queries.py) | Source guard: SQL joining the localized category or subcategory tables must select one culture or deduplicate | No |
| [`test_trigger_output_clauses.py`](test_trigger_output_clauses.py) | Source guard: DML on realtime-outbox trigger tables must use `OUTPUT ... INTO` (SQL Server rejects a bare `OUTPUT` there) | No |
| [`test_github_deployer_setup.py`](test_github_deployer_setup.py), [`test_github_deployment_identity.py`](test_github_deployment_identity.py), [`test_github_deployment_name.py`](test_github_deployment_name.py), [`test_github_oidc_az.py`](test_github_oidc_az.py) | GitHub deployment workflow setup, identity, naming and OIDC renewal with a fake `az` | No |
| [`test_recover_azd_env.py`](test_recover_azd_env.py) | `scripts/utilities/recover-azd-env.py` with mocked `az`/`azd` | No |
| [`test_seed_job_execution.py`](test_seed_job_execution.py) | The `scripts/hooks/seed-job-execution.sh` hook helper | No |
| [`test_manufacturing_batch.py`](test_manufacturing_batch.py), [`test_manufacturing_diagrams.py`](test_manufacturing_diagrams.py), [`test_manufacturing_drafts.py`](test_manufacturing_drafts.py), [`test_manufacturing_export.py`](test_manufacturing_export.py), [`test_manufacturing_verification.py`](test_manufacturing_verification.py) | Manufacturing content scripts in `scripts/data-management` (populate, diagrams, drafts, export, verify) | No |

The `tests/auth` suite runs with
`python3 -B -m unittest discover -s tests/auth -p 'test_*.py'`. It needs `pyyaml`
and `cryptography`; one way to supply them is
`uvx -q --with pyyaml --with cryptography --with pytest pytest tests/auth -q`.

### Bash offline test

[`test-chat-model-selection.sh`](test-chat-model-selection.sh) runs the real
preup chat-model selection block against fixture quotas: ranking, overrides,
tiers, capacity, fallback and policy errors. It needs Bash and `jq` and does not
touch the azd environment: `bash tests/scripts/test-chat-model-selection.sh`.

## Authentication tests

For one-shot, read-only trace metadata verification, use
[`test-observability.py`](test-observability.py) with a known W3C trace ID and
an existing output directory. It queries the selected workspace with the
operator's Azure CLI identity and never queries prompt or log-message content.
See [observability validation](../../docs/testing/OBSERVABILITY_VALIDATION.md)
for arguments, exit codes and what the result does and does not prove.

[`validate-auth.sh`](validate-auth.sh) runs `python3 -B tests/auth/validate.py`
with the same arguments; [`test-ai-chat-and-mcp.sh`](test-ai-chat-and-mcp.sh) runs
it with `--chat`. Choose exactly one profile:

```bash
bash tests/scripts/validate-auth.sh --offline [--functions-host] [--output DIR]
bash tests/scripts/validate-auth.sh --infra [--environment NAME]
```

| Profile | What it does | Safety |
| --- | --- | --- |
| `--offline` | Python, Node, Vitest and .NET suites plus source contracts (see [testing strategy](../../docs/testing/testing-strategy.md#offline-authentication-assurance)) | Offline |
| `--offline --functions-host` | Also starts the real Functions worker on loopback in a Linux namespace with blocked dependencies. Needs `func`, `azurite`, `dotnet`, `openssl`, `unshare`, `ip` and namespace permission. | Offline |
| `--infra` | Deployed configuration inventory: identities, role bindings, agents, keyless settings, readiness probes | Read-only |
| `--live` | Reviewed safe GETs and authorization denials, plus controlled fixtures: retained consumer users created on first use, guest carts created and retired, frontend telemetry producers | Mutating (fixtures) |
| `--all` | `--offline`, `--infra` and `--live` together | Mutating (fixtures) |
| `--browsers` | Chromium flows for every site (see [browser runners](#browser-runners)) | Mutating (cart fixtures) |
| `--chat` | Consumer MCP checks used by chat: availability, missing-scope denial, tool ownership | Read-only |
| `--mcp-functions` | MCP-to-Functions proxy authorization | Read-only |
| `--catalog-agent`, `--promotion-agent`, `--email-content-agent`, `--product-content-agent`, `--manufacturing-content-agent`, `--analysis-agent` | Focused agent-definition and guard checks without inference unless a canary is added | Read-only |
| `--order-canary` | Order preflight only; creates nothing without `--order-cancellation-canary`. The preflight reads `manufacturing/agent-config`, which can switch an expired manufacturing agent off. | Read-only except that one GET |

Common options: `--environment NAME` selects an azd environment, and `--output DIR`
sets a new evidence directory (default `.auth-results/<run-id>`). The `--offline`,
`--infra`, `--live`, `--all` and `--analysis-agent` profiles share
`.auth-results/validation.lock`, so only one of them runs at a time.

### Opt-in canaries

Canaries are explicit flags added to a profile. Run them only after `azd deploy`
has shipped the matching Functions, MCP and agent changes.

| Flag | Needs | Effect | Safety |
| --- | --- | --- | --- |
| `--public-agent-canary` | `--catalog-agent`, `--live` or `--all` | Bounded public catalog-agent requests | AI cost |
| `--customer-agent-canary` | `--chat`, `--live` or `--all` | One customer-chat request with trace correlation | AI cost |
| `--admin-agent-canary` | `--chat`, `--live` or `--all` | One read-only admin-chat request | AI cost |
| `--promotion-agent-canary` | `--promotion-agent`, `--live` or `--all` | One promotion suggestion | AI cost |
| `--email-content-agent-canary` | `--email-content-agent`, `--live` or `--all` | One content-only inference; no email is sent | AI cost |
| `--product-content-agent-canary` | `--product-content-agent`, `--live` or `--all` | Up to two content inferences | AI cost |
| `--manufacturing-content-agent-canary` | `--manufacturing-content-agent` | One bounded part-sheet request | AI cost |
| `--analysis-agent-canary` | `--analysis-agent` | Two synthetic analyses | AI cost |
| `--hosted-agent-canary` | `--live` or `--all` | One no-tool probe of the hosted Manufacturing agent | AI cost |
| `--order-cancellation-canary` | `--order-canary` or `--all` | Creates one storefront order and one store order and cancels both as admin. Disposable consumers, customers, addresses, the cancelled orders and one unit of inventory remain until the environment is recreated. | Mutating, AI cost |
| `--agent-tool-sweep` | `--customer-agent-canary`, `--admin-agent-canary`, or `--order-canary --order-cancellation-canary` | Prompts each reviewed chat tool not yet correlated, then matches each trace to the SQL session principal in telemetry | AI cost (several requests) |
| `--generation-agent-canary` | `--live`, `--all`, or `--order-canary --order-cancellation-canary` | Runs the AI customer generator, which creates and keeps a customer; with the order canary, also one AI order that an admin cancels | Mutating, AI cost |

The [chat canaries](../../docs/testing/AI_CHAT_MCP_TESTING.md) and the
[agent tool sweep](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#agent-tool-sweep-and-generation-agent-canaries)
are described in detail elsewhere, as are the
[order canary](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#bounded-order-canary-with-cancellation)
and [email safety](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#live-mutation-and-email-safety).

### Private-network job runner

[`run-auth-assurance-job.py`](run-auth-assurance-job.py) builds an image in the
environment's registry, deploys
[`infra/testing/auth-assurance-job.bicep`](../../infra/testing/auth-assurance-job.bicep)
as a temporary Container Apps job inside the private network, uploads reports to
the private `adventureworks-receipts` container under `auth-assurance/` and
deletes the job. It needs `az`, `azd` and `git`.

```bash
python3 tests/scripts/run-auth-assurance-job.py --environment NAME --preflight
```

| Mode | Effect | Safety |
| --- | --- | --- |
| `--preflight` | Discovery only; no image, job or fixture | Read-only |
| *(no mode)* | Standalone private-network suite | Mutating (temporary job) |
| `--sql-only` | Effective SQL permissions and identity; no application calls | Mutating (temporary job only) |
| `--address-only` | API-created private address fixtures, owner denials, verified cleanup | Mutating |
| `--browser-only` | Chromium scenarios for all sites, including cart fixtures | Mutating |
| `--mutations` | Disposable demo writes with run-owned accounts (see below) | Mutating |
| `--cleanup LEDGER` | Deletes the exact job recorded in a local ledger | Mutating (cleanup) |
| `--recover-reports LEDGER` | Reads reports from an earlier run | Read-only |

`--include-orders` is rejected before any Azure change. Exit codes: `0` pass, `1`
fail, `2` incomplete, `3` execution, upload or cleanup failure. See the
[standalone runner](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#standalone-private-network-suite-runner)
and the [disposable mutation profile](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#disposable-demo-mutation-profile).

`python3 -B tests/auth/mutation_suite.py --environment NAME [--output DIR]` runs
the same disposable mutations directly: fresh consumers, password rotation,
addresses and reviews. **Mutating**; it creates residual demo rows.

## Runtime identity probes

These check what the deployed managed identities can actually do. They need
permission to inspect the selected resources and to `exec` into the existing
containers, and they write sanitized evidence to `.auth-results/`.

| Command | Effect | Safety |
| --- | --- | --- |
| `python3 tests/scripts/test-runtime-rbac.py --environment NAME` | Runtime managed-identity permissions from inside the deployed containers | Read-only |
| `... --webpubsub-probe` | Sends one nonpersistent `utilities` group marker and checks delivery | Mutating (one message) |
| `... --keyvault-probe` | Reads signing-secret version metadata (never the value) and MCP startup logs | Read-only |
| `... --service-profile-probe` | Checks shared-runtime service scopes and read-only MCP tool limits | Read-only |
| `... --send-email` with `AUTH_RBAC_TEST_RECIPIENT` set | Sends one test email to an approved recipient; never retried | Email |
| `python3 tests/scripts/test-runtime-sql.py --environment NAME [--output DIR]` | Effective SQL permissions through the MCP runtime | Read-only |
| `python3 tests/scripts/test-functions-webpubsub.py --environment NAME` | A real Functions publisher with one table-row fixture that is removed afterwards; `--recover LEDGER` finishes an interrupted cleanup | Mutating (cleaned) |
| `python3 tests/scripts/diagnose-dab-capacity.py --environment NAME [--hours 6]` | DAB and SQL pressure and index-advisor evidence; no warm-up requests | Read-only |

See [SQL-only effective permissions](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#sql-only-effective-permissions)
and [telemetry and SQL principal evidence](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#telemetry-coverage-and-sql-session-principal-evidence).

## Browser runners

The `--browsers` and `--live` profiles and the private job supply credentials
privately; do not pass passwords on the command line. Each runner is a plain Node
program (not `node --test`) that requires `--output DIR`.

| File | Effect | Safety |
| --- | --- | --- |
| [`test-guest-cart-browser.mjs`](test-guest-cart-browser.mjs) | Anonymous cart, sign-in merge and account switch with two retained consumers; removes only the item it added | Mutating (cleaned) |
| [`test-internal-browser-auth.mjs`](test-internal-browser-auth.mjs) `--site admin\|manufacturing` | Internal portal sign-in, role gating and logout | Read-only |
| [`test-inspector-browser-auth.mjs`](test-inspector-browser-auth.mjs) `[--switch-diagnostic]` | Hosted MCP Inspector sign-in (see [hosted inspector authentication](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#hosted-inspector-authentication)) | Read-only |
| [`test-frontend-telemetry.mjs`](test-frontend-telemetry.mjs) | Loads the three frontends anonymously from `APP_URL`, `APP_ADMIN_URL` and `APP_MANUFACTURING_URL` and checks their Application Insights telemetry | Read-only (sends telemetry) |

The guest-cart and fixture lifecycle is in
[reusable demo consumer fixtures](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#reusable-demo-consumer-fixtures).
Fixture credentials stay in the local azd environment as
`AUTH_TEST_CONSUMER_A_*` and `AUTH_TEST_CONSUMER_B_*`; never publish
`azd env get-values` output.

## Deployed smoke and health checks

| Command | Covers | Safety |
| --- | --- | --- |
| `bash tests/scripts/test-health-diagnostics.sh` | Functions `/api/health` and `/api/health/readiness`, MCP `/health` and `/ready`, required dependency checks. Uses `API_FUNCTIONS_URL` / `API_MCP_URL` if set, otherwise azd. | Read-only |
| `bash tests/scripts/auth-smoke-tests.sh` | OAuth discovery, inspector login and consent, token audiences, allowed and denied MCP and Functions calls, help endpoints and one Generate Promotion call | AI cost |

`auth-smoke-tests.sh` needs `azd`, `curl` and `python3` (exit `2` if missing) and
exits `0` or `1`. Tunables: `SMOKE_TIMEOUT` (60 s), `SMOKE_CONNECT_TIMEOUT` (15 s),
`SMOKE_AI_TIMEOUT` (120 s), `SMOKE_RETRIES` (2), `SMOKE_RETRY_DELAY` (3 s),
`SMOKE_BODY_MAX` (4000) and `SMOKE_PARSE_MAX` (1048576). `SMOKE_DEMO_USER`,
`SMOKE_DEMO_PASS`, `SMOKE_ADMIN_USER` and `SMOKE_ADMIN_PASS` override the canned
Peter and Ken accounts; set them from a secure source and never print them.
The [health diagnostics guide](../../docs/features/monitoring/HEALTH_DIAGNOSTICS.md)
covers the readiness contract.

## Feature and legacy scripts

These predate the OAuth rollout or target one feature. Scripts that send no
bearer token only reach protected routes on a local Functions host where
`FUNCTIONS_OAUTH_MODE` is unset (enforcement disabled); the deployed Functions
app runs with it `enforced`.

| Command | Covers | Safety |
| --- | --- | --- |
| `FUNCTIONS_TOKEN=… TEST_BUSINESS_ENTITY_ID=… bash tests/scripts/test-password-functions.sh [functions-url]` | Password set and verify for one consumer, using that consumer's own Functions token | Mutating (overwrites the password) |
| `TEST_EMAIL=… TEST_BUSINESS_ENTITY_ID=… [RESET_TOKEN=…] bash tests/scripts/test-password-reset-flow.sh [functions-url]` | Generic 202 reset request (no token in the response), made-up token rejection and, when `RESET_TOKEN` is copied from the emailed link, completion and reuse rejection. Add `FUNCTIONS_TOKEN` and `CURRENT_PASSWORD` to check the old password works until completion. | Email; mutating with `RESET_TOKEN` |
| `bash tests/scripts/test-ai-chat-and-mcp.sh` | Same as `validate-auth.sh --chat` | Read-only (canaries: AI cost) |
| `node tests/scripts/test-chat-guardrails.mjs` | Storefront chat refusals and normal answers. Set `API_FUNCTIONS_URL`, `API_MCP_URL`, `CHAT_TEST_EMAIL` and `CHAT_TEST_PASSWORD` to a disposable consumer. | AI cost |
| `bash tests/scripts/test-product-comparison.sh` | Anonymous DAB GraphQL product reads for the compare page; reads `API_URL` from the selected azd environment unless `API_URL` is set | Read-only |
| `bash tests/scripts/test-search-suggestions.sh [query]` | Anonymous `/api/search/suggestions`; `API_FUNCTIONS_URL` defaults to the azd value | Read-only |
| `bash tests/scripts/test-robots-sitemap.sh` | Anonymous robots and sitemap; writes results under the repository's ignored `test-results/` (override with `TEST_RESULTS_DIR`) | Read-only |
| `bash tests/scripts/test-product-reviews.sh [api-url]` | Anonymous DAB `ProductReview` create and update; deployed DAB grants anonymous `read` only, so the writes are denied | Mutating (local only) |
| `bash tests/scripts/test-receipt-generation.sh [functions-url]` | Starts the receipt-generation orchestration (admin route; no token sent) | Mutating |
| `bash tests/scripts/test-send-email.sh` | Sends a customer email (admin route; no token sent) | Email |
| `bash tests/scripts/test-email-with-attachment.sh` | Queues an `order-email-generation` message using `STORAGE_ACCOUNT_NAME` (or the azd value) and `az storage`; the deployed storage account is private | Mutating, Email |
| `bash tests/scripts/test-ai-and-mcp-complete.sh` | Legacy AI and MCP walkthrough without tokens; superseded by [AI and MCP testing](../../docs/testing/AI_AND_MCP_TESTING_GUIDE.md) | AI cost |
| `bash tests/scripts/manual/test-manufacturing.sh [functions-url]` | Manufacturing runs and configuration | Mutating |
| `bash tests/scripts/manual/test-supply-chain.sh [functions-url]` | Supply orders and planning | Mutating |
| `bash tests/scripts/manual/test-supply-manufacturing-integration.sh [functions-url]` | Supply-to-manufacturing flow, including reset | Mutating |

The password scripts need a disposable consumer's token and `BusinessEntityID`,
not a canned internal identity. The reset token arrives only by email, and
reserved domains such as `@example.invalid` receive no email, so completion needs a
consumer with a deliverable address. See [passwords and reset](../../docs/features/customers/passwords-and-reset.md).

## DAB check scripts

`npx tsx tests/scripts/check-checkout-dab.ts`,
`npx tsx tests/scripts/check-product-photos-dab.ts` and
`npx tsx tests/scripts/check-sale-discounts-dab.ts` read DAB anonymously through
the helpers in [`tests/utils`](../utils/). `tsx` is not a repository dependency,
so `npx` downloads it. They cover only anonymously readable entities.
**Read-only.**

## Seed log mount authentication

```bash
python3 tests/scripts/test-seed-log-mount.py --environment NAME [--timeout SECONDS]
```

Verifies the seed job's Azure Files `/logs` mount uses the environment's
user-assigned identity over SMB OAuth, with Shared Key disabled. It starts two
bounded seed-job executions with overridden commands that write, read and delete
one probe file; the seed entrypoint does not run and the stored job template is
unchanged. It refuses to run while a seed execution is active. **Mutating (one
probe file, cleaned).** See [persistent seed logs](../../seed-job/README.md#persistent-seed-logs-managed-identity-smb-mount-preview).

To inspect an existing successful seed run without starting a job:

```bash
python3 tests/scripts/test-seed-sql-identity.py --environment NAME
```

This reads at most 64 KiB of one correlated seed log through the existing Admin
container and checks the seed identity's reported SQL connection. It starts a
process in that container but no job. **Read-only.**

## Seed SQL principal diagnostic

```bash
python3 tests/scripts/test-seed-sql-principal.py --environment NAME [--timeout SECONDS]
```

Starts one execution of the existing seed job, pinned to the image digest and with
mounts and seed settings removed, that runs a read-only SQL `SELECT` instead of
seeding. It checks the seed identity's SQL login, database CONTROL, the runtime
identity's roles and grants, and privileged role memberships. It does not reseed or
change the stored job template, and is not retried automatically. **Mutating (one
job execution); no data change.**

## Helper files

These are loaded by the runners above and are not run directly:
[`auth-browser-network-policy.mjs`](auth-browser-network-policy.mjs),
[`runtime-rbac-probe.cjs`](runtime-rbac-probe.cjs),
[`runtime-functions-push-fixture.cjs`](runtime-functions-push-fixture.cjs),
[`runtime-webpubsub-receiver.cjs`](runtime-webpubsub-receiver.cjs),
[`seed-sql-identity-probe.cjs`](seed-sql-identity-probe.cjs) and
[`seed-sql-principal-probe.ps1`](seed-sql-principal-probe.ps1). The assurance
engine and contracts are in [`tests/auth`](../auth/).

## Results, exit codes and source control

- Assurance runners write `report.json`, `junit.xml` and ledgers to the git-ignored
  `.auth-results/`. `--output` must name a directory that does not exist yet.
- Assurance exit codes: `0` all applicable checks passed, `1` a failure, `2`
  blocked (evidence unavailable). A blocked result is never a pass.
- Keep test source, contracts, runner Dockerfiles, Bicep and lockfiles in source
  control. Never commit `.auth-results/`, populated environment files,
  `local.settings.json`, browser state or generated frontend configuration.
- Interrupted mutating runs leave a ledger. Use the script's recovery option
  (`--cleanup`, `--recover`) with that ledger rather than deleting fixtures by hand.

## Troubleshooting

- **401**: missing, expired or wrong-audience token. DAB, Functions and MCP each
  need their own audience.
- **403**: missing scope, wrong category or an ownership rule. Check the
  [Functions route matrix](../../docs/features/functions-oauth/ROUTE_SCOPE_MATRIX.md)
  before switching identity; do not retry as a more privileged user.
- **Timeouts after idle**: Container Apps scale to zero and Functions cold-start;
  retry manually once. `auth-smoke-tests.sh` already retries.
- **`BLOCKED` results**: telemetry sampling, missing fixtures or an undeployed
  change. Deploy the source with `azd deploy` and rerun; never patch Azure
  resources to make a test pass.
- **`jq: command not found`**: `sudo apt-get install jq`.

## Adding a script

1. Name it `test-<feature>.sh`, `.mjs` or `.py` and resolve endpoints from azd or
   environment variables, never hard-coded hosts.
2. Get tokens with `azure-auth.py`; never print tokens or passwords or enable
   shell tracing while they are in scope.
3. Exit nonzero on failure and keep read-only probes on `GET` routes listed in
   [`safeFunctionReadRoutes`](#read-only-get-routes).
4. Clean up any fixture you create, and add a row with a safety label to this page.

## Related

- [Tests index](../README.md)
- [Testing strategy](../../docs/testing/testing-strategy.md)
- [Authenticated local scripts](../../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md)
- [Chat and MCP authentication testing](../../docs/testing/AI_CHAT_MCP_TESTING.md)
- [AI and MCP testing](../../docs/testing/AI_AND_MCP_TESTING_GUIDE.md)
- [End-to-end authentication](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md)
- [Health diagnostics](../../docs/features/monitoring/HEALTH_DIAGNOSTICS.md)
