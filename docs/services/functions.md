---
title: Azure Functions app (Flex Consumption)
summary: How the .NET 10 isolated Functions app is hosted, configured, secured and run, including its trigger mix, Durable settings, middleware, health endpoints, deployment and tests.
audience: [developer, operator, architect, ai-agent]
components: [api-functions, infra]
related:
  - docs/reference/functions-routes.md
  - docs/features/functions-oauth/ROUTE_SCOPE_MATRIX.md
  - docs/features/functions-oauth/README.md
  - docs/architecture/realtime-eventing.md
  - docs/reference/storage-resources.md
---

# Azure Functions app on Flex Consumption

The `api-functions` service holds the business logic that does not fit plain table CRUD: checkout, order processing, carts, passwords, email, AI content, search, simulations, manufacturing, warehouse, supply chain and real-time push. It is a .NET 10 isolated-worker app in [`api-functions/`](../../api-functions/).

## What it contains

The app defines **238 functions**:

| Trigger | Count | Examples |
|---|---|---|
| HTTP | 205 | `PlaceCheckoutOrder`, `SemanticSearch`, `ManufacturingBegin` |
| Queue | 16 | `ProcessSalesOrderStatus_QueueTrigger`, `ManufacturingAgentQueue_QueueTrigger`, `WorkOrderOperationProcessor` |
| Timer | 7 | see below |
| SQL trigger | 2 | `OrderPlacedSqlTrigger` on `Sales.SalesOrderHeader`; `DatabaseChanges` on `dbo.RealtimeNotificationOutbox` |
| Durable orchestrator | 2 | `TranslateLanguageFile_Orchestrator`, `GenerateProductNameEmbeddings_Orchestrator` |
| Durable activity | 6 | `TranslateSectionActivity`, `SaveNameEmbeddingsActivity` |

Every function, with its route, authorization tier, scope and Web PubSub event, is listed in the [Functions routes reference](../reference/functions-routes.md). Queues and tables are in [storage resources](../reference/storage-resources.md).

### Timers

| Function | Schedule (UTC) | Does |
|---|---|---|
| `ShoppingSimulator_Timer` | every minute | Runs simulator ticks and stops the simulator after its configured duration |
| `SimulationMaintenance_Timer` | every minute and on host start | Seeds missing simulator state, persists agent auto-shutoff, expires agent proposals and prunes stale shortages (see [GET routes are read-only](#get-routes-are-read-only)) |
| `ExpireAbandonedReviewJobs` | every minute | Marks abandoned review generation jobs as expired |
| `CleanupExpiredGuestCarts` | every 10 minutes | Deletes expired guest carts |
| `OrderDelivery_Timer` | hourly | Moves Shipped (5) orders to Delivered (7) after the configured delivery window |
| `CleanupDatabaseNotifications` | daily 03:00 | Deletes processed real-time outbox rows older than 7 days |
| `ArchiveTransactionHistoryTimer` | Sundays 02:00 | Archives old `Production.TransactionHistory` rows |

### Durable Functions

[`host.json`](../../api-functions/host.json) sets the Durable task hub to `AdventureWorksFunctions`, `defaultVersion` to `push-v1` and `versionMatchStrategy` to `CurrentOrOlder`, so new instances run the current version and older histories still replay.

- `TranslateLanguageFile_HttpStart` and `GenerateProductNameEmbeddings_HttpStart` start orchestrations that report progress through the `utilities` Web PubSub group.
- Bulk product, review and description jobs (`GenerateProductEmbeddings_HttpStart`, `GenerateProductReviewEmbeddings_HttpStart`, `TranslateProductDescriptions_HttpStart`) are not Durable; they enqueue work on the AI job queues.

Orchestration progress is pushed, not polled. See [real-time eventing](../architecture/realtime-eventing.md).

### Queue settings

`host.json` sets `batchSize` 16, `maxDequeueCount` 5 and `visibilityTimeout` 30 minutes. After five failed attempts a message moves to the queue's `-poison` queue.

Queue triggers decode one Base64 layer. A sender whose `QueueClient` uses `QueueMessageEncoding.Base64` (such as the order trigger's auto-promotion client) must pass raw JSON; a client with the default encoding must Base64-encode the JSON itself. Encoding twice makes the message undeserializable.

## Hosting

| Setting | Value |
|---|---|
| Resource | Function App `av-func-*` ([`flex-api-functions.bicep`](../../infra/modules/flex-api-functions.bicep)) |
| Plan | Flex Consumption (FC1), Linux, .NET 10 isolated |
| Scale | Up to 5 instances, 2,048 MB each |
| Always ready | One instance each for `OrderPlacedSqlTrigger` and `DatabaseChanges` (two total), so the SQL listeners keep running |
| Network | VNet integration to reach private SQL and storage |
| Identity | Runtime user-assigned managed identity for SQL, storage, Web PubSub, email and Foundry |
| Deployment | `azd deploy api-functions --no-prompt` publishes the project directly (`host: function`); there is no container image |

[`api-functions-postdeploy.sh`](../../scripts/hooks/api-functions-postdeploy.sh), called once per deploy by the root `postdeploy.sh`, writes Foundry agent IDs, `MCP_SERVICE_URL` and `MANUFACTURING_AGENT_ENDPOINT` to the app settings.

## Request pipeline and authorization

Every HTTP trigger uses `AuthorizationLevel.Anonymous`. Authorization happens in worker middleware registered in [`Program.cs`](../../api-functions/Program.cs):

```mermaid
flowchart LR
    A["HTTP request"] --> B["InvocationTraceMiddleware"]
    B --> C["FunctionsAuthorizationMiddleware"]
    C -->|"Public route"| F["Function"]
    C -->|"Valid token, scope and category"| F
    C -->|"Missing or invalid token"| E1["401 + WWW-Authenticate"]
    C -->|"Missing scope or wrong category"| E2["403"]
```

- [`FunctionAuthorizationRegistry.cs`](../../api-functions/Auth/FunctionAuthorizationRegistry.cs) classifies every HTTP function: **Public** (20), **Authenticated** (1, `NegotiateWebPubSub`), **Consumer** (20, the caller's own data) and **Internal** (164, staff roles). In enforced mode an unclassified function is denied. `FunctionAuthorizationRegistryTests` in `api-functions.Tests` checks that every function is classified.
- `FUNCTIONS_OAUTH_MODE` selects `disabled` (the code default), `audit` (log decisions, do not block) or `enforced`. Bicep sets `enforced`.
- Tokens are api-mcp JWTs with audience `<issuer>/functions` (`FUNCTIONS_JWT_ISSUER`, `FUNCTIONS_JWT_AUDIENCE`). The OpenID metadata address defaults to `<issuer>/.well-known/openid-configuration`.
- Internal routes require an internal user category plus the route's scope; consumer routes check ownership against the token's `business_entity_id` or `customer_id`.

See the [route scope matrix](../features/functions-oauth/ROUTE_SCOPE_MATRIX.md) and [Functions OAuth](../features/functions-oauth/README.md).

### Calling a route

```bash
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource functions --path /api/manufacturing/status
```

Use `--identity admin` for orders, customers and reporting routes. See [authenticated local scripts](../testing/AZURE_AUTHENTICATED_SCRIPTS.md).

### GET routes are read-only

HTTP `GET` routes never change state. On-demand jobs use `POST`: `POST /api/orders/delivery/trigger` (promote shipped orders to delivered), `POST /api/archive/trigger` (transaction history archive) and `POST /api/TranslateLanguageFile_Terminate?instanceId=…`.

Upkeep that used to run inside reads is done by `SimulationMaintenance_Timer` (every minute and on host start). It seeds bank, warehouse, workforce and supply-chain state when it is missing, persists the manufacturing agent auto-shutoff, rejects expired or over-cap agent proposals and prunes shortage rows for deleted work orders. Until the first run seeds a simulator, its reads return empty state. `GET /api/manufacturing/agent-config` already reports `Off` once the shutoff time has passed. The offline auth gate requires every protected `GET` to be listed in `safeFunctionReadRoutes` in [`tests/auth/contracts.json`](../../tests/auth/contracts.json).

## Real-time push

`WebPubSubService` sends events to Web PubSub groups after mutations. Services that store state in Azure Tables use `NotifyingTableClient`, which sends a coalesced `state-changed` event after each write. SQL triggers write direct DAB changes to an outbox that `DatabaseChanges` turns into `database-changed` events. `GET /api/webpubsub/negotiate` returns a client URL for the groups the caller's scopes allow.

See [Web PubSub events](../reference/webpubsub-events.md) and [real-time eventing](../architecture/realtime-eventing.md).

## Code structure and dependency injection

- `Functions/` holds the trigger classes, `Services/` the business logic, `Models/` the DTOs and `Auth/` the authorization middleware and registry.
- `Program.cs` registers services. Services that need SQL read `SQL_CONNECTION_STRING`, which uses `Authentication=Active Directory Default` (the runtime managed identity in Azure):

```csharp
builder.Services.AddScoped<AddressService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new AddressService(connectionString);
});
```

- Storage queues, tables and containers are created by Bicep, never by code. Do not call `CreateIfNotExists*`. To add one, follow [storage resources](../reference/storage-resources.md#adding-a-storage-resource).

Key settings are listed in [environment variables](../reference/environment-variables.md#azure-functions-api-functions).

## Health, OpenAPI and status endpoints

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness |
| `GET /api/health/readiness` | Checks SQL and the expected queues, tables and containers; returns a sanitized result |
| `GET /api/seed/status` | Reads seed-job progress from the seed log share |
| `GET /api/openapi.json`, `GET /api/swagger/ui` | Hand-maintained OpenAPI document covering a subset of routes; use the routes reference for the full list |
| `GET /api/sitemap.xml` | XML sitemap of catalog pages |

On startup, `Program.cs` also checks that every expected storage resource exists and logs a warning for any that is missing. See [health diagnostics](../features/monitoring/HEALTH_DIAGNOSTICS.md).

## Telemetry

- **Trace correlation.** [`InvocationTraceMiddleware`](../../api-functions/Functions/InvocationTraceMiddleware.cs) runs first for every invocation. It makes the worker's trace match the host request's W3C trace, so custom events, SQL dependencies and outbound calls share the request's `operation_Id`.
- **Sampling.** `host.json` never samples requests, events or exceptions. The worker re-adds adaptive sampling at 20 items per second and never samples events or exceptions.
- **SQL identity evidence.** The shared [`SqlPrincipalTelemetry`](../../api-mcp/AdventureWorks/Telemetry/SqlPrincipalTelemetry.cs) service (compiled from api-mcp) emits `Sql.SessionPrincipal` with scope `function:<name>`. The event compares the principal behind `SQL_CONNECTION_STRING` with `AZURE_CLIENT_ID`, using hashes only.
- **Foundry errors.** Failed Responses API calls log the error code and type, rate-limit headers and request sizes, never the response body.

Custom events and queries are listed in [monitoring](../operations/monitoring.md).

## Deploying and testing changes

The Functions app runs only in Azure; its SQL database and storage account are private. Deploy changes with `azd deploy api-functions --no-prompt`, then call the deployed routes with the [authenticated helper](../testing/AZURE_AUTHENTICATED_SCRIPTS.md). The offline auth gate (`validate-auth.sh --offline`) starts its own Functions host and Azurite only to test the middleware.

## Tests

`api-functions.Tests/` contains the unit tests, including the authorization registry tests:

```bash
dotnet test api-functions.Tests
```

See the [testing strategy](../testing/testing-strategy.md).
