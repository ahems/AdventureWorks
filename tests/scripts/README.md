# Test Scripts

This directory contains shell-based API and integration tests for the AdventureWorks application.

## Overview

These scripts test the AdventureWorks APIs and Azure Functions directly using curl and jq.

## Source control and local artifacts

Keep authentication test source, contracts, runner Dockerfiles/Bicep, dependency
manifests and lockfiles in source control. The root [.gitignore](../../.gitignore)
excludes local `.auth-results/` reports and ledgers, TRX/build logs, test-result
directories, browser reports, populated environment files and `local.settings.json`.
Environment examples/templates remain eligible for source control. Do not move
credentials or raw browser state outside ignored run directories.

Ignore rules do not remove files already tracked by Git. Generated frontend
environment/runtime configuration must not be checked in; keep the generators
and templates instead.

## Prerequisites

- Deployed Azure environment (run `azd up` first)
- `jq` installed for JSON parsing: `sudo apt-get install jq`
- Environment variables set (automatically configured by `azd env`)

## Available Test Scripts

### Review Authentication Regression Tests

- **[test-review-auth.mjs](test-review-auth.mjs)** exercises the real storefront
  review hook: anonymous/mismatched sessions, authenticated submissions, protected
  fields, response validation and voting guards. Run
  `node --experimental-vm-modules --test tests/scripts/test-review-auth.mjs`.
  The [auth assurance runner](validate-auth.sh) also includes these tests and
  deployed anonymous review-read/mutation-denial checks. See the
  [end-to-end guide](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md)
  for remaining consumer-fixture and server-side vote-integrity limitations.

### Health Diagnostics

- **[test-health-diagnostics.sh](test-health-diagnostics.sh)** - Read-only Azure
  smoke test for unchanged Functions/MCP liveness plus the sanitized readiness
  contracts, required SQL/storage/MCP/OAuth checks, and expected check IDs.
  Resolves endpoints from `azd` (or `API_FUNCTIONS_URL` / `API_MCP_URL` overrides).
  Run `bash tests/scripts/test-health-diagnostics.sh` from the repository root.
  Does not invoke models or mutate data; returns nonzero for required dependency
  failures or an incomplete readiness contract. Identity probes are optional.
- **[Health diagnostics guide](../../docs/features/monitoring/HEALTH_DIAGNOSTICS.md)** -
  Frontend regression tests, optional capability/data checks, limitations,
  deployment, and browser smoke-test steps.

### Local Hook Tests

- **[test_keyvault_firewall.py](test_keyvault_firewall.py)** - Offline tests of the
  postprovision certificate block with mocked Azure commands: temporary client-IP
  access, existing-rule preservation, cleanup on success/failure/interruption,
  selected-subscription targeting, fail-closed certificate inventory and
  non-retried creation, explicit cleanup errors, and IP validation. The hook
  regressions are included in offline assurance; the additional template test
  needs an installed Bicep compiler. Run
  `python3 tests/scripts/test_keyvault_firewall.py`; no Azure changes are made.

- **[test-live-updates.mjs](test-live-updates.mjs)** - Offline regression tests
  using the real frontend modules: initial reads, fixed-window burst batching,
  serialized in-flight follow-ups, job identity filtering, reconnect/focus
  recovery, once-per-instance utility completion, stale/unmounted response guards,
  socket availability, superseded Admin sessions and explicit errors. Included in
  offline authentication assurance. Includes a TypeScript AST guard against
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
- **test-ai-chat-and-mcp.sh** - Runs the authenticated, read-only consumer MCP
  assurance profile using retained fixtures. Add `--customer-agent-canary` for
  one paid customer-chat inference, or `--admin-agent-canary` for one paid
  read-only admin-chat inference with positive/negative scope controls. Both
  require trace-correlated tool authorization.
  Missing fixtures or telemetry remain BLOCKED. See
  [customer chat testing](../../docs/testing/AI_CHAT_MCP_TESTING.md).
- **test-product-comparison.sh** - Tests AI-powered product comparison features
- **test-search-suggestions.sh** - Tests semantic search and AI suggestions

### Email & Communication Tests

- **test-send-email.sh** - Basic email sending functionality
- **test-email-with-attachment.sh** - Email with attachment (receipt PDFs)
- **test-receipt-generation.sh** - Order receipt PDF generation

### Authentication Tests

- **Local offline assurance evidence** (no Azure calls or test-data mutations):
  Install the [assurance Python dependencies](../auth/container/requirements.txt)
  in an isolated Python environment first (see
  [prerequisites](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md)).
  ```bash
  python3 tests/auth/validate.py --offline
  ```
  This runs the source/Python/Node checks and the Functions/MCP .NET test projects.
  The current-run TRX files are consumed by exact-case gates for worker middleware,
  address/password/receipt ownership, all registered consumer handlers including
  guarded order headers, guest-cart expiry/retirement/merge lifecycle, and real
  MCP assertion validation, HTTP tool dispatch and persisted task ownership
  (subject/client/category/tool/scope, including demotion, current policy and legacy fail-closed state). Unit-test results
  do not prove deployed route bindings, SQL grants, or live workload exchanges.
- **Isolated Functions host**: add `--functions-host` to the offline command.
  Functions Core Tools (`func`), Azurite (`azurite`), `dotnet`, `openssl`,
  `unshare` and `ip` must be on `PATH`; Linux user/network namespaces must be
  permitted. The runner starts the real worker on loopback with ephemeral local
  signing metadata and disables every non-HTTP trigger. The current matrix
  passed 2,907 cases across 182 protected route/method bindings, including
  invalid tokens, missing expiration, unsupported HEAD/OPTIONS and six destructive
  operations against explicitly blocked test dependencies. Exact
  inventory and worker-digest reconciliation are required; this is not proof
  of deployed side effects or SQL ownership.
- **Read-only infrastructure inventory**: `python3 tests/auth/validate.py --infra`
  discovers deployed agent versions, workflow branches and tool edges. Each tool
  edge stays individually BLOCKED until its own runtime identity, authorization
  and effect are correlated; a configured allow-list alone is not runtime proof.
  The selected ACR is checked for its shared admin user, anonymous pull and enabled
  non-Entra repository tokens, independently of Container App and seed-job
  managed-identity pull bindings. Web PubSub local-key and Entra modes are also
  checked. The current deployment fails both local-key checks; the source changes
  take effect only after user-owned recreation.
  Communication Services' selected-resource local-auth setting is checked too;
  an omitted value is BLOCKED rather than assumed disabled, and the Functions
  email target must match the selected endpoint. Email send must be separately
  verified with an explicitly authorized recipient.
  Credential-bearing static agent headers fail, while other static headers require
  review; report evidence never includes their values. It also records sanitized
  Functions readiness probes individually: SQL catalog read, storage metadata/table
  reads, file-directory metadata, Web PubSub group existence, and MCP/OAuth
  reachability. Its optional SQL identity probe compares that connection's current
  external principal SID with the selected attached Functions managed identity.
  Optional Blob, Queue, Table, Files and Web PubSub identity probes bind the
  SDK token used for each successful read to that attached identity and the
  selected service endpoint. Missing, stale, unrecognized or failed probes remain
  BLOCKED. None proves complete effective RBAC or write/publish permissions.
  Configuration-only checks are inventoried as such, not counted as successful
  runtime access.
- **Safe live route and AI checks**: live/all probes only the reviewed Functions
  name-and-exact-route GET allow-list; unknown or potentially mutating GETs stay
  BLOCKED. The browser guards also deny unreviewed data-plane requests and use
  synthetic manufacturing status and supply-catalog responses, never real
  side-effecting status reads. The public Help-Me-Choose inference is disabled
  unless `--public-agent-canary` is supplied with `--live` or `--all`. First
  deploy the matching Functions source through normal `azd deploy`; reading the
  latest Foundry definition alone does not establish a worker's cached tools.
  The opt-in makes bounded, potentially billable AI calls. Correlation requires
  run-specific traces, a completed MCP result, the actually loaded agent version
  and the selected runtime principal's allowed `products.read` decision. The
  runner makes at most four read-only telemetry queries separated by 20 seconds
  and credits only exact matching current-run tool/version/target obligations.
  Missing or sampled telemetry, downstream SQL/embedding identity and other
  agent/tool paths remain BLOCKED.
- **DAB read matrix**: live/all discovers all GraphQL entity selectors and checks
  source-derived REST/GraphQL reads for anonymous, admin, manufacturing and both
  retained consumers under `consumer`/`authenticated`. Only one key column is
  selected; reports never include its values. Per-cell transport failures remain
  BLOCKED and do not erase the remaining matrix or become authorization denials.
- **Catalog/review field boundary**: live/all additionally checks real nonempty
  internal controls and up to 248 public-role REST/GraphQL field, selection,
  filter and ordering assertions. The updated redaction checks are source-tested
  but have not yet passed against the current deployment. Public inventory still
  exposes per-location IDs and quantities; public reviews still expose author IDs.
- **[test-order-detail-auth.mjs](test-order-detail-auth.mjs)**: verifies the
  storefront's owner-bound Functions batch, strict response validation and
  checkout's exact `POST /api/orders` route and owner-bound cart clear. Run
  `node --experimental-vm-modules --test tests/scripts/test-order-detail-auth.mjs`.
  The new order-detail read route and DAB denial checks require deployed
  verification; empty consumer histories do not prove nonempty SQL ownership.
- **[test-payment-methods-auth.mjs](test-payment-methods-auth.mjs)**: verifies the
  storefront uses the person-bound Functions route, consumes masked fields only,
  avoids unsigned reads and reports invalid/unmasked/error responses.
- **[run-auth-assurance-job.py](run-auth-assurance-job.py)** - Standalone manual
  private-network runner, **not an azd service or lifecycle hook**. After a successful
  application deployment, run:
  ```bash
  python3 tests/scripts/run-auth-assurance-job.py --preflight
  python3 tests/scripts/run-auth-assurance-job.py
  ```
  The default integrated run also executes the disposable mutation suite below;
  it retains run-owned business fixtures and inventories them in the report.
  For disposable-demo API mutations without rebuilding/reseeding the environment:
  ```bash
  python3 tests/scripts/run-auth-assurance-job.py --mutations
  # Direct deployed API iteration with local reports:
  python3 tests/auth/mutation_suite.py
  ```
  This mutually exclusive profile creates two fresh run-owned consumer accounts
  for its existing scenarios, plus two more if private Customer positive controls
  run. It rotates only the first two passwords, exercises address writes and DAB review policies,
  including owner-bound REST and GraphQL review creates, GraphQL-only vote
  updates and GraphQL/REST denied-write checks,
  and verifies persisted state/denied-write side effects. Valid review creates
  are denied for anonymous, forged-token, Functions-audience and cross-owner requests for both
  consumers; a positive-control public marker read and independent pre/post
  reads check for writes even after a denial-shaped response. The wrong-audience
  Functions token is independently validated against the owner's password endpoint.
  Updated source additionally requires create/read responses to omit reviewer
  email; that field-redaction assertion has not yet been run against the current
  deployment.
  GraphQL vote updates are also checked for anonymous, forged and
  Functions-audience denial against both owned fixtures, with pre/post full-record
  reads and a subsequent authenticated vote positive control.
  Known residual IDs and
  uncertain creates are inventoried; fixtures may intentionally remain. An
  immediate absent read cannot settle an unconfirmed denial, and address cleanup
  refuses to race an uncertain address write. It uses
  three distinct products for review positive and denial fixtures, avoiding the
  unique product/user constraint as a false authorization denial. It uses current
  lookup records, not global seed counts or a pristine-site assumption.
  Retained consumer credentials are not forwarded or modified. The private
  profile also checks actual SQL permission/default-metadata visibility, uploads
  all four report formats and verifies exact temporary-job deletion.
  Address-create host denial probes require private SQL: they count both
  marker-matched address rows and links before/after each request, including
  orphan rows. Direct runs report that scenario BLOCKED and do not send it.
  Category/subcategory create denial probes use unique names, four credential
  cases for both consumers, and independent public DAB marker reads. A filter
  positive control is required; any uncertain create remains inventoried.
  The source-tested Customer-create scenario requires private SQL and the ledger:
  it checks both owners across REST/GraphQL and `consumer`/`authenticated`, plus
  anonymous, forged and wrong-audience denials, with independent pre/post SQL
  reads. Four distinct accounts provide one positive per protocol/role and fresh
  Functions/DAB tokens are checked for the new customer claim. An exact gate
  requires the complete same-run checks and matching ledger records. It has not
  yet run against the current deployment; direct mode blocks before sending
  Customer creates.
  The private runner creates a uniquely named `awtest<hex>` table in the existing
  storage account and keeps it available for the mutation suite. Each fixture
  residual is persisted before its write request and updated after confirmation;
  the sanitized ledger snapshot is included in the private report before the
  exact table is deleted during cleanup. The ledger is not added to IaC and
  does not use an application table.
  No emails, paid AI, orders, simulator, seed reset or infrastructure repair runs.
  A successful targeted profile is not full-suite conformance. See
  [disposable mutation policy](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#disposable-demo-mutation-profile).
  For read-only shared-runtime SQL permission evidence only:
  ```bash
  python3 tests/scripts/run-auth-assurance-job.py --sql-only
  ```
  Uses private SQL and the existing UAMI to compare the actual external contained
  user's SID with the selected identity's client ID, verify reader/writer roles
  and database EXECUTE, and check administrative roles/database DDL rights are
  absent. It checks USER-scoped IMPERSONATE on visible impersonatable principals
  other than the current user, plus schema/object CONTROL/ALTER/TAKE OWNERSHIP,
  per-table SELECT/INSERT/UPDATE/DELETE and routine EXECUTE permissions without
  attempting DDL, reading business rows or mutating data. Null/empty permission
  evidence is BLOCKED, never absence of access. Each nonempty category reports
  observation counts and a sorted SHA256; failed/unknown detail is bounded.
  The existing shared broad data roles/database EXECUTE are explicitly reported
  as an accepted demo exception, not per-service/row-level least privilege.
  Grants held by other SQL principals, server-level grants, invisible metadata, executable-module
  escalation and per-service separation remain outside these checks.
  No consumer setup, application calls, browser/API suites or SQL fixtures run;
  consumer credentials are excluded from the SQL-only secure job configuration.
  All targeted modes are mutually exclusive. Reports and temporary compute cleanup
  use the same verified lifecycle as the full suite.
  To run just the deployed Chromium authentication scenarios from that same
  private fixture:
  ```bash
  python3 tests/scripts/run-auth-assurance-job.py --browser-only
  ```
  This executes storefront guest persistence/consumer sign-in and merge,
  Admin/Manufacturing login/renewal/DAB reads and the expanded Inspector two-user/
  two-tab/backend-session isolation matrix. It skips runtime .NET/API suites,
  reflected inventory/contracts, SQL probes and address fixtures. The shared image still
  contains their dependencies; browser-only is an execution scope, not a smaller
  image. All endpoints come from the selected local azd environment.
  The controller authenticates/prepares the retained demo consumers first.
  Browser logins use application-user credentials, not the job's UAMI.
  Only isolated storefront cart fixtures may be mutated, with exact retirement/
  consumer cleanup assertions; there are no orders, AI calls, simulator starts,
  email or broad resets. Results use the same PDF/HTML/JSON/JUnit Storage reports,
  checksums and verified temporary-job deletion. A targeted browser PASS does not
  close unexecuted API/RBAC/agent obligations. `--browser-only`, `--address-only`
  and recovery/preflight modes are mutually exclusive.
  For faster local diagnosis with installed Chromium, the identical scenarios
  can run without a container:
  ```bash
  python3 tests/auth/validate.py --browsers
  ```
  Verified private run
  `20261111T150002Z-5c65a0f0-68d0-4ce8-8cc3-db44188e824c` records
  **66 PASS, zero FAIL/BLOCKED** across all four sites, their aggregate gates,
  retained-consumer authentication and explicit scope checks. Exact guest/cart
  cleanup passed, all four Storage report formats were independently
  checksum-recovered and temporary compute deletion was verified. This is not a
  full API/RBAC/agent run or natural token-expiry certification.
  For the opt-in, bounded address ownership follow-up instead of the full suite:
  ```bash
  python3 tests/scripts/run-auth-assurance-job.py --address-only
  ```
  This uses the same standalone Bicep job, existing runtime UAMI, immutable image
  and timestamped private reports. It authenticates both retained consumers and
  an internal administrator. Read-only SQL verifies consumer email/owner
  matches, no existing links and no run-marker addresses before any writes.
  Five addresses are created through the consumer Functions API; the administrator
  links one to the other owner through DAB. The existing account's randomly named
  temporary test table records each request before it is sent. The application's
  first-address default applies only to the verified empty test accounts.
  If creating that table has an uncertain outcome, the run fails, does not
  start mutations or blindly delete the name, and identifies the exact table
  for ownership inspection and cleanup.
  Actual deployed reads must prove nonempty SQL pagination and own-record access;
  six bounded cross-owner PUT/DELETE/type requests must return the exact 403
  ownership error. Each owner also verifies an unchanged shared-address save
  succeeds and a physical change returns 409, with both owners' reads compared
  after each attempt. Any unexpected result stops subsequent writes.
  Read-only SQL checks fixture fields and links stayed unchanged. Cleanup uses
  only consumer API deletions, after verifying the exact recorded IDs, owners,
  foreign links and order references; SQL and both owner lists then verify absence.
  An uncertain setup/probe or failed safety check stops cleanup rather than racing
  a potentially in-flight write. Failures retain the recorded residuals and never
  trigger a blind retry. The private report preserves the suite's residual inventory
  even if the table snapshot is unavailable; a missing, malformed or inconsistent
  suite report, interruption or timeout fails the run because cleanup is unverified.
  Compute `--cleanup` does not remove application data.
  No direct SQL fixture writes, orders, simulator or email are performed.
  The revised API-created lifecycle completed against the selected deployment
  with **96 PASS, zero FAIL/BLOCKED**, including two-owner pagination, shared
  address behavior, REST/GraphQL link denials, verified application cleanup and
  temporary table removal. Its four private reports were independently recovered
  and checksum verified, and the exact job was absent. This targeted run is not
  complete authentication proof.
  An earlier opt-in private run
  (`20261111T141415Z-7a96c423-5957-4841-8cc2-43bcdccb6368`) passed all
  **29 assertions** using the old direct-SQL fixture setup. Its checksummed
  evidence is historical and does not validate the current API-created lifecycle.
  Reads the selected local azd environment (`--environment NAME` is optional).
  Requires az/azd, Git, the repository .NET SDK/test dependencies and deployer
  permissions for ACR builds, scoped ARM deployment, job execution/log reads and
  deletion of its own temporary job. The runtime UAMI receives no new roles.
  The command runs local read-only infrastructure inspection, prepares reusable
  consumer fixtures, builds a curated suite image in existing ACR, deploys the
  [standalone Bicep job](../../infra/testing/auth-assurance-job.bicep), runs the
  existing complete offline/live suite plus a real-UAMI private SQL probe, and
  uploads PDF/HTML/JSON/JUnit with readback checksums to the existing private
  `adventureworks-receipts/auth-assurance/<UTC timestamp>-<UUID>/` blob prefix.
  Reports explicitly preserve unfinished coverage; running all current tests
  is not proof that all planned tests exist.

  The full profile also runs eleven read-only MCP service-boundary checks using
  the private job's actual selected UAMI: exact catalogue-only grant and signed
  metadata, real catalogue output, direct/task-capable scope denials, resource
  audience denials and forbidden grant targets. It never uses deployer credentials
  as a workload, invokes models, starts successful tasks/orders or sends email.
  Tokens/records are not published. Dedicated browser/SQL/address/mutation modes
  omit this probe. Isolated tests cover the probe; a fresh private execution is
  still needed. The equivalent existing-admin-container diagnostic independently
  passed all eleven checks with its real shared UAMI; it is not actual
  Functions/hosted-instance origin proof. Probes accept the exchange URI and its
  well-known normalized application ID, matching the server validator exactly.

  Job deletion is attempted even after failure and verified by exact resource ID,
  run tags and environment. Interrupted cleanup can be recovered with
  `python3 tests/scripts/run-auth-assurance-job.py --cleanup /absolute/path/to/lifecycle.json`.
  The ignored local ledger records upload and cleanup outcomes separately.
  Reports remain after compute deletion; returned Storage locations are private,
  not anonymous download links. Download an existing run without creating or
  deleting any Azure resources:
  ```bash
  python3 tests/scripts/run-auth-assurance-job.py --recover-reports /absolute/path/to/lifecycle.json
  ```
  This executes the bounded read-only [report reader](../auth/read-reports.cjs)
  inside the existing admin container, using its attached runtime UAMI to reach
  private Storage. It requires `az containerapp exec` permission and a responsive
  existing admin container, not public Storage access or account keys.
  All four artifacts must match the private checksum manifest, exact run/prefix,
  immutable image provenance and consistent assertion counts before any local
  report directory is created. Downloads are limited to 1 MiB combined and
  saved in a new mode-0700 directory with mode-0600 files. The original controller
  error is preserved; upload recovery does not erase test failures or blockers.
  Cleanup reconciliation only reads the exact job's absence; recovery never
  deletes compute. Its exit code remains the recovered report's actual outcome.
  No storage provisioning, azd hooks, seeding, reset or email is invoked.
  `--include-orders` currently fails before any Azure changes: server-enforced
  budgets, isolated test simulators and persistent no-email lineage are still
  prerequisites, not implemented safety guarantees.
  Exit codes: `0` implemented assertions pass with no required blockers; `1` test
  failure; `2` incomplete coverage; `3` execution/upload/cleanup failure.
  If the private container cannot start or upload, only a local failure ledger
  can be guaranteed. A cloud report is never fabricated for an unstarted suite.
  Temporary job names are bounded to Azure's 32-character limit; the full run UUID
  remains in tags, the lifecycle ledger and the report prefix for exact ownership
  checks. The first live attempt built its image but failed job provisioning because
  its name was too long; cleanup was verified and no cloud test report was produced.
  The second user-started run executed privately and persisted all four artifacts.
  The controller encountered CLI corruption of nested JSON log quotes; text log
  parsing is now regression-tested. Read-only recovery verified the private blobs
  and confirmed the exact job absent. That report records **420 PASS, 43 accepted
  exceptions, 144 BLOCKED and 2 FAIL**, not successful full assurance. Both failures
  concern the initial Admin browser read and its aggregate scenario. A later
  targeted browser run passed all 20 checks; it does not overwrite the failed run
  or establish the intermittent failure's root cause.
  A third user-started run parsed its completion marker automatically and produced
  **437 PASS, 43 accepted exceptions, 144 BLOCKED and 3 FAIL**. Inspector's checks
  passed; the initial Admin DAB read still timed out at 90 seconds. Private report
  recovery verified all four artifacts and exact compute absence. The cleanup
  wrapper now accepts successful empty stdout specifically for job deletion,
  rather than rejecting it as malformed JSON, while all read commands remain
  strict. Sanitized cleanup errors are retained separately in future ledgers.
  Subsequent runs verified the corrected lifecycle. After user-owned recreation
  and successful seeding, integrated run
  `20261111T201813Z-aee0e713-8a81-49cc-9f7f-3964a0fb6811` recorded
  **491 PASS, 43 exceptions, 149 BLOCKED, zero FAIL**. After reconciling four
  local unit gates with their passing private-suite evidence, repeat run
  `20261111T204312Z-60376666-131e-434b-ab59-3e24f6ad0008` recorded
  **491 PASS, 43 exceptions, 145 BLOCKED, four NOT_APPLICABLE, zero FAIL**.
  The expanded integrated run
  `20261111T213955Z-47691dba-b9ee-49cb-b114-7e62f802583d` recorded
  **637 PASS, 44 exceptions, 140 BLOCKED, four NOT_APPLICABLE, zero FAIL**,
  including the disposable mutation checks. Reports and exact job deletion
  were independently verified for all three runs.
  The subsequent integrated run
  `20261111T225808Z-06217c4d-0875-49e6-8dc5-2afbd1849bee` recorded
  **678 PASS, 44 exceptions, 139 BLOCKED, four NOT_APPLICABLE, zero FAIL**;
  its `CreateAddress` gate passed using private SQL absence evidence. All four
  reports and exact job deletion were independently verified.
  The latest integrated run
  `20261111T235302Z-9bdba3c2-cbd4-47b5-90f8-d7743426fc66` recorded
  **688 PASS, 44 exceptions, 138 BLOCKED, four NOT_APPLICABLE, zero FAIL**;
  its reviewed read-only subcategory-count POST authorization gate passed.
  All four reports and exact job deletion were independently verified.
  The subsequent integrated run
  `20261112T004345Z-b2ec7424-838d-43cf-b45c-459b86a4887e` recorded
  **740 PASS, 44 exceptions, 136 BLOCKED, four NOT_APPLICABLE, zero FAIL**;
  both category-create gates passed with 50 exact supporting checks. All four
  reports and exact job deletion were independently verified. A later direct
  run separately passed all 50 checks after marker-pagination hardening, while
  remaining BLOCKED for the private-only address-create scenario.
  Counts include repeated phase-specific obligations and are not unique coverage gaps. See the
  [assurance status](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#target-and-assurance-status)
  for remaining limitations.
  The full live suite also exercises the reviewed read-only
  `GetSubcategoryProductCount` POST with an admin positive control and denied
  token/scope/category cases; it does not treat arbitrary POST routes as safe.

- **[validate-auth.sh](validate-auth.sh)** - Runs reflected Functions/MCP inventory, auth unit tests, azd-driven infrastructure checks and safe live probes. See the [end-to-end auth guide](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md). Reports explicit failures and missing coverage; it does not claim complete assurance or start unsafe simulator runs. Run with `--offline`, `--infra`, `--live` or `--all`.
  Live Web PubSub checks include one authorized WebSocket upgrade and an anonymous
  denial. They do not publish messages or record capability URLs.
  Infrastructure checks include exact-name, aggregate-only guest-cart cleanup
  timer telemetry over the last 24 hours. Successful sampled invocations are not
  proof of SQL expired-row selection, batch size or deletion effects; no samples
  remain BLOCKED. No timer is triggered or database fixture created.
  Receipt reads validate existing order/customer ownership before blobs; generation
  binds the persisted order/customer/email and awaits enqueue confirmation, with
  worker revalidation before delivery. Live checks use existing order metadata,
  redacted status/download results, foreign-owner denials and a reviewed all-zero
  generation payload that cannot enqueue. Valid email work remains BLOCKED.
  CI requires exact current-run deterministic gates, including the 20-case
  receipt gate and closure over all 17 registered consumer handlers; isolated tests do not
  substitute for real SQL/side-effect proof.
  Live/all also derives every explicit DAB business role and checks each
  ungranted role header for all four signed callers over REST and GraphQL.
  The read-only target passed 48 exact 403 decisions plus two fixture logins;
  this does not prove positive access for other departments.
  The live profile makes one bounded Admin `GeneratePromotion` Foundry call after
  anonymous, wrong-audience and insufficient-scope denials. It reads product data
  but does not create business records, send email or invoke tools; generated
  content is never included in the report. This is one AI inference per live run.
  The Inspector browser scenario now requires real manufacturing/admin sessions,
  shared-tab logout, independent role/session isolation, actual cross-user/target
  MCP-session replay denials and owner-session survival/cleanup: **30 assertions
  plus the aggregate gate**. It passes locally against the deployed endpoints
  with installed Chromium, with no business mutations. Missing/old evidence
  cannot satisfy the new gate. Initial anonymous reads use the measured shared
  startup allowance; the hosted Inspector client has an explicit 240-second
  bounded MCP deadline instead of its pinned ten-second default. Natural deployed
  token expiry remains separate; private execution of the expanded scenario is
  verified in the 66-PASS browser-only fixture run above.
  Offline/all now requires exact current-run Functions middleware TRX cases for
  every reflected HTTP policy, not inventory classification alone. The real
  worker middleware/RSA-token matrix currently passes 752 cases. Address and
  password-handler cases have exact current-run TRX gates. Live/all also adds reviewed GET-only host
  scope/audience/forged-header/consumer denials requiring the actual JSON error
  and canonical bearer challenge. Complete host/mutation-side-effect and
  ownership coverage remains separate; no simulator is started. Live/all now
  checks both retained consumers' address/person-address reads and, when address
  fixtures exist, actual own-record success and exact other-owner denial.
  The targeted deployed address run is 4 PASS/2 BLOCKED: both consumers have no
  addresses, so empty reads are not record-ownership proof. It does not create
  linked address fixtures before their cleanup path is verified.
  Password checks use only `POST /api/password/verify`: both retained consumers'
  correct/incorrect own-password results and exact other-owner denials. Responses
  must have the expected status and strict boolean/ownership-error shape;
  unexpected results stop remaining password reads. No passwords are set/reset,
  accounts created or payloads/credentials exported. The targeted deployed run
  passed nine checks, including fixture logins and current-run handler evidence.
  Fake password writes cover handler ownership and internal customer-type checks,
  not actual SQL mutation or deployed reset lifecycle.
- **[diagnose-dab-capacity.py](diagnose-dab-capacity.py)** - Read-only DAB/SQL
  diagnostics without warming APIs or changing idle-cost settings:
  `python3 tests/scripts/diagnose-dab-capacity.py [--environment NAME] [--hours 6]`.
  Discovers resources from azd and writes timestamped private local JSON under
  `.auth-results/`: per-replica CPU/memory, replicas/restarts, SQL CPU/IO/workers/
  sessions, CreateIndex advisor counts/states and sampled DAB SQL dependency
  durations. No SQL text, DDL, business records or secrets are exported.
  Five consecutive minute maxima at 80% or higher, a restart, active index advice,
  or slow/failed sampled SQL calls require review. Missing evidence is BLOCKED.
  Exit codes: 0 observations collected (not certification), 1 review required,
  2 unavailable evidence. It does not resize, add indexes or keep services awake.
- **[test-internal-browser-auth.mjs](test-internal-browser-auth.mjs)** - Invoked by
  the authentication suite's live profile with selected-environment endpoints and
  seeded internal identities supplied privately in the child environment. Real
  Admin/Manufacturing PKCE/deep-link login, role/audience/owner binding, DAB read,
  refresh and logout, including two-tab logout and a same-user new-generation
  sign-in that an existing stale tab cannot adopt; intercepts business mutations
  and MCP tool POSTs. Refresh
  uses controlled client expiry metadata, not server clock changes. Produces
  sanitized assertions, never tokens, passwords or raw browser traces. Bounded
  Chromium probe/preflight/routing/failure and DNS/connect/send/header timings
  are retained, together with generated W3C trace IDs for server correlation.
  Published diagnostics whitelist fields and values; no URLs, raw headers or
  records are exported. Anonymous API attempts are reported only as
  site/service/method. Two later local-container runs passed all 20 checks,
  but one initial Admin read still took 76,150ms. This is diagnostic evidence,
  not a resolution of the private timeout. The shared
  [browser policy](../auth/browser-policy.json) now allows 240 seconds for an
  initial deep-link/login redirect and initial read, 90 seconds after renewal,
  and a bounded 1,200-second child process deadline. Slow reads (30 seconds or longer) are flagged, not
  automatically attributed to cold starts. There are no retries or warm-up calls;
  denial, invalid data, over-budget reads or mutation attempts still fail.
  The new policy passed all 20 real deployed checks locally (Admin initial read
  75,407ms, other reads 72-219ms); the full private suite has not been rerun.
  Requires
  Playwright Chromium and its OS dependencies (included in the standalone image).
  Does not establish Inspector, user-switch or complete browser coverage.
- **[test-internal-session-races.mjs](test-internal-session-races.mjs)** - Offline,
  deterministic Admin/Manufacturing OAuth and mounted-context tests for overlapping
  login, callback, logout, token refresh, resource exchange and account switching.
  Exercises real React Query cache removal and late reads, stale logout callbacks,
  and Admin conversation isolation between sessions.
  Run with `node --experimental-vm-modules --test tests/scripts/test-internal-session-races.mjs`.
  This does not replace deployed real-browser and cross-tab verification.
- **[test-internal-request-sessions.mjs](test-internal-request-sessions.mjs)** -
  Offline Admin/Manufacturing DAB, Functions and Admin agent checks for session
  switches during token acquisition and requests, same-session retry and anonymous
  passthrough. Run with
  `node --experimental-vm-modules --test tests/scripts/test-internal-request-sessions.mjs`.
  The offline assurance profile includes these and Manufacturing socket/DAB tests.
- **[test-internal-session-browser.mjs](test-internal-session-browser.mjs)** -
  Local Chromium two-tab tests against the actual portal token modules with a
  loopback mock OAuth server. Run with
  `node --test tests/scripts/test-internal-session-browser.mjs`; requires the
  existing Playwright Chromium installation. This does not contact Azure and
  does not replace deployed full-portal browser verification. The live and
  browser assurance profiles also run and report this local check.
- **[test-inspector-browser-auth.mjs](test-inspector-browser-auth.mjs)** - The
  live/all assurance profile supplies azd-derived endpoints and the seeded
  manufacturing login privately. Fifteen real Chromium checks exercise hosted
  Inspector OAuth, both UI target connections, delegated read/catalog access,
  role-escalation/target/STDIO/Origin denials and logout replay. It blocks business
  mutations and never exports tokens, browser traces or records. Requires the
  same Playwright prerequisites as the internal-site scenario. Inspector gateway
  offline tests run with `npm --prefix mcp-inspector test` and are included in
  the offline suite/container image. See
  [hosted Inspector authentication](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#hosted-inspector-authentication)
  for the server-held tokens, bounded session expiry and deliberate transport limits.
- **[test-runtime-rbac.py](test-runtime-rbac.py)** - Executes the real
  [runtime probe](runtime-rbac-probe.cjs) in the existing admin container using its
  actual shared UAMI. Checks denied Storage/ACR management reads and successful
  deployed-image manifest pull. Default is read-only. Run
  `python3 tests/scripts/test-runtime-rbac.py --environment <environment>`.
  With separate approval, `--send-email` and `AUTH_RBAC_TEST_RECIPIENT` opt in to
  one controlled email and operation-status polling; no automatic send retries.
  `--webpubsub-probe` separately opts in to one nonpersistent `utilities` group
  marker. It connects an authenticated admin WebSocket, sends once from the
  existing admin container's selected UAMI, and requires receipt of the matching
  marker. This can invalidate active admin utility caches, but creates no order,
  email or business record. It proves this runtime identity's group send, not an
  actual Functions mutation or every group. Repeat after infrastructure recreation.
  Run this additional check with:
  ```bash
  python3 tests/scripts/test-runtime-rbac.py --environment <environment> --webpubsub-probe
  ```
  Reports never contain recipient, tokens or response bodies. An uncertain
  invocation must be investigated before repeating a send; a report explicitly
  stating the runtime probe source was not sent means no send was attempted.
  Service `Succeeded`
  is not independent mailbox delivery proof. Offline safety tests:
  `node --test tests/scripts/test-runtime-rbac.cjs`.
- **[test-runtime-sql.py](test-runtime-sql.py)** - Builds the existing read-only
  SQL permissions probe and executes it in the existing MCP container using its
  actual shared UAMI. Run `python3 tests/scripts/test-runtime-sql.py` after restoring
  the private probe's .NET dependencies. It requires Container Apps exec access,
  verifies removal of its uniquely named temporary runtime files, and never
  changes SQL, Azure resources or business records. Cleanup uncertainty is
  BLOCKED. Its scope excludes private DNS, other principals, server grants and
  invisible metadata; shared reader/writer/EXECUTE access remains an exception.
- **[reconcile-runtime-rbac.py](../../scripts/utilities/reconcile-runtime-rbac.py)** -
  Plan-only by default; `--apply` retires at most the four exact legacy runtime
  bindings after verifying narrow email and AcrPull replacements. The provisioning
  hook invokes this for upgrades because incremental ARM cannot delete removed
  declarations. Uses azd discovery, verifies preservation, writes an ignored
  removal ledger, leaves unrelated/admin grants and obsolete unassigned custom
  definitions untouched, and fails on unexpected definitions. Does not provision,
  seed, reset or delete resources. Run
  `python3 scripts/utilities/reconcile-runtime-rbac.py --environment <environment>`
  to inspect first. Offline tests:
  `python3 -m unittest discover -s tests/auth -p 'test_*.py'`.
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

# Run read-only consumer MCP checks; the paid chat canary is opt-in
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
## Guest cart authorization regressions

Run `node --experimental-vm-modules --test tests/scripts/test-guest-cart-auth.mjs`
from the repository root. Tests exercise the actual storefront transport and
session module, including malformed/expired sessions, cross-tab bootstrap,
Functions audience selection, logout isolation, failed-merge proof preservation,
merge deduplication, origin/redirect restrictions and strict response handling.
The authentication assurance runner includes these tests. Its guest-isolation scenario
creates two isolated guest carts, verifies cross-owner denial and DAB denial,
then retires those exact sessions. The sanitized cleanup ledger contains cart
IDs/expiry only, never guest capabilities. No order, email or AI call is involved.

`test-cart-provider-auth.mjs` exercises the real provider with deterministic hook
lifecycle scheduling: automatic merge, proof-retirement/render races, merge
retries, stale account-switch failures and logout cache eviction.

The live assurance profile also runs `test-guest-cart-browser.mjs` against the
azd-discovered storefront and Functions URLs. Chromium verifies anonymous add,
persisted quantity, reload, sign-in-only checkout, actual consumer sign-in and
automatic merge/proof retirement. With two retained consumer fixtures it signs
out of A, signs into B in the same browser session, proves A's resource tokens
were cleared and B's Functions token resolves only B's unchanged cart. It selects
a product absent from A's initial cart and removes only the confirmed new item,
after verifying the remainder still matches the exact baseline. If ownership
or cleanup is uncertain, it fails without a speculative delete. A newly opened tab remains unauthenticated
without affecting the active tab's session.
The Playwright development dependency is declared in the storefront; install
its Chromium/OS prerequisites when missing. The browser runner blocks non-cart
data-plane requests outside its reviewed policy and writes no capability tokens
to its JSON evidence. A partial anonymous-only or single-consumer run cannot
satisfy the full browser gate.

The approved demo-only live profile creates two reusable consumer users on first
use. Credentials/pending setup state stay in the ignored, mode-0600 local azd
environment (`AUTH_TEST_CONSUMER_A_*` / `AUTH_TEST_CONSUMER_B_*`); they never
appear in reports or CLI arguments. Do not publish `azd env get-values` output.
The API scenario separately proves real two-owner authorization, DAB read policies,
read-only token scope denial, atomic quantity combination, retry idempotency and
overflow rollback. Its exact account/guest fixtures are cleaned; users are retained.
The latest isolated deployment run passed all 33 checks and verified both
consumers' original carts and both guest retirements. The earlier integrated
run timed out on a read despite confirmed cleanup; its BLOCKED result is retained.
The runner records account and DAB write attempts before sending them. Timeouts,
malformed responses and nonterminal or unreviewed HTTP statuses leave writes
uncertain and prevent cleanup that could race them; inspect the sanitized ledger
instead of blindly retrying or deleting fixtures.
Signup sends no email, and these scenarios create no order, review or AI invocation.
See the [authentication guide](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md)
for fixture lifecycle, remaining blockers and RBAC findings.

## Seed log mount authentication

Run `python3 tests/scripts/test-seed-log-mount.py --environment <azd-environment>`
to verify the existing Azure Files `/logs` mount uses the ACA environment's
existing user-assigned identity with SMB OAuth and Storage Shared Key disabled.
Two bounded execution overrides write/read/delete only one unique probe file;
the seed entrypoint is never invoked and the stored job template is unchanged.
Existing logs and SQL data are not modified. The test refuses an active seed job
and records exact executions and cleanup under ignored `.auth-results/`.
See the [seed logging guide](../../seed-job/README.md#persistent-seed-logs-managed-identity-smb-mount-preview)
for preview requirements and failure recovery. The offline assurance profile
includes its seed configuration/probe regression tests; this live probe is an
explicit separate command rather than silently starting jobs during read-only
infrastructure validation.
