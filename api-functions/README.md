# AdventureWorks Azure Functions (`api-functions`)

This project contains the serverless backend for the AdventureWorks e‑commerce demo. It runs as .NET 10 isolated Azure Functions on Azure Functions Flex Consumption and complements the Data API Builder (`api/`) and Static Web App frontend (`app/`). The .NET project is published directly by `azd` (`host: function`); no Functions container image is built or deployed.

High‑level responsibilities:

- Expose HTTP APIs that are not a good fit for DAB (AI, receipts, email, SEO, passwords).
- Run durable/background workflows for AI enrichment, translations, and document generation.
- Integrate with Azure OpenAI / Azure AI, Azure Storage (Blobs & Queues), Azure Communication Services, and Azure SQL via managed identity.

> **Note**: Function _names_ below refer to the `[Function("...")]` attribute and may differ from class or method names.

## SQL connection and idle-cost behavior

Most Functions open SQL connections only while handling an HTTP request, queue message, or scheduled job. Two SQL Change Tracking listeners are different: `OrderPlacedSqlTrigger` observes `Sales.SalesOrderHeader`, and `DatabaseChanges` observes `dbo.RealtimeNotificationOutbox`. Transactional SQL triggers write small change signals to this shared outbox for direct DAB mutations across the cart, order details, manufacturing, inventory, catalog, reviews, purchasing and finance tables. Each listener has one Flex always-ready instance (two total), rather than an instance per source table. Consequently, the deployed Functions app can keep the serverless Azure SQL Database online even when all user-facing Container Apps have scaled to zero. This server-side observation is not frontend polling.

The SQL Database still has serverless auto-pause enabled, but auto-pause requires zero sessions and zero user-workload CPU for the configured delay. The hourly `OrderDelivery_Timer`, weekly `ArchiveTransactionHistoryTimer`, and daily `CleanupDatabaseNotifications` are additional scheduled SQL callers that can wake the database periodically. `ShoppingSimulator_Timer` does not query SQL when the simulator is stopped; it checks state in Table Storage and returns.

For the demo's normal intermittent usage, the no-code workaround is to delete the environment when finished and redeploy it before the next session:

```bash
azd down --no-prompt
azd up --no-prompt
```

See [infra/README.md](../infra/README.md) for the lifecycle guidance and the future queue/outbox, separate-function-app, and timer-disable options. Removing the always-ready setting without replacing the trigger is unsafe because new order events can be missed when the listener scales to zero.

---

## Web PubSub changes and polling-free frontends

All three frontends subscribe once at their app root. Events are change signals,
not data snapshots: clients batch them into authorized reads/cache invalidation.
Do not add recurring frontend requests or manual refresh controls as a fallback.
Connections/reconnections and visible-tab focus recover missed snapshots; failed
connections show a stale-data notice.

Backend event contracts:

| Group | Event | Payload |
| --- | --- | --- |
| Existing domain groups | `state-changed` | `entity`, `changeType`, sent after successful Table Storage persistence |
| Matching domain groups | `database-changed` | `entity`, `changeTypes`, observed SQL/DAB changes |
| `reviews` | `generation-state-changed` | `productId`, `changeType`: `started`, `progress`, `terminal` |
| `reviews` | `moderation-state-changed` | `jobId`, `changeType`: `started`, `progress`, `terminal` |
| `utilities` | `utility-status-changed` | `instanceId`, `jobType`, `changeType`, reflecting persisted Durable runtime status |

Table-backed publishers cover simulator starts/stops/results/queue counters,
pipeline and promotion configuration, manufacturing/workforce/warehouse state,
vendors/materials, agent runs/proposals and finance. Review publishers include
failure/terminal states and abandoned-job expiry, not just generated-item progress.
Direct-DAB observers cover cart writes as well as operational/catalog changes;
cart notifications do not broadcast customer/cart identifiers. Never broadcast
tokens, Durable management URLs, or private record bodies.

The outbox stores only a notification ID, entity name, change type and UTC creation
time. SQL triggers participate in the originating transaction, so rolled-back
mutations do not publish. The listener batches rows by entity and preserves the
existing domain groups. Daily cleanup deletes up to 10,000 rows older than seven
days; deletion of expired signals does not generate frontend invalidations.

SQL writes to these trigger-enabled tables must use `OUTPUT ... INTO` followed
by a `SELECT` when returning inserted IDs or updated rows. SQL Server rejects a
bare `OUTPUT` result set on a table with enabled DML triggers. This applies to
B2B order details, generated reviews, work orders and promotion expiry.

The utility observer requeues active instances with a three-second visibility
delay (actual cadence also includes queue polling/processing). It stops when the
persisted runtime status is `Completed`, `Failed`, `Terminated`, or legacy
`Canceled`. Pending/running/suspended instances continue to be observed: this is
lifecycle-bounded, not a wall-clock timeout. Failed observer invocations use the
host queue policy: five attempts, thirty-minute retry visibility, then poison.
Monitor the poison queue and explicitly resume/terminate stuck or suspended jobs.
Publishing is best-effort; reconnect/focus status reads recover missed signals.

### Deployment order

1. Provision the updated storage module, including `utility-status-queue` and its
   poison queue. Application code does not create storage infrastructure.
2. Run the updated seed provisioning/grants before deploying Functions. It creates
   the outbox and idempotent DML triggers, enables Change Tracking on the outbox,
   and precreates the two listener lease tables with runtime permissions. For an
   existing database use the private-network seed job's
   `-RealtimeNotificationsOnly` mode; it does not reseed data or import overlays.
3. Drain existing **unversioned** Durable utility instances before rolling out
   polling-free utility views. Existing histories retain their old orchestration
   version; new HTTP starters explicitly use `push-v1`. Any future starter for a
   dormant utility orchestrator must also specify `push-v1`. The host-wide Durable
   `defaultVersion` must be `push-v1`, with `versionMatchStrategy: CurrentOrOlder`.
   This accepts both new versioned instances and older/unversioned histories;
   the orchestration code gates new lifecycle activities on `context.Version`.
   Leaving the worker version unset causes versioned jobs to remain Pending.
4. Publish Functions, then deploy the three frontends. Do not treat old deployed
   publishers as proof that the updated clients have complete live coverage.

To drain old utility runs, pause new submissions and record their existing
instance IDs. Check each retained status URL or use this authenticated one-off
read from the repository root (set `INSTANCE_ID` to an existing run):

```bash
python3 scripts/utilities/azure-auth.py request \
  --identity admin --resource functions \
  --path "/api/TranslateLanguageFile_Status?instanceId=$INSTANCE_ID"
```

Resume or explicitly terminate suspended/stuck instances through their existing
controls, then confirm terminal status. Do not purge active histories. Keep the
old clients' monitoring until these unversioned instances are drained; they remain
replay-compatible but do not receive the new utility lifecycle events.

SQL listeners have server-side observation costs, and high-rate simulations can
exhaust Web PubSub Free-tier message quotas. Connection failure remains explicit;
do not silently reintroduce frontend polling.

Both SQL-trigger function names must remain in the Flex `alwaysReady` list in
`infra/modules/flex-api-functions.bicep`. A new listener on a separate table
requires its own scale group; prefer extending the outbox's fixed entity/group
mapping and seed migration rather than adding per-table bindings.

### Verification

- [Offline live-update regression tests](../tests/scripts/README.md#local-hook-tests)
  cover event bursts, in-flight follow-ups, instance filtering, reconnect/focus,
  terminal completion, cleanup, socket errors and the no-polling source guard.
- After deployment, use the
  [authenticated Azure helper](../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md)
  with Ken for admin checks and Peter for manufacturing checks.
- In two authorized browser clients, mutate a cart/order/work order in one and
  verify the other updates without timers or refresh buttons. Check simulator
  auto-stop/failures and review/Durable success/failure/termination as well.
- Disconnect/reconnect Web PubSub and return to a background tab to verify
  snapshot recovery. With the page idle after initial requests/retries settle,
  verify no recurring fetch/XHR requests for at least 65 seconds. Local elapsed
  clocks are allowed and must not request data.

Backend/seed/infrastructure checks from the repository root:

```bash
dotnet test api-functions.Tests/api-functions.Tests.csproj \
  --no-restore --nologo -v:q \
  --filter 'FullyQualifiedName~RealtimePublisherTests|FullyQualifiedName~DependencyHealthServiceTests|FullyQualifiedName~FunctionAuthorizationRegistryTests'
pwsh -NoProfile -File seed-job/tests/Test-RuntimeDatabaseAccess.ps1
pwsh -NoProfile -File seed-job/tests/Test-SeedLifecycle.ps1
python3 -B -m unittest discover -s seed-job/tests -p test_seed_deployment.py -q
az bicep build --file infra/modules/storage.bicep --stdout > /dev/null
```

---

## Manufacturing instruction illustrations

`GET /api/manufacturing/illustrations/export` reads every non-null
`Production.Illustration.Diagram` and deterministically converts its XAML into SVG.
`POST` to the same endpoint converts a JSON array of
`{ "illustrationId": 3, "diagram": "<Viewbox ...>...</Viewbox>" }` records instead.
Both require a Functions-audience internal token with `manufacturing.read`.
Neither changes the database, creates storage resources, calls an AI model, or
modifies the running frontend container.

The response is `{ "illustrations": [{ "illustrationId": 3,
"fileName": "illustration-3.svg", "svg": "<svg ...>...</svg>" }] }`.
IDs must be unique and positive (maximum 500 records per request). Unsupported XML,
elements, attributes, or geometry fail the complete conversion with HTTP 400;
external entities and DTDs are prohibited. The supported Illustrator-export
subset is Viewbox/Canvas/Path, ARGB colors, circular radial and linear gradients,
matrix gradient transforms, and stroke-width-relative dash arrays.

To write the results into the manufacturing frontend's bundled assets:

```bash
# Supply API_FUNCTIONS_URL and FUNCTIONS_ACCESS_TOKEN via your environment.
cd app-manufacturing
npm run illustrations:export          # Export illustrations currently in SQL.
npm run illustrations:export -- --csv # Convert Illustration.csv and optional Illustration-ai.csv.
```

The script saves assets in `app-manufacturing/public/illustrations/`. Run it before
building/deploying the manufacturing app; Vite includes that directory in the
container image. Existing assets are regenerated by ID. It does not delete other
assets. All output names are validated before any files are written.

The instruction viewer lives at `/define/models/:id/instructions`, reads live
`ProductModel.Instructions` through DAB, and embeds figures from `<diag>` references
(which are more complete than the original association table). It is linked from
models, product details, and planning/execution work orders. Models without
instructions show an explicit unavailable state. Work-order links may include
`#work-center-{LocationID}`. The viewer preserves source prose and step order,
supports zoom/printing, and does not poll.

Generated figure legends resolve product numbers to real product-detail links,
with BOM and inventory actions only when corresponding data exists. Product
entry points retain the selected variant via `?productId=...`; the viewer shows
its size/colour and effective BOM separately from the model-wide schematic.
Representative comparisons use current component IDs, quantities and units,
not inferred substitutions or historical BOM reconstruction.

Work orders also offer a read-only workstation reader at
`/execute/work-order/:id/instructions`. It defaults to the active operation,
then the first unfinished operation, then the first operation for completed
orders. `?operation=...` selects an explicit routing sequence, including repeated
work centers. Viewing another operation never advances production. Missing
routing or instruction sections retain access to the full document. These
views use existing Web PubSub cache invalidation rather than polling.

Future AI enrichment should use `ProductModel-ai.csv` for new model records or
an explicit seed-job update path for instructions on existing model IDs (inserting
duplicate IDs would fail). Add `Illustration-ai.csv` records with globally unique
illustration IDs and refer to those IDs using `<diag>` in the instruction XML.
The exporter already recognizes that optional illustration file. Draft instruction
and diagram generation are available below; new seed import/update rules are not
implemented yet.
Keep original and AI illustrations in the same ID-based asset namespace, without
adding database columns or storing SVGs in SQL. After enrichment is imported,
the database export also includes it automatically.

### AI manufacturing instruction drafts (review stage)

`POST /api/manufacturing/content/instructions/generate` accepts
`{ "productModelId": 19 }` and requires an internal Functions-audience token with
`manufacturing.write`. It uses the dedicated `manufacturing-content-agent` on the
existing Foundry chat deployment (`AI_AGENT_MANUFACTURING_CONTENT_ID`).
Provision that agent with `scripts/utilities/agents/manufacturing-content-agent.sh`;
the normal agent orchestrator and Functions postdeploy hook also configure it.

The Function reads **live SQL**, not CSV snapshots: current English descriptions,
manufactured variants, effective BOM (including nested parts), actual manufacturing
work centers, latest representative-product routing evidence, and the typed XML
schema. It refuses models with existing instructions, purchased-only models, and
missing/incomplete grounding. The lowest-ID manufactured variant with an effective
BOM is the representative. Limits are 100 variants, eight BOM levels, 1,500 combined
BOM edges, and a 180,000-character grounding context; oversized data is rejected,
not silently truncated.

The agent has no tool calls or cross-product memory. It returns instructions and
one to three **diagram briefs**, not drawings. Server-side validation enforces
known work-center/component IDs, coverage of direct representative components,
resolved diagram references, and the live manufacturing XML schema. Material names
and numbers are inserted from SQL. A single repair attempt is allowed for invalid
output; transient model failures have bounded retries within the 200-second request
budget. Estimated routing/times/tools are explicitly fictional demo assumptions,
not validated engineering or safety guidance.

The response includes the XML, validated draft, complete grounding, source SHA-256,
Foundry response ID, and prospective illustration reservations:
`100000 + ProductModelID * 10 + slot` (slots 1–3), named
`illustration-{ID}.svg`. IDs are checked against existing SQL illustrations but
**not persisted/reserved in SQL**. No database rows, seed CSVs, SVGs, or running
frontend assets are changed.

For the initial review samples:

```bash
# Supply API_FUNCTIONS_URL and FUNCTIONS_ACCESS_TOKEN via your environment.
python3 scripts/data-management/generate-manufacturing-drafts.py --models 19 5 59
```

The standard-library CLI accepts at most three explicit model IDs per run and
writes a timestamped directory under `review-output/manufacturing-content/`
(override with `--output`). Its `index.html` links to readable per-model HTML;
each model also includes XML, grounding JSON, diagram briefs/reservations, metadata,
and the complete API response. HTML escapes all generated text and displays
diagram placeholders. A run manifest records progress/failures without deleting
earlier results. **Review and approve the instructions/briefs before generating
XAML/SVG diagrams; review those separately before any seed integration.**

### AI manufacturing diagram drafts (second review stage)

After explicit instruction approval, `POST /api/manufacturing/content/diagrams/generate`
accepts `{ "approvedDraft": <complete saved instruction response>, "slot": 1 }`.
It uses the same internal `manufacturing.write` authorization and dedicated chat
agent, with a separate diagram-stage contract and no tools or memory.

The Function revalidates the structured draft against its XML and deterministic
reservations, re-reads live SQL, and verifies the original source fingerprint.
Changed descriptions, BOM, variants, work centers or illustration IDs produce a
conflict; elapsed time and newer work orders alone do not invalidate historical
routing evidence. SQL decimal values are compared independently of JSON trailing
zeroes so the local review export round-trip preserves the source binding.
This is a user-supplied review workflow, not a cryptographically signed approval.

One call generates one diagram from its approved brief, actual component callouts,
instruction steps and a bounded original-XAML style excerpt. The chat model returns
constrained inert XAML plus callout positions. The server validates finite canvas
bounds, visible nondegenerate paths, supported absolute geometry, margins and
callout completeness/spacing. It adds numbered bubbles and digits as paths and
converts through `IllustrationSvgConverter`. No WPF execution, arbitrary SVG,
fonts, images, scripts or external references are permitted. One repair attempt is
allowed within the 200-second request budget. Geometry validity does not establish
engineering or visual accuracy: every resulting drawing still requires review.

```bash
# Supply API_FUNCTIONS_URL and FUNCTIONS_ACCESS_TOKEN via your environment.
python3 scripts/data-management/generate-manufacturing-diagrams.py \
  --run review-output/manufacturing-content/<instruction-run-id> \
  --approved-instructions --models 19 5 59
```

The CLI checks instruction hashes and response bindings, saves each successful
`illustration-{ID}.xaml`, `.svg`, and response `.json` in a timestamped
`model-{ID}/diagram-attempts/` directory, and retains run progress/failure manifests
under `diagram-attempts/`. It creates a separate `diagrams.html` review index and
per-model `instructions-diagrams.html` pages embedding the SVGs with captions and
numbered legends. Original instruction files and the original review index remain
unchanged. Previous drawing attempts are retained; failed calls do not publish
assets. No seed CSVs, SQL records or bundled frontend assets are modified.
**Stop here for diagram review before seed/export integration.**

Local instruction previews use the Manufacturing Hub gear mark, AdventureWorks
wordmark and a Manufacturing Engineering document header/footer. A formal revision
history replaces the standalone creation date. Visible disclaimer banners/boilerplate are
omitted from these branded previews; source limitations, variant discrepancies and
operational notes remain. Original XML, provenance and generation safeguards are
preserved in the saved metadata, not displayed as a provenance section. Diagram
captions contain operation guidance from the approved work-center steps, not the
image-generation purpose/composition briefs. Numbered component legends remain.
Re-render saved responses to restyle a sample without new model calls.

To refresh the local documents and their fabricated change-management histories:

```bash
# API_URL is the deployed HTTPS DAB service base URL.
python3 scripts/data-management/refresh-manufacturing-previews.py \
  --run review-output/manufacturing-content/<instruction-run-id>
```

The script reads each representative product's actual lifecycle dates from live
DAB. The initial issue date is its `SellStartDate`; later change dates, ECN numbers,
staff names, approvals and change descriptions are invented presentation content,
not actual audit records. Histories have reproducibly varied lengths by model,
culminating in an illustrated-document revision on the current local date. Products
no longer on sale may still have documentation revisions. `change-history.json`
retains the live lifecycle source and explicit fabricated-content metadata without
altering approved instruction/diagram source files or SQL. Diagram regeneration
preserves an existing local history.

### Publishing approved manufacturing content

Only publish after reviewing the instructions, diagrams and change histories.
No unreviewed full-catalog generation is launched automatically. Candidate selection
is bounded; generation still checks live English descriptions, effective BOM and
actual work centers:

```bash
python3 scripts/data-management/verify-manufacturing-content.py --list-candidates --limit 3
python3 scripts/data-management/generate-manufacturing-drafts.py --models <up-to-three-model-ids>
# Resume a failed/partial run, retaining validated saved models and their provenance:
python3 scripts/data-management/generate-manufacturing-drafts.py --resume <instruction-run-directory>
```

After both review gates and the presentation/history review:

```bash
python3 scripts/data-management/export-manufacturing-content.py \
  --run review-output/manufacturing-content/<instruction-run-id> \
  --diagram-manifest review-output/manufacturing-content/<instruction-run-id>/diagram-attempts/<attempt-id>/manifest.json \
  --models 19 5 59 --approved
```

The exporter verifies instruction and SVG hashes, model/source bindings, original
instruction preservation, diagram references and ID collisions before writing.
It merges sorted `ProductModelInstructions-ai.csv`, `Illustration-ai.csv` and
`ProductModelIllustration-ai.csv` overlays into `seed-job/sql`, bundles the SVGs
in `app-manufacturing/public/illustrations`, and saves presentation metadata under
`app-manufacturing/src/data/manufacturing`. Identical reruns preserve records;
conflicting existing records/assets fail instead of overwriting them. A local
`seed-export.json` receipt records source fingerprints and published IDs.

The live page continues to read instruction XML from DAB. Bundled branding,
revision history, operation guidance and legends apply only when the parsed live
instructions match the approved document. Original documents and models with no
instructions retain their existing presentation. No new database columns, blob
resources, runtime asset generation or polling are needed.

Use the [targeted overlay import](../seed-job/README.md) for an existing database;
do not rerun full seeding to publish these records. Capture and verify preservation
through DAB before and after the targeted import (including its second,
idempotency-check execution):

```bash
python3 scripts/data-management/verify-manufacturing-content.py \
  --capture-baseline --baseline /tmp/manufacturing-before.json
# Execute the targeted seed import, then:
python3 scripts/data-management/verify-manufacturing-content.py \
  --baseline /tmp/manufacturing-before.json
azd deploy app-manufacturing --no-prompt
```

Commit/publish source changes manually using the repository's normal workflow.

### Full manufactured-model coverage

The resumable batch command uses the same protected Functions and deployed chat
model as the reviewed samples. It inventories **all DAB pages**, preserves existing
instructions, and requires manufactured variants, an English description and an
effective BOM. Purchased-only models are explicitly reported rather than given
invented manufacturing inputs. Up to three workers run concurrently; requests
have bounded retries and resource-specific OAuth tokens renewed only in memory.

```bash
# Set API_URL, API_FUNCTIONS_URL, MCP_SERVICE_URL to this azd environment's endpoints.
# Supply MANUFACTURING_USERNAME / MANUFACTURING_PASSWORD securely in the process environment.
python3 scripts/data-management/populate-manufacturing-content.py \
  --run review-output/manufacturing-content/full-coverage \
  --inventory-only
python3 scripts/data-management/populate-manufacturing-content.py \
  --run review-output/manufacturing-content/full-coverage \
  --workers 3 --supplement-originals --publish
```

Reusing `--run` resumes validated instruction and diagram files without new model
calls for completed stages. `--models` and `--limit` bound a targeted retry. Every
failure is recorded in `coverage.json` and makes the command fail; successful
artifacts remain available for resumption. Do not run two publishing batches
concurrently, because they merge the same CSV files. `--publish` is explicit
authorization to publish the automated, validated batch rather than a claim that
each new document has received individual human review.

Original manufacturing documents without diagrams can receive supplemental
figures without changing a byte of their database instructions. The instruction
generation request's optional `supplementExistingInstructions: true` is accepted
only for an existing document without diagram references; normal calls still
reject existing instructions. Supplemental figures use the same validated BOM,
reserved illustration IDs, existing Illustration/ModelIllustration tables, and
bundled metadata. The manufacturing page presents them after the original steps.
No new database tables are created.

Before deploying, validate the entire durable CSV/static-asset set offline:

```bash
python3 scripts/data-management/validate-manufacturing-assets.py --write-manifest
```

This requires instruction/diagram coverage for every modeled manufactured
product in the combined Product CSVs, checks all original and generated figure
references, exact AI cross-references, safe SVGs, metadata binding and revision
histories. It persists artifact hashes and coverage counts in
`seed-job/manufacturing-content-coverage.json`. Deployment consumes these existing
files; **`azd up` does not generate AI content or incur generation costs**. CSVs,
metadata and SVGs must all be retained in source control by the operator before
recreating an environment. Runtime review bundles are not deployment inputs.

After import, verify actual deployed coverage and original preservation:

```bash
python3 scripts/data-management/verify-manufacturing-content.py \
  --baseline <pre-import-baseline.json> --require-full-coverage
```

The bundled content set covers all **61 manufactured product models**: 55
generated instruction documents plus the six original manufactured-model
documents. There are **63 generated diagrams**, including two supplemental
Touring Front Wheel illustrations (model 44) that leave its original XML intact.
The other original documents are retained, including purchased-only models;
purchased-only models are not eligible for newly invented manufacturing inputs.
See the [durable coverage manifest](../seed-job/manufacturing-content-coverage.json)
for model IDs and artifact hashes.

## AI Agent Functions

### `AIAgentChat`

- **Trigger / Route**: HTTP `POST /api/agent/chat`
- **Purpose**: Front-door chat endpoint for the AI support agent. Accepts a message, optional conversation history, customer metadata (`customerId`, `cultureId`), and an optional `threadId` for multi-turn conversation persistence. Forwards to `AIAgentService`, which invokes an Azure AI Foundry "kind: prompt" agent via the Responses API. Customer and culture context is passed as **structured inputs** (`{{userId}}` / `{{cultureId}}` Handlebars templates in the agent's Foundry portal instructions) rather than being embedded in the user message. Memory is scoped per customer via the `x-memory-user-id` header. Returns the agent's reply, suggested follow-up questions, tools used, and the `threadId` (Foundry response ID) for the next request. Emits rich Application Insights telemetry for observability.

- **Authentication**: Explicitly validates the delegated MCP-resource bearer token in `Authorization` (signature, issuer, audience, expiry and `mcp.access`), even when the general Functions middleware is in audit mode. Missing or invalid tokens return `401`. The server resolves `Sales.Customer.CustomerID` from the signed consumer subject; browser customer/name fields and supplied conversation history are not trusted. Admin routing requires an internal identity with `sales.read`. MCP independently validates delegated tokens and enforces ownership.
- **Agent selection**: Customer chat uses `AI_AGENT_CHAT_ID`; admin chat uses `AI_AGENT_ADMIN_CHAT_ID` when configured. `AI_AGENT_WORKFLOW_CHAT_ID` is intentionally ignored because this client executes prompt definitions, not native workflows. The separate workflow product-advisor Q&A is bypassed; the customer-service prompt still supports product recommendations. Non-prompt definitions are rejected explicitly, and failed MCP calls raise errors instead of returning success-shaped answers.
- **Ownership output**: MCP order-history and order-detail results include a stable `CustomerID` label so the agent can verify the owner against `{{userId}}` in every language. Order details use the owner selected from `Sales.SalesOrderHeader`, not merely the requested ID.
- **Conversation ownership**: Stored responses carry authenticated-subject and agent metadata. Before accepting `threadId`, the backend retrieves the stored response and checks both bindings. Existing conversations without this metadata must start a new chat.
- **Foundry guardrails**: Customer chat explicitly selects `AdventureWorks-Eshop` using `x-policy-id` on every inference and continuation. Structured platform blocks discard partial output and return a polite shopping redirect with `safety.source = "foundry"`; configuration/transport failures remain errors. No request is retried with weaker safety settings. See [the guardrail configuration and demo](../docs/features/ai-agent/AI_AGENT_AUTOMATION.md#e-shop-chat-guardrails).

### `AIAgentStatus`

- **Trigger / Route**: HTTP `GET /api/agent/status`
- **Purpose**: Lightweight health/config endpoint for the AI agent. Returns static metadata such as agent status, framework version (`Azure.AI.Foundry`), and enabled capabilities (`foundry-responses-api`, `structured-inputs`, `memory-scoping`, `tool-choice-required`, `dual-mcp-servers`, `multi-turn-persistence`). Useful for smoke tests and diagnostics.

### AI Foundry Features Used by Agent Functions

All AI Foundry agent calls share the `FoundryAgentClient` singleton, which leverages these Responses API features:

| Feature                   | How it's used                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store: true`             | Every response is persisted by Foundry; enables memory and conversation history                                                                                                                                           |
| `previous_response_id`    | Chains multi-turn conversations (replaces thread/session management in the client)                                                                                                                                        |
| `x-memory-user-id`        | Scopes Foundry memory per user or persona so agents recall prior interactions                                                                                                                                             |
| `structured_inputs`       | Resolves `{{variable}}` Handlebars placeholders declared in each agent's Foundry portal definition at runtime — avoids duplicating agent versions for different customers or contexts                                     |
| `tool_choice: "required"` | Forces MCP tool calls for tool-driven agents (Help-Me-Choose, Order Generation) |
| `tool_choice: "none"` | Omits tools entirely for data-supplied agents, including Promotion Generation, so Foundry does not enumerate OAuth-protected MCP servers unnecessarily |

**Per-agent configuration:**

| Agent                                            | Memory `userId`                                         | `tool_choice` | Structured input variables                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Chat (`AIAgentService`)                          | Customer ID                                             | auto (null)   | `userId`, `userName`, `cultureId`                                                                                                           |
| Help-Me-Choose (`HelpMeChooseService`)           | Customer ID                                             | `required`    | _(declared in portal)_                                                                                                              |
| Order Generation (`OrderGenerationAgentService`) | `order-gen-customer-{id}` or `order-gen-persona-{type}` | `required`    | `todayDate`, `personaDescription`, `isExistingCustomer`, `customerName`, `customerId`, `orderCount`, `totalSpend`, `recentProducts` |
| Promotion Generation (`PromotionAgentService`)   | `promotion-gen-{type}`                                  | `none`        | `promotionType`, `offerCategory`, `todayDate`, `categoryName`, `subcategoryName`, `categoryId`, `subcategoryId`                     |

> **Foundry portal prerequisite**: The `structured_inputs` schema (declaring each variable name and type) **must be added to each agent's definition in the Foundry portal** before the Handlebars templates in the instructions will resolve. See [docs/features/ai-agent/AI_AGENT_AUTOMATION.md](../docs/features/ai-agent/AI_AGENT_AUTOMATION.md) for details.

---

## Address Management Functions

### `GetAddresses`

- **Trigger / Route**: HTTP `GET /api/addresses?limit={int}&offset={int}`
- **Purpose**: Returns a paginated list of customer addresses from AdventureWorks via `AddressService`. Intended for frontend address management screens.

### `GetAddressById`

- **Trigger / Route**: HTTP `GET /api/addresses/{id}`
- **Purpose**: Fetches a single address by ID, returning `404` if not found.

### `CreateAddress`

- **Trigger / Route**: HTTP `POST /api/addresses`
- **Purpose**: Validates and inserts a new address record. Ensures required fields (line 1, city, postal code, state/province) are present and that `StateProvinceID` is positive.

### `UpdateAddress`

- **Trigger / Route**: HTTP `PUT /api/addresses/{id}`
- **Purpose**: Updates an existing address. Returns `404` if the address does not exist.

### `DeleteAddress`

- **Trigger / Route**: HTTP `DELETE /api/addresses/{id}`
- **Purpose**: Deletes an address by ID. Returns `204` on success, `404` if missing.

---

## Password & Identity Functions

### `SetPassword`

- **Trigger / Route**: HTTP `POST /api/password`
- **Purpose**: Sets or updates a PBKDF2‑hashed password for a `BusinessEntityID` via `PasswordService`. Performs basic validation (non‑empty, min length) before persisting hash and salt into the `Person.Password` table.
- **Authorization**: Bearer token with `customers.write`. Consumers may only set their **own** password; staff may only reset passwords for individual customers (PersonType `IN`), never employee accounts.

### `VerifyPassword`

- **Trigger / Route**: HTTP `POST /api/password/verify`
- **Purpose**: Verifies a plaintext password for a given `BusinessEntityID` by recomputing the PBKDF2 hash and comparing it with stored values. Returns a structured `IsValid`/`Message` payload.
- **Authorization**: Bearer token with `customers.read`; the caller may only verify their **own** password (no anonymous password oracle).

### `Signup`

- **Trigger / Route**: HTTP `POST /api/signup` (anonymous)
- **Purpose**: Creates a new individual e-shop customer server-side (`BusinessEntity`, `Person` with PersonType `IN`, `EmailAddress`, `Password`) in one serializable transaction. Validates email (≤ 50 chars), first/last name (1–50 chars) and password (≥ 8 chars). Returns `201` with `{ businessEntityId, emailAddressId, email, firstName, lastName }`, `409` for a duplicate email, `400` for invalid input. Replaces the former anonymous DAB create mutations.

### `RequestPasswordReset`

- **Trigger / Route**: HTTP `POST /api/password/reset/request`
- **Purpose**: Starts the password reset flow. Looks up a person by email, generates a short‑lived token stored in `Person.Password.PasswordSalt`, builds a frontend reset URL, and sends a reset email via `EmailService`. Always returns a generic success message to avoid leaking user existence.

### `ValidateResetToken`

- **Trigger / Route**: HTTP `POST /api/password/reset/validate`
- **Purpose**: Validates a reset token for a given `BusinessEntityID` by checking both the stored token and its 1‑hour expiry window.

### `ResetPassword`

- **Trigger / Route**: HTTP `POST /api/password/reset/complete`
- **Purpose**: Completes the reset flow. Validates token and new password strength, then calls `PasswordService.StorePasswordAsync` to write a new PBKDF2 hash and salt, effectively clearing the temporary reset token.

---

## Order Receipt & Email Functions

### `GenerateOrderReceipts_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateOrderReceipts_HttpStart`
- **Purpose**: Front‑door for receipt generation. Accepts either a single `salesOrderId` or multiple `salesOrderNumbers`, then enqueues one message per order onto the `order-receipt-generation` storage queue using managed identity.

### `GenerateOrderReceipts_QueueTrigger`

- **Trigger**: Queue `order-receipt-generation`
- **Purpose**: For each queued order, loads receipt data via `ReceiptService`, generates a PDF with `PdfReceiptGenerator`, and uploads it to blob storage. If email metadata is attached, enqueues an `order-email-generation` message to trigger downstream email delivery.

Receipt lookup supports both consumer customers and store-only B2B customers
(`Sales.Customer.PersonID` may be null). Store receipts use the store name, the
order's shipping/billing addresses and persisted header totals; a missing contact
email does not suppress PDF generation. Displayed discounts are already included
in the net subtotal. Simulator results also use the persisted receipt total and
customer ID, never a pre-tax sum of the AI plan. Reseller discount fractions are
used directly (`0.02` means 2%, not 0.02%). If a committed order cannot be loaded
for its receipt, generation reports an explicit error instead of a fabricated total.

Historical simulator failures remain historical: a successful deployment does not
remove old SQL trigger errors or rewrite earlier result totals. Verify fixes with
a new order; no database repair or environment recreation is required.

### `GenerateAndSendReceipt`

- **Trigger / Route**: HTTP `POST /api/orders/generate-and-send-receipt`
- **Purpose**: Convenience endpoint that validates order/customer/email IDs and then asynchronously kicks off the receipt workflow. It enqueues an `order-receipt-generation` message (with email metadata) and returns `202 Accepted` immediately.

### `SendOrderEmail_QueueTrigger`

- **Trigger**: Queue `order-email-generation`
- **Purpose**: After a receipt PDF exists, this function loads receipt data, constructs a rich order‑confirmation email (including a link to the receipt PDF in blob storage), and sends it via `EmailService` (Azure Communication Services).

### `SendCustomerEmail`

- **Trigger / Route**: HTTP `POST /api/customers/{customerId}/send-email`
- **Purpose**: Generic email‑sending endpoint. Validates that the email address ID and content are present, then uses `EmailService` to send an email (optionally with a storage attachment URL) to the given customer.

---

## Sales Order Status Processing

Demo pipeline that simulates the full order lifecycle via the `sales-order-status` queue:

```
In Process (1) → Approved (2) → Shipped (5) → Delivered (7)
              ↘ Rejected (4)   ↘ Backordered (3) → Shipped (5)
```

Notification emails (Shipped, Delivered) are gated behind the `ORDER_NOTIFICATIONS_EMAIL_ENABLED` environment variable — see [docs/features/email/ORDER_NOTIFICATIONS.md](../docs/features/email/ORDER_NOTIFICATIONS.md) for details. **Emails are disabled by default** to prevent spam when the Shopping Simulator is running.

**Seed script**: To enqueue messages for all existing orders that are still In Process (Status 1), use [scripts/utilities/seed-sales-order-status-queue.sh](../scripts/utilities/seed-sales-order-status-queue.sh). It reads configuration from `azd env` (DAB URL, storage account, resource group), queries the DAB REST API for orders with `Status = 1`, and sends one message per order to the `sales-order-status` queue so the Functions process them as if they had just been placed. Use `--dry-run` to list orders without sending messages. Requires `az login` and `jq`; optional `DAB_ACCESS_TOKEN` if the DAB API requires auth.

### `BeginProcessingOrder`

- **Trigger / Route**: HTTP `POST /api/orders/begin-processing-order`
- **Purpose**: Entry point to start the order status pipeline. Accepts a body with `salesOrderId` (or `SalesOrderID`), validates it is positive, then enqueues a single message onto the `sales-order-status` queue with `{ "SalesOrderID": <id>, "Status": 1 }` and a random visibility timeout between 5 minutes and 1 hour. Returns `202 Accepted` with a short JSON body. Called by the order confirmation page after checkout so the demo pipeline runs without user action.

### `ProcessSalesOrderStatus_QueueTrigger`

- **Trigger**: Queue `sales-order-status`
- **Purpose**: Processes each message (JSON with `SalesOrderID` and `Status`). Implements a state machine over `Sales.SalesOrderHeader.Status`: from **1 (In Process)** moves to **2 (Approved)** (95%) or **4 (Rejected)** (5%); from **2 (Approved)** moves to **3 (Backordered)** (10%) or **5 (Shipped)** (90%); when a **3 (Backordered)** message is picked up after its visibility delay, the order is set to **5 (Shipped)**. For each transition the function updates the database, then either re-queues the next step with a visibility timeout (1–12 hours for Approved, 2–4 days for Backordered) or stops (terminal statuses 4, 6, 7). When status becomes **5 (Shipped)**, `ShipDate` is stamped on the row and a notification email is conditionally sent (see `ORDER_NOTIFICATIONS_EMAIL_ENABLED`). Terminal statuses are **4** (Rejected), **6** (Cancelled), and **7** (Delivered). If the order no longer exists (e.g. removed by the seed job), the function logs "Order not found" and completes successfully so the message is removed without retry or poison queue.

### `OrderDelivery_Timer` / `OrderDelivery_HttpTrigger`

- **Trigger**: Timer (every hour at `:00`) + HTTP `GET /api/orders/delivery/trigger`
- **Purpose**: Promotes Shipped (Status=5) orders to Delivered (Status=7) once the configured delivery window has elapsed since `ShipDate` (falls back to `ModifiedDate` when `ShipDate` is NULL). B2C orders (`OnlineOrderFlag=1`) and B2B store orders (`OnlineOrderFlag=0`) use separate minimum-day thresholds configured via `PUT /api/orders/pipeline/config`. Sends a "delivered" notification email per promoted order (gated by `ORDER_NOTIFICATIONS_EMAIL_ENABLED`). Emits a `OrderDelivery.BatchProcessed` Application Insights custom event with the count. The HTTP endpoint is useful for manual triggering during development — returns `{"delivered": N}`.

---

## Product Media Functions (Images & Thumbnails)

### `GenerateProductImages_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateProductImages_HttpStart`
- **Purpose**: Clears the `product-image-generation` and `product-thumbnail-generation` queues (including poison queues), finds products that still need images, and enqueues one message per product for image generation.

### `GenerateProductImages_QueueTrigger`

- **Trigger**: Queue `product-image-generation`
- **Purpose**: For each product needing images, calls `AIService.GenerateProductImagesAsync` to generate up to 4 product photos with rate‑limit aware retry logic, saves them via `ProductService`, and then enqueues thumbnail jobs onto `product-thumbnail-generation`.

### `GenerateProductThumbnails_QueueTrigger`

- **Trigger**: Queue `product-thumbnail-generation`
- **Purpose**: Loads stored product photos, generates 200x200 thumbnails with ImageSharp, and persists them back to SQL via `ProductService.SaveProductThumbnailAsync`, ensuring idempotency if a thumbnail already exists.

---

## AI Enrichment & Embeddings

### `EmbellishProductsUsingAI_HttpStart`

- **Trigger / Route**: HTTP `POST /api/EmbellishProductsUsingAI_HttpStart`
- **Purpose**: Starts a Durable orchestration that enhances product marketing content using AI. Optionally accepts a list of product IDs to target.

### `EmbellishProductsUsingAI_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: Orchestrates the embellishment workflow:
  - Fetch finished‑goods products (`FetchProductsActivity`).
  - Enhance them with AI (`EnhanceProductsWithAIActivity`) in batches.
  - Persist enhanced content (`UpdateProductsActivity`).
  - Trigger `TranslateProductDescriptions_Orchestrator` for affected product models.

### `FetchProductsActivity`

- **Trigger**: Durable activity
- **Purpose**: Uses `ProductService` to read finished‑goods products from SQL (optionally filtered by product IDs).

### `EnhanceProductsWithAIActivity`

- **Trigger**: Durable activity
- **Purpose**: Uses `AIService` + Azure OpenAI to generate richer titles/descriptions for a batch of products.

### `UpdateProductsActivity`

- **Trigger**: Durable activity
- **Purpose**: Writes AI‑enhanced product content back to SQL via `ProductService`.

### `GenerateProductEmbeddings_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateProductEmbeddings_HttpStart`
- **Purpose**: Starts a Durable orchestration to generate vector embeddings for product descriptions.

### `GenerateProductEmbeddings_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: End‑to‑end pipeline to:
  - Load descriptions needing embeddings (`FetchProductDescriptionsActivity`).
  - Generate embeddings via AI (`GenerateEmbeddingsActivity`).
  - Persist them to SQL (`SaveEmbeddingsActivity`) in small batches.

### `FetchProductDescriptionsActivity`

- **Trigger**: Durable activity
- **Purpose**: Reads product descriptions that currently lack embeddings.

### `GenerateEmbeddingsActivity`

- **Trigger**: Durable activity
- **Purpose**: Calls `AIService.GenerateEmbeddingsAsync` to produce vector embeddings for a batch of descriptions.

### `SaveEmbeddingsActivity`

- **Trigger**: Durable activity
- **Purpose**: Writes embedding vectors back to SQL via `ProductService.SaveEmbeddingAsync`.

### `GenerateProductReviewEmbeddings_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateProductReviewEmbeddings_HttpStart`
- **Purpose**: Starts a Durable orchestration to create embeddings for product reviews (used by semantic search).

### `GenerateProductReviewEmbeddings_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: Mirrors the product description pipeline but for reviews:
  - Load reviews needing embeddings (`FetchProductReviewsActivity`).
  - Generate embedding vectors (`GenerateReviewEmbeddingsActivity`).
  - Persist them (`SaveReviewEmbeddingsActivity`).

### `FetchProductReviewsActivity`

- **Trigger**: Durable activity
- **Purpose**: Reads product reviews that still need embeddings from SQL via `ReviewService`.

### `GenerateReviewEmbeddingsActivity`

- **Trigger**: Durable activity
- **Purpose**: Calls `AIService.GenerateReviewEmbeddingsAsync` to compute vectors for a batch of reviews.

### `SaveReviewEmbeddingsActivity`

- **Trigger**: Durable activity
- **Purpose**: Saves review embeddings back into SQL using `ReviewService`.

### `GenerateProductReviewsUsingAI_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateProductReviewsUsingAI_HttpStart`
- **Purpose**: Clears the `product-review-generation` queue (and poison), discovers products needing synthetic reviews, and enqueues batches of products for AI review generation.

### `GenerateProductReviewsUsingAI_QueueTrigger`

- **Trigger**: Queue `product-review-generation`
- **Purpose**: For each batch, uses `AIService.GenerateProductReviewsAsync` to create realistic demo reviews, saves them via `ReviewService`, and when the queue is empty, automatically triggers the `GenerateProductReviewEmbeddings_HttpStart` endpoint to generate embeddings for the new reviews.

### `SemanticSearch`

- **Trigger / Route**: HTTP `POST /api/search/semantic`
- **Purpose**: Semantic search endpoint over products and reviews. Generates a query embedding via `AIService`, searches both description and review embedding tables, merges and deduplicates results, and returns the best matches ordered by similarity.

---

## Localization & Translation Functions

### `TranslateProductDescriptions_HttpStart`

- **Trigger / Route**: HTTP `POST /api/TranslateProductDescriptions_HttpStart`
- **Purpose**: Starts a Durable orchestration to translate product descriptions into multiple languages. Optionally accepts a list of `ProductModelID`s to limit the scope; otherwise uses recently enhanced products.

### `TranslateProductDescriptions_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: For each target product:
  - Fetch the product metadata (`FetchRecentlyEnhancedProductsActivity`).
  - Load supported non‑English cultures (`GetSupportedCulturesActivity`).
  - Translate into each culture (`TranslateSingleProductActivity` / `TranslateDescriptionsActivity`).
  - Persist translations using `SaveTranslationsActivity`.

### `FetchRecentlyEnhancedProductsActivity`

- **Trigger**: Durable activity
- **Purpose**: Reads either specific products by `ProductModelID` or the set of recently AI‑enhanced products from SQL using `ProductService`.

### `GetSupportedCulturesActivity`

- **Trigger**: Durable activity
- **Purpose**: Returns the list of supported AdventureWorks cultures (languages) for product translations.

### `TranslateSingleProductActivity`

- **Trigger**: Durable activity
- **Purpose**: Uses `AIService.TranslateProductAsync` to translate a single product into multiple cultures, typically as part of a loop over many products.

### `TranslateDescriptionsActivity`

- **Trigger**: Durable activity
- **Purpose**: Batch translation helper that calls `AIService.TranslateDescriptionsAsync` for multiple products and cultures at once.

### `SaveTranslationsActivity`

- **Trigger**: Durable activity
- **Purpose**: Persists translated descriptions to SQL via `ProductService.SaveTranslationsAsync`.

### `TranslateLanguageFile_HttpStart`

- **Trigger / Route**: HTTP `POST /api/TranslateLanguageFile_HttpStart`
- **Purpose**: Starts a Durable orchestration that translates a JSON language resource file (e.g., frontend i18n dictionary) into a target language. Validates supported language codes and accepts inline JSON `languageData`.

### `TranslateLanguageFile_Status`

- **Trigger / Route**: HTTP `GET /api/TranslateLanguageFile_Status?instanceId={id}`
- **Purpose**: Custom status endpoint for the language‑file orchestration. Returns runtime status, timestamps, and raw serialized output for debugging.

### `TranslateLanguageFile_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: Splits the language JSON into sections, invokes `TranslateSectionActivity` for each in parallel, reassembles the translated JSON, and calls `SaveTranslationResultActivity` to persist the result to blob storage, returning a SAS URL.

### `TranslateSectionActivity`

- **Trigger**: Durable activity
- **Purpose**: Traverses a section of the language JSON, calling `AIService` to translate string leaves while preserving structure and nested keys. Returns the translated section as JSON.

### `SaveTranslationResultActivity`

- **Trigger**: Durable activity
- **Purpose**: Writes the final translated JSON file to Azure Blob Storage (using managed identity), generating a short‑lived SAS URL that the caller can download.

---

## SEO & Documentation Functions

### `HealthCheck` and `DependencyReadiness`

- **Routes**: HTTP `GET /api/health` (unchanged process liveness) and
  `GET /api/health/readiness` (anonymous, sanitized dependency report).
- **Readiness**: Uses managed identity to check SQL catalog reads, application
  blob containers/queues/tables, optional seed-log Azure Files and Web PubSub;
  probes MCP liveness/readiness and OAuth discovery from the backend. Separately
  reports AI, hosted-agent, email, and telemetry configuration without claiming
  runtime health or sending emails/invoking agents.
- **Performance**: 60-second per-process report cache; 20-second dependency
  deadlines. HTTP 200/503 depends only on required core checks. No resources are
  created and no business data or exception details are returned.
- See [Health diagnostics](../docs/features/monitoring/HEALTH_DIAGNOSTICS.md)
  for exact checks, caveats, test commands, and deployment.

### `GetSitemap`

- **Trigger / Route**: HTTP `GET /api/sitemap.xml`
- **Purpose**: Generates an XML sitemap for SEO including static pages, category pages (derived from product categories), and individual product detail pages with last‑modified dates.

### `GetOpenApiSpec`

- **Trigger / Route**: HTTP `GET /api/openapi.json`
- **Purpose**: Programmatically builds and returns an OpenAPI document that describes the key HTTP functions (addresses, semantic search, SEO). Used by Swagger UI and external tooling.

### `GetSwaggerUI`

- **Trigger / Route**: HTTP `GET /api/swagger/ui`
- **Purpose**: Serves a static HTML page that hosts Swagger UI, preconfigured to load the OpenAPI spec from `/api/openapi.json` for interactive API exploration.

### `SeedJobStatus`

- **Trigger / Route**: HTTP `GET /api/seed/status`
- **Purpose**: Returns the status of the database seed job by reading the newest log file from the `seed-job-logs` Azure File Share. Response includes `status` (running / completed / failed / unknown), and when the job is running, a human-readable duration (e.g. `runningForHuman: "9m 42s"`) derived from the `Start Time:` line in the log. Used by the frontend Health page (`/health`) to show a Seed Job status card. Requires the Functions app’s managed identity to have **Storage File Data Privileged Reader** on the storage account (REST API with `ShareTokenIntent.Backup`; SMB Share Reader is SMB-only). See [infra/modules/storage.bicep](../infra/modules/storage.bicep).

---

## Simulator Control & Financial Reporting Functions

### `ResetAllSimulators`

- **Trigger / Route**: HTTP `POST /api/simulators/reset`
- **Purpose**: Coordinated reset of all three simulators in the correct order — clears the manufacturing work-order queue, resets the supply chain (reverts POs and re-seeds vendor stock), then resets the bank (wipes transaction history and re-seeds the USD balance). Returns a step-by-step result with the new USD seed amount. Use this instead of individual resets to avoid orphaned bank transactions.

### `GetFinancialSummary`

- **Trigger / Route**: HTTP `GET /api/financials/summary`
- **Purpose**: Returns an aggregated financial summary across all simulators, bucketing bank transactions by reference prefix into procurement spend, manufacturing overhead, payroll, and scrap write-offs. Includes computed totals (`totalOperatingCost`, `totalAllSpend`).

### `GetProcurementTransactions`

- **Trigger / Route**: HTTP `GET /api/financials/procurement[?maxCount=50]`
- **Purpose**: Returns recent procurement transactions — PO approval debits (`PO-*`) and rejection refunds (`PO-*-refund`) — ordered by time descending. `maxCount` 1–500, default 50.

### `GetManufacturingTransactions`

- **Trigger / Route**: HTTP `GET /api/financials/manufacturing[?type=all&maxCount=50]`
- **Purpose**: Returns recent manufacturing financial transactions filtered by type. `type` can be `all` (default), `completions` (WO completion overhead), `payroll` (per-operation labour), or `scrap` (scrap write-offs). `maxCount` 1–500, default 50.

---

## Admin AI Generation Functions

These endpoints power the AI-driven generation features in the admin portal (`app-admin`).

### `GenerateOrderWithAI`

- **Trigger / Route**: HTTP `POST /api/GenerateOrderWithAI`
- **Purpose**: AI-driven order simulation pipeline. Accepts a `personaType` (e.g. `"sporty-adventurer"`, `"existing-customer"`, `"random"`) and an optional `seedCustomerId`. Uses the Foundry Order Generation agent with `tool_choice: "required"` to research products via MCP, then creates a customer (if new), places an order, and generates a receipt PDF. Returns `salesOrderId`, customer details, `totalDue`, `receiptPdfBase64`, and a log of agent steps. Supports multi-turn refinement via `previousResponseId`.

### `GenerateCustomerWithAI`

- **Trigger / Route**: HTTP `POST /api/customers/generate-with-ai`
- **Purpose**: Generates a realistic fictitious customer profile for a given locale/persona using the Foundry Customer agent. Returns the created customer's ID, name, and email, ready for use in order simulation.

### `GeneratePromotion`

- **Trigger / Route**: HTTP `POST /api/GeneratePromotion`
- **Purpose**: Generates a promotion campaign suggestion using the Foundry Promotion agent. Accepts `promotionType`, `offerCategory`, `categoryId`, `categoryName`, `subcategoryId`, and `subcategoryName`. Returns a promotion strategy with discount percentage, conditions, headline, and body copy, plus a `threadId` for multi-turn refinement turns.
- **Data access**: Functions retrieves live inventory, costs, 90-day sales, and active discounts via its SQL managed identity on every turn. It reuses the same query as the MCP `GetProductsForPromotion` tool, but supplies the data directly to Foundry with no remote tools. Interactive and unattended auto-promotions therefore need no delegated MCP user token; Functions route authorization still follows its configured audit/enforced mode.
- **Deployment**: `azd deploy api-functions` publishes the .NET project to the Flex Consumption Function App and includes the linked shared query source automatically.

### `GenerateOrdersBulk`

- **Trigger / Route**: HTTP `POST /api/GenerateOrdersBulk`
- **Purpose**: Bulk order generation utility that enqueues multiple AI order-generation jobs concurrently. Used by the admin portal's Generate Orders page to simulate realistic purchase patterns across various personas.

### `CartRecoveryAnalysis`

- **Trigger / Route**: HTTP `POST /api/carts/analyze-recovery`
- **Purpose**: Analyses a batch of abandoned shopping carts using the Foundry Cart Recovery agent. Body: `{ "carts": [{ "cartId", "customerName", "totalValue", "daysStale", "totalItems", "productNames"? }] }`. Returns per-cart recovery strategies including `recoveryScore`, `urgency`, `emailSubject`, `emailBody`, and `recommendedDiscount`.

### `GenerateReviewsWithReplies`

- **Trigger / Route**: HTTP `POST /api/products/{productId}/generate-reviews-with-replies`
- **Purpose**: Generates synthetic product reviews with AI-written merchant reply responses for a specific product. Used by the admin portal's Reviews page to populate demo review content.

### `ReviewAnalysisBatch`

- **Trigger / Route**: HTTP `POST /api/reviews/analyze-batch`
- **Purpose**: Batch sentiment and theme analysis for a set of product reviews. Returns per-review analysis including sentiment score, key themes, and suggested action. Used by the admin portal Reviews page.

---

## Customer & Reporting Functions

### `GetTopSpenders`

- **Trigger / Route**: HTTP `GET /api/customers/top-spenders?limit=100`
- **Purpose**: Returns the top N customers by total spend, joining `Sales.Customer`, `Person.Person`, and `Sales.SalesOrderHeader`. Used by the admin portal Customer Stats page.

### `GetCustomerStats`

- **Trigger / Route**: HTTP `GET /api/customers/stats`
- **Purpose**: Returns aggregate customer statistics (total customers, new this month, average order value, etc.) for the admin portal dashboard.

### `SearchSuggestions`

- **Trigger / Route**: HTTP `GET /api/search/suggestions?q={term}`
- **Purpose**: Returns lightweight type-ahead search suggestions based on product names and categories. Used by the eshop search bar for fast autocomplete.

### `GetReceiptStatus`

- **Trigger / Route**: HTTP `GET /api/orders/{salesOrderId}/receipt-status`
- **Purpose**: Returns whether a PDF receipt has been generated for the given order, and if so the blob URL. Used by the order confirmation page to show a download link once the async receipt job completes.

### `GetReceipt`

- **Trigger / Route**: HTTP `GET /api/orders/{salesOrderId}/receipt`
- **Purpose**: Redirects or returns the PDF receipt blob for a given order. Returns `404` if the receipt has not yet been generated.

### `AdvanceOrderStatus`

- **Trigger / Route**: HTTP `POST /api/orders/{orderId}/advance-status`
- **Purpose**: Manually advances a sales order to the next status step in the pipeline by enqueuing a `sales-order-status` message. Useful for admin testing and demos without waiting for the automatic queue delay.

### `UpdateExchangeRates`

- **Trigger / Route**: HTTP `POST /api/exchange-rates/refresh`
- **Purpose**: Refreshes currency exchange rates in the database. Used by the admin portal Currencies page and the bank simulator to keep FX data current.

---

## Store / B2B Order Management Functions

These functions support the admin portal Stores page, which allows placing orders on behalf of B2B stores (phone/email orders).

### `GetStores`

- **Trigger / Route**: HTTP `GET /api/stores`
- **Purpose**: Returns all B2B stores with aggregated customer stats (order count, total revenue, last order date). Uses a CTE to aggregate across all `Sales.Customer` rows per store.

### `GetStore`

- **Trigger / Route**: HTTP `GET /api/stores/{storeId}`
- **Purpose**: Returns a single store with full details including contact info and order history summary.

### `GetStoreOrders`

- **Trigger / Route**: HTTP `GET /api/stores/{storeId}/orders`
- **Purpose**: Returns the order history for a specific store, joining through all `Customer` records associated with the store.

### `PlaceStoreOrder`

- **Trigger / Route**: HTTP `POST /api/store-orders`
- **Purpose**: Places a new B2B order on behalf of a store. Validates stock, creates `SalesOrderHeader` and `SalesOrderDetail` records, and triggers the order status pipeline.

### `GetStoreProducts`

- **Trigger / Route**: HTTP `GET /api/store-products`
- **Purpose**: Returns products available for store ordering with inventory information and pricing.

### `GetOrderLines`

- **Trigger / Route**: HTTP `GET /api/orders/{orderId}/lines`
- **Purpose**: Returns the line items for a specific order. Used by the Reorder feature in the admin portal.

### `GetProductCatalog`

- **Trigger / Route**: HTTP `GET /api/product-catalog`
- **Purpose**: Returns product categories with their subcategories and product counts. Powers the category picker in store order creation.

### `GetStoreTerritories`

- **Trigger / Route**: HTTP `GET /api/store-territories`
- **Purpose**: Returns territory summaries for B2B stores, sorted by revenue. Used for geographic analytics in the admin portal.

---

## Manufacturing Control & Planning Functions

These functions expose the manufacturing simulation. See [MANUFACTURING_SIMULATION.md](./MANUFACTURING_SIMULATION.md) for full simulation details.

**Data-access boundary:** Manufacturing uses OAuth-authenticated DAB for SQL table
CRUD, including active routing operations and purchase-order lists/history/detail.
Those SQL-only reads are not Functions endpoints. Functions remain responsible for
server-side planning/cost/feasibility analytics, transactional simulation workflows
(production scheduling, procurement/cancellation with stock, bank and queue side
effects), Azure Table/Queue state (configuration, workforce, scrap, warehouse and
bank data), authentication, and Web PubSub negotiation. DAB-incompatible SQL types
such as address geography also remain behind Functions. MCP tools use native SQL
for tabular reads, matching their existing Managed Identity data-access pattern.

**Rollout:** Deploy the Manufacturing frontend and MCP consumers before the
Functions update removes the old read routes. Existing DAB entities and role
permissions already support these reads; no database/schema migration is needed.

### `ManufacturingBegin`

- **Trigger / Route**: HTTP `POST /api/manufacturing/begin`
- **Purpose**: Explodes the Bill of Materials, creates Work Orders and routing operations, and seeds the `work-order-queue` to start the production simulation.

### `ManufacturingStop`

- **Trigger / Route**: HTTP `POST /api/manufacturing/stop`
- **Purpose**: Clears the production queue, halting the manufacturing simulation (scale-to-zero follows).

### `ManufacturingStatus`

- **Trigger / Route**: HTTP `GET /api/manufacturing/status`
- **Purpose**: Returns live manufacturing counts — work orders in each status, shortages, scrap events, and per-location load.

### Active manufacturing operations (DAB)

- The site reads `WorkOrderRouting` filtered to started, unfinished operations and
  joins `Product` / `Location` through DAB. Elapsed minutes are calculated client-side.
- The former `ManufacturingActive` HTTP Function has been removed.

### `GetScrapConfig` / `UpdateScrapConfig`

- **Trigger / Routes**: `GET /api/manufacturing/scrap-config`, `PUT /api/manufacturing/scrap-config/{locationId}`
- **Purpose**: Get or update per-location failure rates and applicable scrap reasons.

### `GetLocationConfig` / `UpdateLocationConfig`

- **Trigger / Routes**: `GET /api/manufacturing/location-config`, `PUT /api/manufacturing/location-config/{locationId}`
- **Purpose**: Get or update per-location capacity, shift, and throughput speed settings.

### `GetWorkforce` / `GetWorkforceDetail`

- **Trigger / Routes**: `GET /api/manufacturing/workforce`, `GET /api/manufacturing/workforce/detail`
- **Purpose**: Headcount summary by location and shift, or full worker list with status and pay rate.

### `GetScrapEvents`

- **Trigger / Route**: HTTP `GET /api/manufacturing/scrap-events[?vendorId=]`
- **Purpose**: Returns all scrap events with optional vendor filter. Used for quality analysis.

### `GetVendorQuality` / `GetVendorQualityById`

- **Trigger / Routes**: `GET /api/manufacturing/vendor-quality`, `GET /api/manufacturing/vendor-quality/{vendorId}`
- **Purpose**: Aggregated quality report per supplier vendor, or scoped to one vendor.

### `GetPlanFeasibility` / `GetPlanFeasibilityBulk`

- **Trigger / Routes**: `GET /api/plan/feasibility/{productId}?qty={n}`, `GET /api/plan/feasibility?qty={n}`
- **Purpose**: Check if a product (or all products) can be manufactured at a given quantity given current inventory and work orders.

### `GetPlanCost` / `GetPlanCostCurrent`

- **Trigger / Routes**: `GET /api/plan/cost/{productId}`, `GET /api/plan/cost/{productId}/current`
- **Purpose**: Standard vs current-price cost analysis for manufacturing a product.

### `GetPlanCatalog`

- **Trigger / Route**: HTTP `GET /api/plan/catalog`
- **Purpose**: Returns the manufacturable product catalog with BOM complexity and last production date.

### `GetOverstock`

- **Trigger / Route**: HTTP `GET /api/plan/overstock?minWeeks={n}`
- **Purpose**: Returns products with more than `minWeeks` of stock on hand.

### `GetThinMargin`

- **Trigger / Route**: HTTP `GET /api/plan/thin-margin?maxMarginPct={0.20}`
- **Purpose**: Returns products with gross margin below the threshold.

### `GetShortageforecast`

- **Trigger / Route**: HTTP `GET /api/plan/shortage-forecast?days={90}`
- **Purpose**: Forecasts which components will run out within the given number of days.

### `GetReorderRecommendations`

- **Trigger / Route**: HTTP `GET /api/plan/reorder-recommendations?days={60}`
- **Purpose**: Returns reorder recommendations for components expected to run short within the window.

### `WorkOrderOperationProcessor`

- **Trigger**: Queue `work-order-queue`
- **Purpose**: Queue-driven worker that processes manufacturing routing operations step-by-step, advancing work order status, recording scrap events, and making bank debit calls for labour and overhead costs.

---

## Supply Chain Control Functions

These functions expose the supply chain simulation. See [MANUFACTURING_SIMULATION.md](./MANUFACTURING_SIMULATION.md) for context.

The first supply read initializes simulation state once per Functions process.
Initial vendor stock writes use Table transactions of at most 100 rows, preserving
state-change notifications after each successful batch. Historical pending-order
injection loads vendor and time-scale configuration once, and vendor summaries
aggregate stock counts in one Table scan rather than one query per vendor.
Catalog and quote responses expose prices as `unitCost`.

### `GetVendors` / `GetVendor`

- **Trigger / Routes**: `GET /api/supply/vendors`, `GET /api/supply/vendors/{vendorId}`
- **Purpose**: Returns all vendors or a single vendor with stock and lead-time information.

### `GetSupplyCatalog` / `GetSupplyCatalogByProduct`

- **Trigger / Routes**: `GET /api/supply/catalog`, `GET /api/supply/catalog/{productId}`
- **Purpose**: Returns all purchasable components from vendors, or components for a specific product.

### `GetSupplyQuote`

- **Trigger / Route**: HTTP `GET /api/supply/quote?productId={id}&vendorId={id}&qty={n}`
- **Purpose**: Returns a price quote for purchasing a component from a specific vendor at a given quantity.

### `PlaceSupplyOrder`

- **Trigger / Route**: HTTP `POST /api/supply/order`
- **Purpose**: Places a purchase order with a vendor. Validates stock, records the PO in the database, and makes a bank debit for the cost.

### Purchase-order lists, history and detail (DAB)

- The site reads `PurchaseOrderHeader` / `PurchaseOrderDetail`, joined with
  `Vendor`, `Product`, and active `BillOfMaterials` through DAB. Open orders use
  statuses 1/2; history includes terminal statuses. Active-vendor / purchased-BOM
  component filtering is preserved.
- All DAB pages are followed; detail lookups batch order IDs to bound URL lengths.
  Supply-chain Web PubSub events invalidate lists, history and detail.
- The former `SupplyChainGetOrders`, `SupplyChainGetOrderHistory`, and
  `SupplyChainGetOrder` HTTP Functions have been removed. Order placement and
  cancellation remain Functions workflows, not direct DAB writes.

### `CancelSupplyOrder`

- **Trigger / Route**: HTTP `DELETE /api/supply/order/{orderId}`
- **Purpose**: Cancels an open purchase order and issues a refund bank credit.

### `SupplyChainRestock`

- **Trigger / Route**: HTTP `POST /api/supply/restock`
- **Purpose**: Triggers an automatic restock of vendor inventory to baseline levels (used by the simulator reset flow).

### `PurchaseOrderProcessor`

- **Trigger**: Queue `purchase-order-queue`
- **Purpose**: Queue-driven worker that processes purchase order approvals and rejections, updates inventory, and records bank transactions.

---

## Bank Simulator Functions

These functions expose the virtual bank. See [BANK_SIMULATOR.md](./BANK_SIMULATOR.md) for full documentation.

### `BankGetStatus`

- **Trigger / Route**: HTTP `GET /api/bank/status`
- **Purpose**: Returns the bank's overall health status and configuration.

### `BankGetAccounts` / `BankGetAccount`

- **Trigger / Routes**: `GET /api/bank/accounts`, `GET /api/bank/accounts/{currencyCode}`
- **Purpose**: Returns all accounts or a specific currency account with current balance.

### `BankGetTransactions` / `BankGetTransactionsByCurrency`

- **Trigger / Routes**: `GET /api/bank/transactions`, `GET /api/bank/transactions/{currencyCode}`
- **Purpose**: Returns recent transaction history, optionally filtered to a currency.

### `BankDeposit`

- **Trigger / Route**: HTTP `POST /api/bank/deposit`
- **Purpose**: Credits an amount to a currency account. Body: `{ "currencyCode", "amount", "reference", "description" }`.

### `BankWithdraw`

- **Trigger / Route**: HTTP `POST /api/bank/withdraw`
- **Purpose**: Debits an amount from a currency account. Returns `400` if insufficient funds.

### `BankGetCurrencies`

- **Trigger / Route**: HTTP `GET /api/bank/currencies`
- **Purpose**: Returns all supported currencies and their current exchange rates.

---

## Order-Triggered SQL Function

### `OrderPlacedSqlTrigger`

- **Trigger**: Azure Functions SQL Change Tracking on `Sales.SalesOrderHeader` (INSERT)
- **Purpose**: Fires automatically whenever a new order row is inserted. Enqueues receipt generation, starts the order status pipeline, and fire-and-forgets the Manufacturing agent to assess inventory and feasibility. See [docs/features/ai-agent/MANUFACTURING_AGENT.md](../docs/features/ai-agent/MANUFACTURING_AGENT.md) for the full architecture.

---

## Shopping Simulator Functions

The Shopping Simulator continuously generates AI-driven orders to simulate realistic customer and B2B activity. It auto-stops after a configurable duration (default 24h, max 72h) to prevent runaway Azure costs.

### `ShoppingSimulator_Status`

- **Trigger / Route**: HTTP `GET /api/shopping-simulator/status`
- **Purpose**: Returns the current simulator state including all configuration, queue depth, and cumulative counters.
- **Response fields**: `isRunning`, `ordersPerMinute`, `existingCustomerPercentage`, `durationHours`, `stopScheduledAt`, `noOrderCustomerPercentage`, `abandonedCartPercentage`, `includeConsumerOrders`, `includeStoreOrders`, `storeOrderPercentage`, `startedAt`, `totalQueued`, `newCustomerQueued`, `existingCustomerQueued`, `storeOrderQueued`, `queueDepth`.

### `ShoppingSimulator_Start`

- **Trigger / Route**: HTTP `POST /api/shopping-simulator/start`
- **Purpose**: Starts the simulator with the given configuration. Computes `stopScheduledAt` = `startedAt` + `durationHours`.
- **Body**:
  ```json
  {
    "ordersPerMinute": 1,
    "existingCustomerPercentage": 30,
    "durationHours": 24,
    "noOrderCustomerPercentage": 50,
    "abandonedCartPercentage": 10,
    "includeConsumerOrders": true,
    "includeStoreOrders": true,
    "storeOrderPercentage": 20
  }
  ```
- **Configuration details**:
  - `ordersPerMinute` (1–60): Messages enqueued per timer tick (every minute).
  - `durationHours` (1–72, default 24): Auto-stop duration. Simulator NEVER runs forever.
  - `existingCustomerPercentage` (0–100): Split between existing customers and new customers for consumer orders.
  - `noOrderCustomerPercentage` (0–100): % of new-customer slots given to registered customers who never ordered (drawn to sale items via marketing re-engagement).
  - `abandonedCartPercentage` (0–100): % of existing-customer slots given to customers with abandoned shopping carts (Smart Cart Recovery).
  - `includeConsumerOrders` / `includeStoreOrders`: Toggle consumer B2C and/or B2B store orders. At least one must be enabled.
  - `storeOrderPercentage` (5–50): When both types enabled, this % of messages go to B2B stores.

### `ShoppingSimulator_Stop`

- **Trigger / Route**: HTTP `POST /api/shopping-simulator/stop`
- **Purpose**: Stops the simulator. Messages already in the queue continue processing.

### `ShoppingSimulator_ClearQueue`

- **Trigger / Route**: HTTP `POST /api/shopping-simulator/clear-queue`
- **Purpose**: Purges all pending messages from `simulation-order-queue`.

### `ShoppingSimulator_Results`

- **Trigger / Route**: HTTP `GET /api/shopping-simulator/results[?limit=50]`
- **Purpose**: Returns recent simulation results (most recent first). Each result includes `orderType` (`"consumer"`, `"b2b-store"`, `"no-order-customer"`, `"cart-recovery"`).

### `ShoppingSimulator_Timer`

- **Trigger**: Timer `0 * * * * *` (every minute)
- **Purpose**: If running, enqueues `ordersPerMinute` messages to `simulation-order-queue` with the configured routing:
  1. Checks auto-stop: if `UtcNow >= stopScheduledAt`, stops the simulator and returns.
  2. Splits messages between B2B store orders and consumer orders based on `storeOrderPercentage`.
  3. Consumer orders split into existing-customer slots (top spenders + cart recovery) and new-customer slots (random personas + no-order sale-seekers).

### Order Modes (queue message routing)

Each queued message carries an `OrderMode` field that determines generation strategy:

| OrderMode           | Description                                             | AI Required             |
| ------------------- | ------------------------------------------------------- | ----------------------- |
| `new-persona`       | Random persona (newbie, family-shopper, commuter, etc.) | No (fallback to Bogus)  |
| `existing-repeat`   | Top-spender repeat purchase                             | No (fallback to random) |
| `no-order-customer` | Registered customer with 0 orders, drawn to sale items  | **Yes** (hard fail)     |
| `cart-recovery`     | Customer with abandoned cart, completes purchase        | **Yes** (hard fail)     |
| `b2b-store`         | B2B store replenishment order based on history + stock  | **Yes** (hard fail)     |

Modes marked "AI Required" will log full diagnostics and fail (message goes to poison queue) if `AI_AGENT_ORDER_ID` is not configured.

---

## Simulation Queue & Background Functions

### `SimulationOrderStart`

- **Trigger / Route**: HTTP `POST /api/simulation/orders/start`
- **Purpose**: Starts a simulation run that generates a burst of demo orders through the pipeline to warm up the system and demonstrate the full order lifecycle.

### `SimulationOrderQueueTrigger`

- **Trigger**: Queue `simulation-order-queue`
- **Purpose**: Processes queued simulation order generation jobs, calling `GenerateOrderWithAI` for each configured persona.

### `AIJobProcessor`

- **Trigger**: Queue `ai-job-queue`
- **Purpose**: Generic background AI job processor that dequeues tasks (e.g. bulk content generation or embedding jobs) and runs them asynchronously without blocking HTTP responses.

### `TransactionHistoryArchive`

- **Trigger / Route**: HTTP `GET /api/archive/trigger`
- **Purpose**: Archives old bank transaction history rows beyond a retention threshold to keep the transactions table lean.

---

## How This Project Fits Into The Overall Architecture

- **Frontend (`app/`)** calls these Functions for operations that need server‑side processing, long‑running workloads, or integration with external services (OpenAI, email, blob storage).
- **Database access** is handled via services such as `ProductService`, `ReviewService`, `AddressService`, and `ReceiptService`, all using managed identity to reach Azure SQL.
- **Durable Functions** orchestrate multi‑step AI workflows (embellishment, translations, embeddings) and expose simple HTTP entrypoints that the frontend and scripts can call.
- **Real-time push** — the `WebPubSubService` singleton sends fire-and-forget JSON events to Azure Web PubSub after each mutation. All three frontends subscribe via the `useWebPubSub` hook and invalidate React Query caches on receipt.

### Web PubSub Negotiate Endpoint

`GET /api/webpubsub/negotiate?groups=manufacturing-agent,warehouse,...`

Returns a client access URL with a short-lived JWT token for opening a WebSocket connection.

### Real-Time Push Groups

| Group                 | Events                                                                  | Source Functions                                                                                  |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `manufacturing-agent` | run-started, run-completed, step-updated, config-changed, queue-cleared | ManufacturingAgentQueueTrigger, ManufacturingAgentRunFunctions, ManufacturingAgentConfigFunctions |
| `manufacturing-ops`   | wo-completed, simulation-stopped, config-changed                        | WorkOrderOperationProcessorFunction, ManufacturingControlFunction                                 |
| `warehouse`           | operation-completed, config-changed                                     | WarehouseOperationProcessorFunction, WarehouseFunction                                            |
| `supply-chain`        | po-status-changed                                                       | PurchaseOrderProcessorFunction                                                                    |
| `orders`              | order-placed, order-status-changed, orders-delivered                    | OrderPlacedSqlTrigger, ProcessSalesOrderStatus, OrderDeliveryTimerFunction, StoreOrderFunctions   |
| `shopping-simulator`  | simulator-started, simulator-stopped                                    | ShoppingSimulatorControlFunction                                                                  |
| `reviews`             | moderation-progress, generation-progress                                | ReviewModerationQueueFunction, GenerateVerifiedReviewsFunction                                    |

For examples of how these Functions are exercised, see the test scripts in the repo root (e.g. `test-receipt-generation.sh`, `test-send-email.sh`, `test-ai-and-mcp-complete.sh`) and the utilities in [scripts/utilities/](../scripts/utilities/) (e.g. `seed-sales-order-status-queue.sh` for the sales order status pipeline).

## Related documentation

- Overall architecture and components: [README.md](../README.md)
- Azure deployment and azd hooks: [QUICKSTART.md](../QUICKSTART.md), [scripts/README.md](../scripts/README.md)
- Infrastructure and environment: [infra/README.md](../infra/README.md)
- MCP server and tools: [api-mcp/README.md](../api-mcp/README.md)
- Password hashing and reset flow: [docs/features/authentication/](../docs/features/authentication/)
- Receipts, PDFs, and email: [docs/features/email/](../docs/features/email/)
- Order lifecycle notifications and email flag: [docs/features/email/ORDER_NOTIFICATIONS.md](../docs/features/email/ORDER_NOTIFICATIONS.md)
- AI agent and MCP integration: [docs/features/ai-agent/](../docs/features/ai-agent/)
- Translations and localization flows: [docs/features/internationalization/](../docs/features/internationalization/)
- Review generation and embeddings: [docs/features/reviews/](../docs/features/reviews/) and [docs/data-management/](../docs/data-management/)
- SEO endpoints and frontend usage: [docs/features/seo/](../docs/features/seo/)
- Manufacturing simulation: [MANUFACTURING_SIMULATION.md](./MANUFACTURING_SIMULATION.md)
- Bank simulator: [BANK_SIMULATOR.md](./BANK_SIMULATOR.md)
