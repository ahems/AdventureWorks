# Storefront health diagnostics

The storefront `/health` page is a point-in-time diagnostic view, not an uptime
monitor. It separates **core service availability**, **optional capabilities**, and
**demo/data readiness**. It does not create orders, consume queue messages, send
emails or events, generate receipts/images, or invoke autonomous agents.

The three run buttons map directly to color-coded result sections: **blue quick
checks**, **purple capability checks**, and **teal demo readiness**. Each test card
has a matching type label and left border. Quick checks include optional
configuration/dependency indicators alongside the core checks; these indicators
still do not determine core availability. The live browser connection is shown
in the quick-check section and is not counted as a request-based test.

Result badges have independent meanings: **green passed**, **red failed/timeout**,
**amber checking/running/warning**, and **gray configured only/not run**. Text
labels remain present so color is not the sole indicator.
Clicking a run button scrolls to and focuses its test section; the automatic
initial run does not move the page. Reduced-motion preferences disable animated
scrolling.

## Checks and their limits

| Area | Default quick check | What a pass establishes |
| --- | --- | --- |
| DAB / SQL | One-category GraphQL query (`first: 1`) | GraphQL schema and catalog read path respond; an empty catalog is not an API failure. |
| Functions | `GET /api/health` | Process liveness only; existing response and status are unchanged. |
| Azure SQL | Functions managed-identity catalog read | Connectivity and `Production.Product` read permission, not every SQL permission or data completeness. |
| Blob storage | Read properties of receipt, locale, and deployment containers | Containers exist and are accessible, not blob completeness or write permission. |
| Queue storage | Read properties of all 14 application queues and their poison queues | Queues exist and are accessible, not worker progress, write permission, queue contents, or message delivery. |
| Table storage | Read a single page (at most one row, partition key only) from each of the 13 Functions application tables | Tables are readable, not write permission, record correctness, or simulator activity. No row data is returned to the browser. |
| MCP | Backend requests to `/health` and `/ready` | Process liveness plus the MCP service's own catalog SQL and task-store read access. In-memory task storage is valid locally but not durable. |
| OAuth | Backend authorization-server discovery request | Issuer/token metadata and PKCE `S256`, not a complete login, signing-key access, or authenticated tool execution. |
| Web PubSub | Read-only `orders` group-existence request | Service reachable using managed identity. A group with no connections is valid; no event is sent. |
| Azure Files | Read `seed-job-logs` share properties | Optional seed-log storage access, not seed completion. |
| OpenAI / Foundry / hosted manufacturing agent | Presence of endpoint and, for Foundry chat, agent configuration | **Configured only**, not inference, model quota, agent definition validity, or agent runtime health. |
| Email | Communication Services endpoint and sender-domain configuration | **Configured only**, not email delivery. Disabled shipped/delivered notifications are intentional, not an outage. |
| Telemetry | Backend Application Insights configuration | **Configured only**, not ingestion. Detailed diagnostic exceptions are logged server-side. |
| Browser WebSocket | Existing app connection state | Connected/disconnected/failed state, not whether every server mutation publishes events. No second socket is opened. |

Only DAB, Functions liveness, SQL, blobs, queues, tables, MCP liveness/readiness,
and OAuth discovery determine the **core services** headline. Optional capability
warnings and seed/image-readiness states never make core services unavailable.
Configuration-only results use a neutral badge, not a passed/healthy badge.

**Run capability checks** explicitly runs semantic search (five matches, English),
AI search suggestions, the agent status endpoint, Help Me Choose catalog metadata,
sitemap XML validation, and OpenAPI document validation. Search/suggestions invoke
embedding inference and can incur Azure OpenAI charges. Agent status does **not**
test a conversation or tools. Empty search matches are inconclusive (`Unknown`),
not a green readiness result.

**Check demo readiness** explicitly reads seed status and samples up to 100
`ProductPhoto` rows with `ProductPhotoID >= 1000`, the existing AI-photo convention.
`hasNextPage` is shown as a `+`; the page does not claim a full count or require
885 images. Metadata presence does not prove image bytes/URLs are valid.
Seed `running`, `failed`, `unknown`, and `completed` remain distinct.

## Endpoint contract and performance

`GET /api/health/readiness` is an anonymous, sanitized Functions endpoint. It returns:

```json
{
  "status": "healthy",
  "checkedAt": "2026-11-03T00:00:00Z",
  "checks": [
    {
      "id": "sql",
      "name": "Azure SQL",
      "group": "services",
      "required": true,
      "status": "healthy",
      "message": "Connected and verified catalog read permission; no customer data returned.",
      "responseTimeMs": 42
    }
  ]
}
```

The actual report includes all dependency/configuration checks. It returns HTTP
200 when required dependencies pass and 503 otherwise; the frontend still
validates/displays individual results from a valid 503 report. Every other probe
requires a successful HTTP status plus its expected payload. 400/401/403/404/429
are **not** healthy. Missing/duplicate/malformed dependency results fail explicitly.

Functions caches the report per process for 60 seconds and coalesces simultaneous
requests. Each dependency is bounded to 20 seconds. MCP `/ready` likewise caches
for 60 seconds, bounds its checks to 12 seconds, and returns sanitized JSON with
HTTP 200/503. MCP `/health` and `/alive` remain liveness probes so dependency outages
do not create restart loops. The Functions backend probes MCP, avoiding extra
browser CORS requirements.

The quick run makes three browser requests. Quick/data requests allow 60 seconds;
opt-in functional requests allow 90 seconds. Deadlines cover response-body parsing,
timers are cleaned up, and navigation aborts in-flight diagnostics. There are no
automatic retries or reloads. Results and error details persist until the user
reruns the relevant group; observation timestamps make cached/stale results clear.
The elapsed timer updates only the UI and performs no network polling.

Storage probes use the existing managed identity and only read resources
provisioned by [storage.bicep](../../../infra/modules/storage.bicep). No runtime
infrastructure creation is permitted. Azure Files uses `ShareTokenIntent.Backup`
and requires the existing Storage File Data Privileged Reader role. SQL uses
the existing `Authentication=Active Directory Default` connection. Secrets,
access URLs/tokens, connection strings, database rows, and exception details are
not returned by the readiness endpoints. See Application Insights for details.

Browser real-time status comes from the single app-level
[useWebPubSub](../../../app/src/hooks/useWebPubSub.ts) connection. If unavailable,
normal React Query focus refetch remains the fallback; diagnostics do not add
polling or refresh any business-data query.

## Validation and deployment

From the repository root:

```bash
cd app
node --test scripts/health-checks.test.mjs scripts/sale-product-model-card.test.mjs
npx eslint src/pages/HealthCheckPage.tsx src/lib/healthChecks.ts src/hooks/useWebPubSub.ts
npm run build:dev
cd ..
dotnet test api-functions.Tests/api-functions.Tests.csproj --filter 'FullyQualifiedName~DependencyHealthServiceTests|FullyQualifiedName~FunctionAuthorizationRegistryTests'
dotnet test api-mcp/AdventureWorks.Tests/AdventureWorks.Tests.csproj --filter 'FullyQualifiedName~OAuthMetadataTests'

azd deploy api-mcp --no-prompt
azd deploy api-functions --no-prompt
azd deploy app --no-prompt
bash tests/scripts/test-health-diagnostics.sh
```

No new resources or changed SKUs are needed; do not reprovision or rerun the seed
job just to deploy diagnostics. For smoke tests, resolve endpoints from
`azd env get-value API_FUNCTIONS_URL`, `API_MCP_URL`, and `APP_URL`.

1. Verify Functions `/api/health` and MCP `/health` still return their existing
   liveness responses.
2. Verify MCP `/ready` and Functions `/api/health/readiness` return the documented
   shape and status; inspect failed IDs without exposing secrets.
3. Load the deployed storefront `/health`; verify quick checks finish, core
   status matches the dependency report, and optional checks initially say `Not run`.
4. Run both optional groups; verify validated payloads and distinct seed/data
   states. Confirm no reload/retry after failure and no additional WebSocket.
5. Navigate back to the shop and verify the existing catalog still works.

For continuous availability, queue backlog/poison-message monitoring, agent
failures, order delivery progress, or telemetry ingestion, use Azure Monitor and
Application Insights rather than keeping this browser page open.
