---
title: Azure Functions app (api-functions/) — .NET 10 isolated on Flex Consumption
summary: Component README for the AdventureWorks serverless backend (245 functions, 200 HTTP) covering business workflows, AI, simulators and real-time push; folders, local run, tests, configuration and deployment.
audience: [developer, operator, ai-agent]
components: [api-functions]
related: [docs/services/functions.md, docs/reference/functions-routes.md, docs/features/functions-oauth/ROUTE_SCOPE_MATRIX.md, docs/architecture/realtime-eventing.md]
---

# Azure Functions app (`api-functions/`)

The serverless backend for everything that is not a good fit for Data API builder:
orders and receipts, email, passwords and addresses, AI chat and content generation,
semantic search, translations, manufacturing, supply chain, warehouse, bank and
shopping simulators, reporting, SEO and health checks. The app contains **245
functions, 200 of them HTTP**, plus queue, timer, Durable and SQL triggers. HTTP routes
validate api-mcp OAuth bearer tokens (`FUNCTIONS_OAUTH_MODE=enforced`); explicit public
routes stay anonymous. For the full service guide, see
**[docs/services/functions.md](../docs/services/functions.md)**; every route is listed in
**[docs/reference/functions-routes.md](../docs/reference/functions-routes.md)**.

**Tech and hosting:** .NET 10 isolated worker on **Azure Functions Flex Consumption**,
published directly by azd (`host: function`, no container image; azd service
`api-functions`). Two always-ready instances serve the SQL listeners
`OrderPlacedSqlTrigger` and `DatabaseChanges`.

## Key folders

| Path | Contents |
|---|---|
| `Functions/` | Function classes (HTTP, queue, timer, Durable, SQL triggers) |
| `Services/` | Business services, AI/Foundry clients, `WebPubSubService`, `DependencyHealthService` |
| `Auth/` | OAuth middleware and the route authorization registry |
| `Models/` | DTOs and Table Storage entities |
| `Program.cs` | Dependency injection, middleware and startup health checks |
| `host.json` | Queue, Durable Task and logging settings |
| `local.settings.example.json` | Template for local settings (never commit a populated copy) |
| `../api-functions.Tests/` | xUnit tests |

## Run, build and test

```bash
dotnet build api-functions/api-functions.csproj
dotnet test api-functions.Tests
```

To run locally, copy `local.settings.example.json` to `local.settings.json`, fill it from
`azd env get-value <KEY> --no-prompt` (set `MCP_SERVICE_URL` to the deployed api-mcp),
then run the VS Code task **func: host start**. The deployed SQL database and storage
account are private, so test most changes by deploying. Call deployed routes with the
authenticated helper:

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
