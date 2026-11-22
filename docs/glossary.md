---
title: AdventureWorks glossary
summary: Definitions of the terms used throughout the AdventureWorks demo documentation — Data API builder, Azure Functions, real-time eventing, OAuth and MCP, Foundry agents, manufacturing concepts, order statuses and deployment.
audience: [developer, operator, demo-presenter, security-reviewer, ai-agent]
components: [app, app-admin, app-manufacturing, api, api-functions, api-mcp, mcp-inspector, manufacturing-agent, seed-job, infra]
related: [README.md, architecture/system-overview.md, architecture/identity-and-auth.md, architecture/realtime-eventing.md, architecture/ai-architecture.md]
---

# AdventureWorks glossary

This glossary defines the terms used across the AdventureWorks documentation. Terms are grouped by
area and listed alphabetically within each group. See the [documentation hub](README.md) for the
pages that cover each area in depth.

## Data access

| Term | Definition |
| --- | --- |
| **DAB (Data API builder)** | Microsoft's open-source engine that exposes database tables and views as GraphQL, REST and MCP endpoints from a JSON configuration (`api/dab-config.json`). The `api` service runs it on Container Apps. See [Data API builder](services/dab-api.md). |
| **Entity** | A DAB configuration entry that maps one database object (for example `Production.Product`) to a GraphQL type and REST path, with per-role permissions. The demo defines 69 entities. See [DAB entities](reference/dab-entities.md) and [naming conventions](architecture/dab-naming-conventions.md). |
| **`X-MS-API-ROLE`** | HTTP header that tells DAB which role from the caller's token to evaluate permissions under (for example `executive-admin` or `consumer`). Without it DAB uses the `authenticated` system role. |
| **AdventureWorks schema** | The Microsoft sample database schemas used by the demo: `Production`, `Sales`, `Person`, `Purchasing` and `HumanResources`, plus demo extensions in `dbo`. |

## Azure Functions and eventing

| Term | Definition |
| --- | --- |
| **Flex Consumption** | The Azure Functions hosting plan used by `api-functions`: per-function scaling, VNet integration and optional always-ready instances. See [Azure Functions](services/functions.md). |
| **Always-ready instance** | A Flex Consumption instance kept running for a specific function group. The demo keeps two: one for the `OrderPlacedSqlTrigger` order listener and one for the `DatabaseChanges` outbox listener. |
| **Durable Functions / `push-v1`** | Durable Functions run long utility workflows (for example language-file translation). `push-v1` is the orchestration version new instances start with; the worker uses `CurrentOrOlder` matching so older histories still replay. |
| **Outbox** | The `dbo.RealtimeNotificationOutbox` table. Database triggers write a row whenever selected tables change, so changes made directly through DAB still produce real-time events. |
| **DatabaseChanges** | The single SQL-trigger function that watches the outbox, maps each changed entity to Web PubSub groups and publishes a `database-changed` event. |
| **Web PubSub hub / group** | Azure Web PubSub delivers WebSocket messages. The demo uses one hub, `adventureworks`, and ten groups (for example `orders`, `manufacturing-ops`, `warehouse`); a client joins only the groups its token allows. See [Real-time eventing](architecture/realtime-eventing.md). |
| **Coalescing** | Server-side batching of bursts of the same event: the first event is sent immediately and later ones within five seconds collapse into one trailing event. |
| **NotifyingTableClient** | A wrapper around an Azure Table Storage client that publishes a `state-changed` event to a Web PubSub group after each successful write, so table-backed state (simulator, pipeline, agent configuration) updates the apps live. |
| **No-polling policy** | Frontends never refresh on a timer. They re-read data only when a Web PubSub event arrives, on reconnect, or when the browser window regains focus. |

## Identity, OAuth and MCP

| Term | Definition |
| --- | --- |
| **Managed identity** | An Entra ID identity assigned to an Azure resource. Services use it to reach SQL, Storage, Key Vault, Web PubSub and Foundry without secrets. |
| **`Sql.SessionPrincipal`** | An Application Insights custom event from api-mcp, Functions and the seed job. It records whether the SQL principal behind a connection matches the service's managed identity (`AZURE_CLIENT_ID`), using hashes only. See [monitoring](operations/monitoring.md#sql-session-principal-sqlsessionprincipal). |
| **Resource / audience** | api-mcp issues tokens for one of three resources — `{api-mcp}/mcp`, `{api-mcp}/dab` or `{api-mcp}/functions`. Each API accepts only tokens whose audience is its own resource. |
| **Scope** | A permission string in a token (for example `orders.read`, `manufacturing.write`, `realtime.connect`). The demo defines 14 scopes; a user's role decides which ones they can receive. |
| **Role** | The user's application role, derived from their database record: `consumer`, `sales-admin`, `marketing-admin`, `inventory-admin`, `operations-admin`, `executive-admin` or `manufacturing-engineer`. |
| **Category** | The kind of principal in a token: `consumer` (shoppers), `employee` (admin staff), `manufacturing` (manufacturing staff) or `service` (backend workloads). Each portal accepts only its categories. |
| **Trusted client** | A first-party OAuth client (the storefront, admin, manufacturing and Inspector apps) that skips the consent page and may receive refresh tokens. |
| **PKCE** | Proof Key for Code Exchange: the authorization-code protection (S256) used by the admin, manufacturing and Inspector sign-ins. |
| **E-shop credentials grant** | A custom OAuth grant (`urn:adventureworks:params:oauth:grant-type:eshop-credentials`) that lets the storefront exchange a consumer's email and password directly for tokens. |
| **Managed-identity grant** | A custom OAuth grant (`urn:adventureworks:params:oauth:grant-type:managed-identity`) that exchanges an Entra managed-identity token from a trusted workload (Functions or the hosted agent) for an MCP token with category `service`. |
| **MCP (Model Context Protocol)** | An open protocol for exposing tools to AI clients. api-mcp hosts 63 tools; DAB also exposes an MCP endpoint. See [api-mcp](services/api-mcp.md). |
| **MRTR elicitation** | An MCP request for user input: destructive tools (such as starting a manufacturing run) ask the client to confirm before acting unless the call already includes `confirmed=true`. |
| **MCP Tasks** | MCP support for long-running tool calls that return a task the client can check later. api-mcp stores tasks in the `awMcpTasks` table, bound to the caller that created them. |

## AI and agents

| Term | Definition |
| --- | --- |
| **Microsoft Foundry** | Azure's AI platform. The demo deploys a Foundry account and project with chat and embedding models (and an optional image model). |
| **Prompt agent** | A Foundry agent defined by instructions, a model and optionally MCP tools — for example the storefront chat agent or the promotion agent. |
| **Workflow agent** | A Foundry agent defined in YAML (`workflows/`) that routes a conversation between other agents. |
| **Intent agent** | A small classifier agent used inside a workflow to decide which agent should handle a request. |
| **Hosted agent** | Agent code that Foundry runs for you. The demo's hosted Manufacturing agent (`manufacturing-agent/`) is deployed with `host: azure.ai.agent`. See [Hosted Manufacturing agent](services/manufacturing-agent.md). |
| **Agent mode** | How much the Manufacturing agent may do: **Off** (0), **ReadOnly** (1, observe and report), **ProposePending** (2, propose actions for human approval) or **FullyAutonomous** (3, act directly until the auto-shutoff time). |
| **Proposal** | An action suggested by the Manufacturing agent in ProposePending mode, such as starting a production run or placing a purchase order. A person approves or rejects it; unanswered proposals expire after five minutes. |
| **Autonomy guard** | A check in api-mcp that allows the hosted agent to start production runs or place supply orders only while the agent is in FullyAutonomous mode and before its auto-shutoff time. |
| **RAI policy** | A Responsible AI content-filter policy in Foundry. The storefront chat uses the `AdventureWorks-Eshop` policy to block jailbreaks, harmful content and code output. |

## Manufacturing

| Term | Definition |
| --- | --- |
| **Work order** | A request to manufacture a quantity of a product by a due date (`Production.WorkOrder`). Starting a finished good creates work orders for its sub-assemblies too. |
| **Routing** | The sequence of operations at work-center locations that a work order passes through (`Production.WorkOrderRouting`). |
| **BOM (bill of materials)** | The list of components and quantities needed to build a product (`Production.BillOfMaterials`). |
| **Scrap** | Units lost during an operation, recorded with a scrap reason. Scrap rates are configurable per location. |
| **MakeFlag** | Product column that is true when AdventureWorks manufactures the item rather than buying it. Only products with `MakeFlag` can start a production run. |
| **Seven stages** | The manufacturing portal's flow: Define, Engineer, Plan, Execute, Supply, Receive and Warehouse. |

## Orders

| Status | Meaning |
| --- | --- |
| **1 Pending** | Order placed and awaiting processing. |
| **2 Approved** | Accepted; awaiting warehouse pick. |
| **3 Backordered** | Waiting for stock. |
| **4 Rejected** | Declined during processing (terminal). |
| **5 Shipped** | Picked and shipped; awaiting delivery. |
| **6 Cancelled** | Cancelled (terminal). |
| **7 Delivered** | Delivered after the configured delivery window (terminal). |

See [Order lifecycle](features/commerce/order-lifecycle.md).

## Deployment

| Term | Definition |
| --- | --- |
| **azd (Azure Developer CLI)** | The CLI that provisions and deploys the demo from `azure.yaml` and `infra/`. |
| **azd hook** | A script that azd runs at a lifecycle point — `preup`, `postprovision`, `predeploy`, `postdeploy`, `postup` and per-service hooks — all in `scripts/hooks/`. See [Deployment](operations/deployment.md). |
| **Seed job** | A Container Apps job that loads the AdventureWorks database, product images and demo extensions after provisioning. It runs asynchronously. See [Seed job](services/seed-job.md). |
| **`SEED_SKIP_EXISTING`** | Seed-job setting that, when `true`, keeps data already present and applies only the missing parts on a re-run. |
| **Demo/POC environment** | Every deployment is disposable: changes are made in source and redeployed, and environments are recreated rather than repaired in place. |
