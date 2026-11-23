---
title: Azure Functions app (api-functions/) — .NET 10 isolated on Flex Consumption
summary: Component README for the AdventureWorks serverless backend (238 functions, 205 HTTP) covering business workflows, AI, simulators and real-time push; folders, tests, configuration and deployment.
audience: [developer, operator, ai-agent]
components: [api-functions]
related: [docs/services/functions.md, docs/reference/functions-routes.md, docs/features/functions-oauth/ROUTE_SCOPE_MATRIX.md, docs/architecture/realtime-eventing.md]
---

# Azure Functions app (`api-functions/`)

The serverless backend for everything that is not a good fit for Data API builder:
orders and receipts, email, passwords and addresses, AI chat and content generation,
semantic search, translations, manufacturing, supply chain, warehouse, bank and
shopping simulators, reporting, SEO and health checks. The app contains **238
functions, 205 of them HTTP**, plus queue, timer, Durable and SQL triggers. HTTP routes
validate api-mcp OAuth bearer tokens (`FUNCTIONS_OAUTH_MODE=enforced`); explicit public
routes stay anonymous. For the full service guide, see
**[docs/services/functions.md](../docs/services/functions.md)**; every route is listed in
**[docs/reference/functions-routes.md](../docs/reference/functions-routes.md)**.

**Tech and hosting:** .NET 10 isolated worker on **Azure Functions Flex Consumption**,
published directly by azd (`host: function`, no container image; azd service
`api-functions`). Two always-ready instances serve the SQL listeners
`OrderPlacedSqlTrigger` and `DatabaseChanges`.

## Telemetry ownership

The Functions host uses `telemetryMode: OpenTelemetry`; Application Insights
WorkerService **3.2** owns the worker's Azure Monitor exporters. The Functions
worker OpenTelemetry integration prevents duplicate host/worker logs. Aspire and
application sources extend that provider; never initialize another distro.
SDK HTTP/SQL instrumentation, Azure SDK sources and .NET runtime metrics share
the pipeline. Internal AI operations are dependencies, not additional requests.
Default trace sampling is five traces/second; outcome/token metrics are unsampled
and logs do not inherit trace sampling. Sampling does not guarantee every failed trace.
Native event payloads are immutable; spans containing unsafe exception/content
events are withheld before exporters, with unsampled `aw.telemetry.redacted_span.count`.
Safe application outcome metrics and sanitized exception logs remain available.

`AdventureWorks.GenAI` emits logical agent and per-response model spans. Usage
includes approval rounds, explicit retries and empty-answer recovery; duplicate
response IDs within an invocation are accounted once. Cached/reasoning token
counts are subsets of input/output, not extra tokens. Missing usage is unknown.
The canonical `gen_ai.client.token.usage` records only input/output totals;
`aw.gen_ai.token.subset.usage` records cached/reasoning subsets separately.
Embeddings and images record provider usage when returned; image output bytes
are not a monetary cost estimate. SDK-internal failed retry usage is unavailable
unless the provider returns it; HTTP dependencies still expose those attempts.

Rich content defaults off. The Foundry client accepts only an internal admitted
capture lease and revalidates it before bounded sanitized emission. No request
header, trace ID or queue capture reference alone enables content. Existing
chat callers use a server-generated `monitoringSessionId` persisted in response
metadata alongside owner and agent. Continuations recover it only after existing
ownership checks. An active session grant matching this ID admits one invocation
root; approval rounds/retries share its lease. No identity-wide/global capture is
installed. Job paths without verified persisted-state admission remain metadata-only.
Capture lookup, admission and each emission are bounded to ten seconds and fail
closed without changing model execution, cancellation or business retries.
Sanitized captured content has one owner: `GenAI.Capture` custom events correlated
to the actual ambient span (`aw.capture.span_id`), not duplicate rich span payloads.
These logs do not inherit trace sampling, but export/ingestion/caps can still drop
them. Head sampling cannot retroactively retain earlier request/provider spans;
capture does not promise a complete trace. SDK3 standalone test configurations
mutate `OTEL_SDK_DISABLED`, so mixed enabled/disabled fixtures run serially.
Only returned official reasoning summaries can be captured. For a verified
compatible deployment/protocol, optionally list exact deployment names in
`FOUNDRY_REASONING_SUMMARY_DEPLOYMENTS` (comma-separated). An active admitted lease
then requests only `reasoning.summary=auto`, never changes effort or mode, and
never adds model calls. Do not list deployments using multi-agent orchestration,
which does not support this parameter. Hidden/encrypted
reasoning is never read or requested. Application toggles do not control
provider-managed Foundry traces. Real ingestion/host Monitor behavior requires
validation after user-run deployment, not merely a local build.

## Key folders

| Path | Contents |
|---|---|
| `Functions/` | Function classes (HTTP, queue, timer, Durable, SQL triggers) |
| `Services/` | Business services, AI/Foundry clients, `WebPubSubService`, `DependencyHealthService` |
| `Auth/` | OAuth middleware and the route authorization registry |
| `Models/` | DTOs and Table Storage entities |
| `Program.cs` | Dependency injection, middleware and startup health checks |
| `host.json` | Queue, Durable Task and logging settings |
| `../api-functions.Tests/` | xUnit tests |

## Build, test and call

```bash
dotnet build api-functions/api-functions.csproj
dotnet test api-functions.Tests
```

The app runs only in Azure (its SQL database and storage account are private). Deploy
changes with `azd deploy api-functions --no-prompt`, then call the deployed routes with
the authenticated helper:

```bash
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource functions --path /api/manufacturing/status
```

## Configuration

Key app settings: `SQL_CONNECTION_STRING` (Active Directory Default), identity-based
`AzureWebJobsStorage__*`, `FUNCTIONS_JWT_*` and `FUNCTIONS_OAUTH_MODE`, `MCP_SERVICE_URL`,
`AI_FOUNDRY_PROJECT_ENDPOINT` and `AI_AGENT_*_ID`, and `WEB_PUBSUB_HOST_NAME`. Storage
queues, tables and containers are provisioned by Bicep; runtime code never creates
them. See the [environment variables reference](../docs/reference/environment-variables.md)
and [storage resources](../docs/reference/storage-resources.md).

## Background telemetry

`AdventureWorks.BackgroundWork` instruments app-owned queue attempts and Durable
activities. Producers add optional `Telemetry` metadata (validated W3C parent, stable
job ID, enqueue UTC, configured visibility delay and optional capture reference);
consumers and explicit re-enqueues preserve it, including manufacturing retry counts
and work-order slot/material state. Legacy payloads remain accepted. Attempt outcomes
distinguish completed, rejected, skipped, partial, retrying and failed. These are
attempts, not exactly-once logical job totals; runtime poison transfer is verified
separately through approximate poison queue metadata, not inferred from an exception.

Queue wait excludes the producer's declared visibility delay; unreported runtime
retry delays cannot be subtracted. Durable outcomes run in activities/status observers,
never orchestrator replay; `push-v1` and replay-safe loggers remain unchanged.
SQL Change Tracking begins a causal boundary, not a continued browser trace. Order/run
IDs join server-side timelines only; `orders` and `finance` broadcasts stay generic.
Capture IDs are metadata, not permission: no content is enabled by trace headers or
the queue helper. Manufacturing job capture looks up the canonical persisted
`awManufacturingAgentRuns.RunId`, verifies matching order/customer and nonterminal
state, ignores queue capture references, and claims a matching server-created grant.
The persisted RunId is the stable root across retries; use its exact format when
selecting a job in Monitoring. Other queue jobs remain metadata-only.

For this supported flow, bounded `GenAI.Capture` events contain the application
request input and parsed hosted findings/actions output. `MonitoringCaptureService`
revalidates Stop/expiry and reserves the cumulative byte budget before each emission.
Rich payloads are not duplicated on sampled background spans. This does not expose
internal hosted tool arguments/results, hidden reasoning, or control provider-managed
tracing. Official reasoning summaries are unavailable on this parsed hosted contract.
The 32 KiB root budget is cumulative across input, output and every retry; re-acquiring
the same RunId never resets it. Later attempts can capture remaining budget, then
emit only omission metadata. Stop/expiry prevents further capture; the 100-root cap
rejects new roots but does not revoke an already admitted root's remaining budget.

Focused regression: `dotnet test api-functions.Tests --filter BackgroundWorkTelemetryTests`.

## Web PubSub changes and polling-free frontends

Mutations publish change signals (not data) to Web PubSub groups, either directly
through `WebPubSubService`, after Table Storage persistence (`state-changed`), or
through the SQL outbox and the `DatabaseChanges` listener (`database-changed`). The
three frontends turn those signals into batched cache invalidations and never poll.
Signals must not contain private records, tokens or Durable management URLs. The
outbox, DML triggers, Change Tracking and listener lease tables are created by the seed
job, not at runtime. Durable utility workflows use the `push-v1` version. For the
design, groups, producers, batching rules and how to add a live query, see
**[Real-time eventing](../docs/architecture/realtime-eventing.md)** and the
[Web PubSub event reference](../docs/reference/webpubsub-events.md).

## Deploy

```bash
azd deploy api-functions --no-prompt
```

The `api-functions` service postdeploy hook applies agent settings; see
[deployment](../docs/operations/deployment.md).

## Related docs

- [Functions service guide](../docs/services/functions.md)
- [Functions route reference](../docs/reference/functions-routes.md)
- [Functions OAuth](../docs/features/functions-oauth/README.md) and [route scope matrix](../docs/features/functions-oauth/ROUTE_SCOPE_MATRIX.md)
- [Order lifecycle](../docs/features/commerce/order-lifecycle.md) and [email notifications](../docs/features/email/email-notifications.md)
- [Production simulation](../docs/features/manufacturing/production-simulation.md) and [bank simulator](../docs/features/finance/bank-simulator.md)
- [Manufacturing content](../docs/features/manufacturing/manufacturing-content.md)
- [Foundry agents](../docs/features/ai/foundry-agents.md) and [Manufacturing agent](../docs/features/manufacturing/manufacturing-agent.md)
- [Data stores and SQL idle cost](../docs/architecture/data-stores.md)
