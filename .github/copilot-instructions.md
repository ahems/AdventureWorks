# AdventureWorks E-Commerce - AI Agent Instructions

## GitHub Source Control Policy

**Do not commit, push, or check in any file changes to GitHub on behalf of the user.** All Git operations (commits, pushes, pull requests, branch creation, etc.) must be performed manually by the user.

## Azure Environment Policy: Demo/POC Only

**This entire solution is a demo/test/POC, including every Azure deployment.
There is no production environment. Never remediate a deployed Azure environment
in place.** This policy applies to development, debugging, testing and deployment,
and takes precedence over in-place repair or migration guidance elsewhere.

- Fix source code, Bicep, seed scripts and deployment hooks so changes are
  reproducible through normal deployment. Do not patch Azure resources/settings,
  run ad hoc database migrations, launch repair jobs or perform one-off
  infrastructure repairs to make a deployed environment match local changes.
- Agents may run `azd deploy --no-prompt`, optionally targeting affected services,
  then test the deployed changes. Do not bypass deployment hooks with manual
  Azure CLI, REST, Portal or SQL changes.
- If changes require infrastructure provisioning or a fresh database/environment
  rather than `azd deploy`, stop and ask the user to recreate the environment.
  Agents must not run `azd provision`, `azd down`, `azd up` or the recreation
  sequence themselves. Teardown/recreation takes a long time and is user-only.
- Do not spend tokens designing or executing in-place remediation, migration,
  compatibility-draining or data-preservation workarounds for a disposable demo.
  Put required schema/setup changes in normal provisioning/seeding instead.
- Read-only Azure diagnostics and ordinary application/API testing, including
  controlled test-data mutations and cleanup, remain allowed. They are not a
  substitute for deploying source changes.

When recreation is required, explain why, warn that this permanently deletes the
current demo environment and its data, and provide this **user-run command only**:

```bash
OLD_ENV=$(azd env get-value AZURE_ENV_NAME) && OLD_SUB=$(azd env get-value AZURE_SUBSCRIPTION_ID) && NEW_ENV="adventureworks$((RANDOM % 900 + 100))" && azd down --force --purge --no-prompt && azd env remove "$OLD_ENV" --no-prompt --force && azd env new "$NEW_ENV" --no-prompt && azd env set AZURE_SUBSCRIPTION_ID "$OLD_SUB" && azd env set AZURE_LOCATION "eastus2" && azd env set FOUNDRY_LOCATION "swedencentral" && azd up --no-prompt
```

After the user completes deployment and the asynchronous seed job succeeds,
re-read the selected azd environment outputs and validate the new deployment.

## Architecture Overview

This is a **3-tier Azure application** demonstrating enterprise patterns with passwordless authentication:

- **Frontend** (`app/`): React + TypeScript + Vite SPA deployed as Azure Static Web App
- **Internal frontends** (`app-admin/`, `app-manufacturing/`): React + TypeScript + Vite SPAs served from Azure Container Apps
- **Backend API** (`api/`): Microsoft Data API Builder (DAB) providing GraphQL + REST, running in Azure Container Apps
- **Serverless Functions** (`api-functions/`): .NET 10 isolated Azure Functions on Flex Consumption for custom business logic, provisioned by `infra/modules/flex-api-functions.bicep`; published directly without a container image
- **OAuth + MCP** (`api-mcp/`): Self-contained OpenIddict authorization server and protected MCP tools, running in Azure Container Apps
- **AI**: Microsoft Foundry agent definitions plus the hosted `manufacturing-agent/`, deployed with `host: azure.ai.agent`
- **Database**: Azure SQL with AdventureWorks schema, Entra ID authentication and private networking
- **Infrastructure** (`infra/`): Bicep modules with modular service definitions

### Data Flow Pattern

```
User → Storefront / Admin / Manufacturing → GraphQL or REST (DAB) → Azure SQL
                                         ↘ Azure Functions → Azure SQL / Foundry agents
                                         ↕ Web PubSub (real-time push)
User → api-mcp OAuth → resource-bound user tokens for DAB / Functions / MCP
Azure Functions → api-mcp tools / hosted Manufacturing agent
```

Backend Azure-resource access uses **Managed Identity** (passwordless), with
deployment-configured SQL connection strings using `Authentication=Active Directory Default`.
Application-user authentication is separate: api-mcp verifies AdventureWorks database
credentials and issues audience-bound OAuth JWTs. DAB and Functions validate those
tokens; Functions is provisioned with `FUNCTIONS_OAUTH_MODE=enforced`, while explicit
public routes remain anonymous. Do not confuse this with Entra infrastructure authentication.

**Real-time push**: Azure Web PubSub (Free tier) pushes mutation events from Azure
Functions to all three frontends via WebSocket. The `WebPubSubService` singleton
sends group events from participating mutation paths. Storefront/manufacturing
dispatchers invalidate React Query caches; admin dispatches `webpubsub` DOM events
to page listeners. New live-data mutations must wire both producer and consumer.

### No Polling / No Manual Refresh Policy

**Do NOT use `refetchInterval` or manual polling on any page where Web PubSub real-time updates apply.** All data freshness must come from server-pushed cache invalidation via the `useRealTimeUpdates` hook. React Query's default window-focus refetch provides a natural fallback when users return to the tab.

When adding a new query that needs live updates:

1. Register the query key in the appropriate group handler in `app-manufacturing/src/hooks/useRealTimeUpdates.ts` or `app/src/hooks/useRealTimeUpdates.ts`; in admin, handle the corresponding `webpubsub` DOM event in the page
2. Ensure the server-side mutation calls `WebPubSubService.SendToGroupAsync` for the relevant group
3. Do NOT add `refetchInterval` — the Web PubSub event-driven invalidation replaces polling entirely

## Critical Development Workflows

### Local Development Setup

**IMPORTANT**: Local development relies on Azure-hosted demo services. Agents must
not remove, manually repair or recreate those resources. Follow the
[demo/POC environment policy](#azure-environment-policy-demopoc-only): deploy
service changes with `azd deploy`, or ask the user to recreate the environment.

**Environment configuration:**

Testing normally targets Azure-hosted services. `azd up` persists deployment outputs
and hook-generated settings in the selected azd environment; it does **not** export
them into every interactive shell. Read only needed values using
`azd env get-value KEY --no-prompt` or use the authenticated helper below.

- Endpoints: `API_URL` (already includes `/graphql/`), `API_FUNCTIONS_URL`,
  `API_MCP_URL` / `MCP_SERVICE_URL` (includes `/mcp`), `APP_URL`, `APP_ADMIN_URL`,
  `APP_MANUFACTURING_URL`, `MCP_INSPECTOR_URL`.
- Resources: `AZURE_RESOURCE_GROUP`, `AZURE_SUBSCRIPTION_ID`, `SQL_SERVER_NAME`,
  `SQL_DATABASE_NAME`, `STORAGE_ACCOUNT_NAME`, `USER_MANAGED_IDENTITY_NAME`,
  `AZURE_CLIENT_ID`, `SERVICE_API_NAME`, `SERVICE_API_FUNCTIONS_NAME`,
  `SERVICE_API_MCP_NAME`, `SERVICE_SEED_JOB_NAME`.
- AI: `AI_FOUNDRY_PROJECT_ENDPOINT`, `AI_AGENT_*_ID`, `chatGptDeploymentName`,
  `MANUFACTURING_AGENT_ENDPOINT` (published from
  `AGENT_MANUFACTURING_AGENT_RESPONSES_ENDPOINT`), and model-selection inputs
  `chatGptModelName`, `embeddingDeploymentModelName`, `imageDeploymentModelName`,
  `FOUNDRY_LOCATION`.
- Integration: `APPLICATIONINSIGHTS_CONNECTION_STRING` /
  `APPINSIGHTS_CONNECTIONSTRING`, `COMMUNICATION_SERVICE_ENDPOINT`,
  `EMAIL_SENDER_DOMAIN`, `WEB_PUBSUB_HOST_NAME`,
  `MCP_SIGNING_KEY_VAULT_NAME`, `MCP_SIGNING_CERTIFICATE_NAME`.

Not every runtime setting is an azd output. DAB reads `DATABASE_CONNECTION_STRING`
and `DAB_JWT_ISSUER` / `DAB_JWT_AUDIENCE`; Functions reads
`SQL_CONNECTION_STRING`, identity-based `AzureWebJobsStorage__*` and
`FUNCTIONS_JWT_*` / `FUNCTIONS_OAUTH_MODE` from its app settings.
For local Functions configuration, start from
`api-functions/local.settings.example.json`; never commit populated settings.
SQL public networking is disabled after deployment, so local credentials alone
do not provide direct SQL connectivity. Prefer deployed APIs rather than reopening SQL.

**For Azure Functions (api-functions) local development:**

The Functions project requires `MCP_SERVICE_URL` to connect to the Model Context Protocol server for AI agent capabilities. **Use the Azure-hosted MCP service** rather than running it locally:

```bash
# Get the MCP service URL from Azure
azd env get-value MCP_SERVICE_URL --no-prompt
```


### Azure Deployment (azd)

The app uses **azd lifecycle hooks** for automated deployment orchestration:

```bash
azd deploy --no-prompt  # Agent-allowed service deployment using existing infrastructure
azd up --no-prompt      # User-only full lifecycle; seed execution continues asynchronously
```

The lifecycle below describes the user's full deployment. It does not authorize
agents to provision or recreate infrastructure; follow the demo/POC policy above.

**Important:** Always use `--no-prompt` for unattended deployment. Required missing
values or unsupported decisions can still fail; do not assume every prompt or
warning is automatically accepted. Deployment and seed durations vary.

**Hook execution order:**

1. `scripts/hooks/preup.sh` - Persists user context and selects available AI models/capacity
2. `azd provision` - Deploys Bicep infrastructure
3. `scripts/hooks/postprovision.sh` - Configures SQL roles, Key Vault signing material,
   starts the seed job asynchronously and prepares Foundry agents
4. `scripts/hooks/predeploy.sh` - Generates storefront build/runtime configuration
5. `azd deploy` - Remote-builds Container Apps, publishes Functions, builds/deploys
   the Static Web App and deploys the hosted Manufacturing agent; service-specific
   postdeploy hooks apply their configuration
6. `scripts/hooks/postdeploy.sh` - Wires OAuth redirects and the hosted-agent endpoint,
   then reapplies Functions agent settings
7. `scripts/hooks/postup.sh` - Ensures the hosted agent exists, disables public SQL
   access/removes the temporary client firewall rule, and reports service/seed status

**Key distinction**: Container services such as `api/` and `api-mcp/` build with **remote build** in ACR (see `azure.yaml`). The `api-functions/` .NET project publishes directly to Azure Functions Flex Consumption (`host: function`); it has no Dockerfile or Container App deployment. The `app/` builds locally then deploys to Static Web Apps.

**Note:** The seed-job runs asynchronously in the background. Monitor its progress with:

```bash
az containerapp job execution list --name <seed-job-name> --resource-group <resource-group>
```

For complete details on the seed-job architecture and data loading process, see [seed-job/README.md](../seed-job/README.md).

### Getting Azure Resource Information

Read selected deployment outputs without dumping unrelated settings:

```bash
azd env get-value API_URL --no-prompt
azd env get-value API_FUNCTIONS_URL --no-prompt
```

Key values include:

- `API_URL` - DAB GraphQL endpoint in Azure Container Apps; strip `/graphql/` for the REST base
- `API_FUNCTIONS_URL` - Azure Functions Flex Consumption endpoint
- `AZURE_RESOURCE_GROUP` - Resource group name
- `API_MCP_URL` - OAuth/MCP endpoint; strip `/mcp` for the OAuth base

**Important**: DAB list queries default to **100 items per page**; this is not a
guaranteed total count or universal hard maximum. Use GraphQL `first` / `after` with
`hasNextPage` / `endCursor`, or REST `$first` / `$after` and the returned next link,
to follow all pages. Filters can narrow a query but do not establish the total:

```graphql
# This returns a default page, not necessarily all products
query {
  products {
    items {
      ProductID
      Name
    }
  }
}

# Use filters to check for additional records
query {
  products(filter: { ProductID: { gt: 100 } }) {
    items {
      ProductID
    }
  }
}
```

### VS Code Tasks

Use built-in tasks for development (accessible via `Cmd/Ctrl+Shift+B`):

- `func: host start` - Run Azure Functions locally (depends on build task)
- `start frontend` - Run React dev server
- `start api (DAB)` - Run local DAB server
- `build all` - Builds `api-functions/api-functions.csproj` only (despite the label)

These are local tasks, not proof of deployed-service behavior. The frontend task
starts only `app/`; start admin/manufacturing from their own package scripts.

## Project-Specific Conventions

### GraphQL API (DAB Naming)

**Critical**: DAB auto-generates schema from database tables with specific naming rules:

```typescript
// Database: ProductCategory → GraphQL: productCategories (camelCase + plural)
// Database: Person → GraphQL: people (irregular plural)
// Always use .items for list queries:
const { productCategories } = await client.request(gql`
  query {
    productCategories {
      items {
        ProductCategoryID
        Name
      }
    }
  }
`);
```

See [DAB naming conventions](../docs/architecture/DAB_NAMING_CONVENTIONS.md) for complete rules.

### Configuration Files Pattern

The project uses deployment/build/runtime configuration:

- `api/dab-config.json` (demo CORS allows all origins without credentials; JWT auth
  is enabled with api-mcp issuer/audience and entity-specific role permissions)
- `app/.env` (optional local Vite overrides; azd values are not automatically
  inherited by `npm run dev`)
- `app/.env.production` (generated by the predeploy hook)
- `app/public/config.js` (generated runtime configuration for the storefront);
  admin/manufacturing container startup scripts generate their runtime configuration

**Never hardcode URLs** - always use environment variables or runtime config.

### Azure Functions Structure

Functions follow **isolated worker model** with dependency injection:

```csharp
// Program.cs registers services
builder.Services.AddScoped<AddressService>(sp => {
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new AddressService(connectionString);
});

// Functions receive via constructor injection
public AddressFunctions(ILogger<AddressFunctions> logger, AddressService service)
```

Connection string uses **Active Directory Default** authentication (Managed Identity in Azure, Azure CLI locally).

### Loading Skeletons (app-manufacturing)

**Every page that fetches async data must show a loading skeleton** while data is in-flight. This is a hard convention for the manufacturing app.

**Available skeleton components** — import from `@/components/LoadingSkeletons`:

| Component             | Use for                                          |
| --------------------- | ------------------------------------------------ |
| `TableSkeleton`       | Any table/list view (configurable `rows`/`cols`) |
| `CardGridSkeleton`    | Grid of cards (configurable `count`)             |
| `KpiSkeleton`         | KPI metric cards (configurable `count`)          |
| `DetailPageSkeleton`  | Detail pages: header + stats + table             |
| `SidebarListSkeleton` | Sidebar navigation lists                         |
| `ChartSkeleton`       | Chart/graph containers                           |
| `DashboardSkeleton`   | Full dashboard layout                            |
| `ScheduleSkeleton`    | Schedule/calendar layouts                        |
| `ShopFloorSkeleton`   | Shop floor operation card grids                  |

The base `Skeleton` primitive is also available from `@/components/ui/skeleton` for custom layouts.

**Pattern to follow:**

```tsx
import { DetailPageSkeleton, TableSkeleton } from '@/components/LoadingSkeletons';

const MyPage = () => {
  const { data, isLoading } = useQuery({ ... });

  // Early-return skeleton for full-page loading states
  if (isLoading) return <DetailPageSkeleton />;

  // For partial/panel loading states, use inline branches:
  // {isLoading ? <TableSkeleton rows={6} cols={4} /> : <table>...</table>}
  return (...);
};
```

- **Full-page loads**: early-return the appropriate skeleton before the main JSX
- **Panel/section loads**: use a ternary in the JSX — `{isLoading ? <Skeleton> : <Content>}`
- **Multiple queries**: derive a combined flag — `const isLoading = queryA.isLoading || queryB.isLoading`
- Static pages (login, 404, settings with no async data) do not need skeletons
- Pages that only display a selection prompt before data loads (e.g. "select a product first") should show a skeleton only after the user has made a selection and data is actively loading

### Real-Time Push Pattern (Web PubSub)

All three frontends connect to Azure Web PubSub via the `useWebPubSub` hook. When server-side mutations occur, the `WebPubSubService` singleton pushes JSON events to topic groups. The `useRealTimeUpdates` dispatcher hook maps events to `queryClient.invalidateQueries()` calls, triggering React Query to refetch.

**Server-side pattern** — inject `WebPubSubService`, call `SendToGroupAsync` after mutations:
```csharp
await _webPubSub.SendToGroupAsync("manufacturing-ops", new { @event = "wo-completed", workOrderId });
```

Table-backed services also publish `state-changed` after successful persistence.
Transactional SQL triggers write direct DAB changes to `dbo.RealtimeNotificationOutbox`;
the single `DatabaseChanges` SQL listener publishes `database-changed`. Extend its
entity/group map and seed setup rather than adding per-table SQL listeners.
Provision the outbox, DML triggers, Change Tracking and lease tables/grants in the
seed job, not at runtime. Both `DatabaseChanges` and `OrderPlacedSqlTrigger` require
their own Flex always-ready scale groups (two instances total).
Signals must not contain private records, tokens or Durable management URLs.
For utility workflows, preserve replay safety and launch new instances with
`push-v1`; set the Durable worker's `defaultVersion` to `push-v1` and use
`versionMatchStrategy: CurrentOrOlder` so new jobs run and old histories still
replay. If a change requires fresh orchestration state or database setup, ask the
user to recreate the demo environment; do not drain or migrate deployed instances.
See [Functions real-time rollout](../api-functions/README.md#web-pubsub-changes-and-polling-free-frontends).

**Client-side pattern** — `useRealTimeUpdates()` is mounted in each app's root.
Storefront/manufacturing use React Query invalidation. Admin query caches use the
root dispatcher; status pages/jobs use `useLiveUpdates` for the `webpubsub` DOM
event. Register listeners before the initial read. Use fixed-window event batching
(not trailing debounce), serialize status reads and retain a follow-up when a
change arrives during a read. Do not periodically request data or add manual
refresh buttons to push-backed pages. Display-only elapsed/health clocks are
allowed; they must not make network calls.

Connections/reconnections invalidate the affected caches; visible-window focus
recovers status reads and React Query provides its normal focus refetch. All apps
show a live-updates-unavailable notice on connection failure. Negotiation failure
does not automatically install polling. Durable utility status subscriptions
filter `utilities` events by `instanceId` and notify completion once per instance.

**Regression check**: run
`node --experimental-vm-modules --test tests/scripts/test-live-updates.mjs`.
It verifies batching, in-flight follow-ups, reconnect/focus recovery and cleanup,
and rejects recurring network polling across all three frontend source trees.

**Groups**: `manufacturing-agent`, `manufacturing-ops`, `warehouse`, `supply-chain`,
`orders`, `shopping-simulator`, `reviews`, `finance`, `promotions`, `utilities`.
The allow-list is `WebPubSubService.AllowedGroups`; each app subscribes to its subset.

**Negotiate endpoint**: `GET /api/webpubsub/negotiate?groups=manufacturing-agent,warehouse,...`

### Bicep Infrastructure Patterns

Infrastructure uses **modular decomposition** in `infra/modules/`.
`infra/main.bicep` orchestrates identity, database, private networking, storage,
Container Apps, Functions and AI modules. Follow each module's declared parameters:
for example, the database module receives `identityName` and `seedIdentityName`,
while the storage module receives `identityId`.

**Key parameters** injected by azd from environment:

- `chatGptModelName`, `embeddingModelName`, `imageModelName` - mapped from
  preup-selected azd values in `infra/main.parameters.json`
- `aadAdminObjectId` - current user's Entra object ID from `OBJECT_ID`
- `foundryLocation` - from `FOUNDRY_LOCATION`

Use `infra/main.parameters.json` as the actual azd-to-Bicep mapping; do not invent
parameter names or assume every module parameter is an azd environment value.

### Infrastructure-as-Code Policy

All Azure Storage resources (queues, tables, blob containers) are provisioned **exclusively** by `infra/modules/storage.bicep` via `azd up`. Application code must **never** call `CreateIfNotExistsAsync`, `CreateIfNotExists`, or `CreateTableIfNotExistsAsync` — it must assume all infrastructure already exists at runtime.

- **New queue or table needed?** Add application queues to `applicationQueueDescriptions`
  (the module derives their queues and poison queues), or tables to
  `tableServices.tables` in `storage.bicep`. Update the corresponding
  `DependencyHealthService.Application*` list so startup/readiness checks stay aligned.
- **New blob container needed?** Add it to `blobServices.containers` in `storage.bicep`.
- **Startup health check**: `Program.cs` uses `DependencyHealthService.Application*`
  resource lists, checks queues/containers with `GetPropertiesAsync()` and tables with
  `GetAccessPoliciesAsync()`, and logs warnings on failed checks. These checks run
  during startup but do not fail startup or create resources.
- **Why**: Each `CreateIfNotExistsAsync` adds an unnecessary HTTP round-trip (HEAD + conditional PUT). During simulation workloads that send hundreds of queue messages per minute, this overhead is significant.

## Common Integration Points

### Frontend ↔ GraphQL API

The storefront uses `graphql-request` through `app/src/data/apiService.ts`,
with React Query hooks for caching:

```typescript
// app/src/hooks/useProducts.ts
export const useProducts = () => {
  return useQuery<Product[]>({
    queryKey: ["products"],
    queryFn: () => apiService.getProducts(true),
    staleTime: 2 * 60 * 1000, // 2 min cache
  });
};
```

**DAB GraphQL list queries** return `{ items: [] }` wrappers; unwrap `.items`
inside the data service. Hooks return application arrays, while DAB REST uses
its own `value` / next-link response shape. Manufacturing commonly uses REST.

### Database Schema Context

Uses **AdventureWorks schema** with namespaced tables:

- `Production.Product`, `Production.ProductCategory`
- `Person.Person`, `Person.Address`
- `Sales.SalesOrderHeader`

DAB entities map to these via `dab-config.json` source definitions:

```json
"Product": { "source": { "object": "Production.Product", "type": "table" } }
```

**Note**: `Person.Address` is **excluded from DAB** because the `SpatialLocation` column uses the SQL `geography` type which DAB does not support. Address data is accessed exclusively via the `AddressFunctions` Azure Function.

### Managed Identity Authentication Flow

Backend data-plane access uses passwordless auth:

1. **DAB, Functions and api-mcp** use the provisioned runtime user-assigned MI;
   api-mcp reads Key Vault signing material using its configured managed identity
2. **SQL Database** grants roles in `postprovision.sh`:
   ```sql
   CREATE USER [mi-name] FROM EXTERNAL PROVIDER;
   ALTER ROLE db_datareader ADD MEMBER [mi-name];
   ```
3. **Connection strings** use `Authentication=Active Directory Default`
4. **Local SDK clients** can use `DefaultAzureCredential` / `az login` where network
   access and RBAC permit; this does not authenticate an application user or bypass
   the deployed private SQL network

## Testing & Debugging

### Authenticated Azure Deployment Calls

**Use `python3 scripts/utilities/azure-auth.py` when calling auth-protected endpoints
in the deployed azd environment.** The helper reads the selected local azd environment
(or `--environment NAME`), authenticates against api-mcp with login + PKCE, and obtains
the correct resource-bound token. Do not use an Entra `az account get-access-token`
token to impersonate an AdventureWorks database user, disable auth, or source/print
the entire azd `.env`.

- Prefer `--identity manufacturing` (seeded Peter, `manufacturing-engineer`) for
  manufacturing/inventory/supply-chain testing. Use `--identity admin` (seeded Ken,
  `executive-admin`) for customers/orders/reporting/admin or broader internal operations.
  Neither account bypasses ownership, self-only checks or business rules. Do not
  silently retry a forbidden operation as the more privileged identity.
- Prefer `request --identity ... --resource functions|dab --path /...`; this keeps
  tokens in memory and adds the DAB `X-MS-API-ROLE` header automatically.
- Use `token` for curl/other scripts, `token --json` plus `refresh` for long-running
  sessions. DAB, Functions and MCP need separate audiences. `/api/agent/chat` requires
  an MCP-audience token for delegated calls, not the normal Functions token.
- Never print tokens/refresh sessions/passwords, enable shell tracing, commit
  credentials or forward bearer tokens to other hosts. Prefer read-only verification;
  mutations, simulator starts and AI calls need intentional scope.
- Full examples, canned demo identities, curl usage, renewal, exceptions and tests:
  [Authenticated local scripts](../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md).

### Test Scripts

Test scripts live under `tests/scripts/`, not the repository root:

- `tests/scripts/auth-smoke-tests.sh` - OAuth discovery and authenticated access;
  includes AI calls, so it is not a purely read-only/cost-free check
- `tests/scripts/test-health-diagnostics.sh` - Read-only deployment health checks
- `tests/scripts/test-password-functions.sh` - Password checks; requires a disposable
  consumer's token and BusinessEntityID, not a canned internal identity
- `tests/scripts/test-password-reset-flow.sh` - Reset flow; requires explicit test inputs
- `tests/scripts/README.md` - Current test prerequisites and commands
- `.NET` tests: `api-functions.Tests/` and `api-mcp/AdventureWorks.Tests/`

**Run functions locally** with the `func: host start` task, which auto-builds before starting.

### Verifying GraphQL Endpoints

Use the authenticated helper examples below for focused queries. There is no
`api/test-graphql-endpoints.sh` in the current tree. Check GraphQL `errors`, role
permissions, list `.items` and pagination rather than treating HTTP 200 as success.

### Examining the Azure Database

**Direct SQL access from a dev container is normally blocked by private networking
after deployment**, even with valid Entra credentials. Use the deployed DAB API;
do not reopen SQL public access for routine testing:

```bash
# Query via authenticated GraphQL (API_URL already contains /graphql/)
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource dab --path /graphql --method POST \
  --data '{"query":"{ products(first: 5) { items { ProductID Name } } }"}'

# Or use authenticated REST
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource dab --path '/api/Product?$first=5'
```

**Remember**: Default list pages contain up to 100 items; follow all cursors/next
links to establish full counts. Primary-key filters only test for matching records.

### Application Insights Integration

DAB and Functions auto-send telemetry. Check logs:

```bash
az monitor app-insights query --app <app-name> --analytics-query "requests | top 50 by timestamp desc"
```

The storefront has a `/health` diagnostics page; admin/manufacturing do not
currently define that route. Use the sanitized Functions
`/api/health/readiness` and MCP `/ready` contracts for dependency readiness;
liveness alone does not prove SQL/storage/OAuth readiness. Keep AI/email functional
checks opt-in. See [health diagnostics](../docs/features/monitoring/HEALTH_DIAGNOSTICS.md).

## Common Gotchas

1. **DAB config during local dev**: Use the existing `api/dab-config.json`; supply its environment placeholders and use the configured OAuth issuer/audience. Do not disable auth to fix local failures.
2. **GraphQL query failures**: Check for `.items` in response - DAB wraps all lists
3. **API pagination**: DAB defaults to 100 items per list page; follow GraphQL cursors or REST next links, not an assumed hard maximum or a single-page count.
4. **DAB 1.7 OData pagination parameter**: Use `$first` instead of `$top` for limiting results in REST calls (e.g. `?$first=10`). DAB 1.7+ replaced `$top` with `$first`. `$skip` is also unsupported — use `$after` for cursor-based pagination.
5. **Address entity not in DAB**: `Person.Address` is excluded from DAB because the `SpatialLocation` (`geography`) column is unsupported. Use the `AddressFunctions` Azure Function for address data instead.
6. **Direct SQL access**: Deployment disables public SQL access; use deployed DAB/Functions instead of reopening networking.
7. **Build failures**: `dotnet build` restores by default; use `restore (functions)` when diagnosing missing dependencies or building with `--no-restore`.
8. **Connection errors**: Azure SDK access may need renewed `az login`; application API tokens instead renew through api-mcp OAuth. They are different credentials.
9. **Missing env vars**: DAB reads `@env()` placeholders from container configuration; azd state is not automatically exported into a local shell. Read only required azd values.
10. **Shopping Simulator AI requirement**: `OrderGenerationAgentService` requires `AI_AGENT_ORDER_ID` for all modes; no random-order fallback is implemented. Structured planning failures are saved as failed simulator results with failure codes; unhandled queue exceptions are rethrown for runtime retry/poison handling.
11. **Shopping Simulator auto-stop**: The simulator always auto-stops after the configured `durationHours` (default 24h, max 72h). It never runs forever — this is a cost protection feature checked every timer tick (1 minute).
12. **Order Status=7 is "Delivered"**: Orders are automatically promoted from Shipped (5) to Delivered (7) by the hourly `OrderDelivery_Timer` function. Terminal statuses are now 4 (Rejected), 6 (Cancelled), and 7 (Delivered) — Status=5 (Shipped) is no longer a terminal state. Delivery windows are configurable per order type via `PUT /api/orders/pipeline/config`.
13. **Order notification emails disabled by default**: `ORDER_NOTIFICATIONS_EMAIL_ENABLED` must be explicitly set to `"true"` to send Shipped/Delivered emails via Azure Communication Services. When unset or `"false"`, the intended email content is logged at Info level instead (look for `[EmailNotifications disabled]` in Application Insights). This prevents the Shopping Simulator from generating email spam. The Flex Consumption template does not enable the flag; enabling it requires an explicit Function App setting via Azure Portal or CLI. See [order notifications](../docs/features/email/ORDER_NOTIFICATIONS.md).
14. **Web PubSub Free tier limits**: 20 concurrent connections, 20K messages/day across all three apps. High-rate simulations can exhaust this; do not assume the Free tier is sufficient for sustained workloads. Failed negotiation reports live updates unavailable; it does not automatically install polling. Preserve the no-polling policy above.
15. **No runtime infra creation**: Application code must not call `CreateIfNotExistsAsync` or `CreateIfNotExists` on storage resources (queues, tables, containers). All storage infrastructure is provisioned by `infra/modules/storage.bicep` via `azd up`. If you need a new queue or table, add it to the Bicep file. A startup health check in `Program.cs` logs App Insights warnings for any missing resources.

### Shopping Simulator

The shopping simulator (`POST /api/shopping-simulator/start`) generates continuous AI-driven orders. Configuration:

- **Duration**: 1–72 hours (default 24). Auto-stops to prevent runaway costs.
- **Order types**: Consumer (B2C) and/or B2B store orders. At least one must be enabled.
- **Consumer mix**: Existing top-spenders, new random personas, no-order customers drawn to sales, and abandoned-cart recoveries.
- **B2B stores**: AI generates representative replenishment orders based on each store's purchase history and current inventory.
- **State**: Persisted in Azure Table Storage (`shoppingSimulator` table). Queue: `simulation-order-queue`.
- **Admin UI**: `app-admin/src/pages/ShoppingSimulatorPage.tsx` — sliders, toggles, live stats, and results feed.

## Documentation Map

- [QUICKSTART.md](../QUICKSTART.md) - Azure deployment and exploration
- [app/README.md](../app/README.md) - Storefront setup and features
- [api/README.md](../api/README.md) - DAB deployment details
- [DAB naming conventions](../docs/architecture/DAB_NAMING_CONVENTIONS.md) - GraphQL schema rules
- [OAuth server](../docs/features/mcp-oauth/README.md) - User identities, resource tokens and tool policies
- [Functions OAuth](../docs/features/functions-oauth/README.md) - Route scope/category/ownership enforcement
- [Authenticated local scripts](../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md) - azd-based testing helper
- [Health diagnostics](../docs/features/monitoring/HEALTH_DIAGNOSTICS.md) - Readiness checks and frontend diagnostics
