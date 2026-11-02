# AdventureWorks Infrastructure (`infra`)

This folder contains the Infrastructure‑as‑Code for the AdventureWorks e‑commerce solution, written in **Azure Bicep** and orchestrated by **Azure Developer CLI (azd)**.

For a visual overview of all Azure components and their network topology, see the [architecture diagram](../docs/AdventureWorks-Reference-Architecture.svg).

At a high level, these templates provision:

- An Azure Container Apps environment hosting:
  - Data API Builder (`api`) container
  - MCP server (`api-mcp`) container
  - Admin portal (`app-admin`) container (scale-to-zero)
- An Azure Functions Flex Consumption app (`api-functions`) for the .NET isolated backend
- An Azure Static Web App for the React frontend (`app`)
- Azure SQL Database with the AdventureWorks schema
- Azure OpenAI / Azure AI resources
- Storage accounts for blobs and queues
- Azure Communication Services for email
- Application Insights and related monitoring
- Managed identities for passwordless authentication

## Private Azure SQL connectivity

`modules/sql-private-network.bicep` creates the VNet, the Container Apps and Flex Consumption integration subnets, an Azure SQL private endpoint, and the `privatelink.database.windows.net` zone linked to that VNet. The Data API Builder API, api-mcp server, and Seed Job use the integrated Container Apps environment; the Flex Consumption Functions app has its own VNet integration. Their existing SQL server FQDN continues to work through private DNS.

SQL public access is enabled while `azd up` runs, but the former `AllowAll` firewall rule is removed. The `postprovision.sh` hook discovers the deployment host's public IPv4 address (or accepts `SQL_CLIENT_IP` as an override), grants a temporary single-IP firewall rule for its SQL setup, then removes the rule on exit. Once service deployments finish, `postup.sh` disables SQL public network access. The deployment principal therefore needs permission to create/delete SQL firewall rules and disable public network access. A failed/interrupted `azd up` can leave public network access enabled; if the postup hook cannot complete, check SQL networking and remove any `AllowClient` rule manually.

After successful deployment, direct SQL clients outside the VNet (including local data-management scripts) cannot connect. Run those tools from a VNet-connected host or temporarily arrange approved access; do not restore the broad `AllowAll` rule.

## Private Azure Storage connectivity

`modules/storage.bicep` creates private endpoints for the shared account's blob, queue, table, and file services in the private-endpoint subnet provided by `modules/sql-private-network.bicep`. Each service has a corresponding `privatelink.<service>.core.windows.net` private DNS zone linked to the VNet. Existing storage endpoint URLs continue to work: clients within the integrated network resolve them to private endpoint addresses without changing application URLs.

The Flex Consumption Functions app uses its VNet integration for host storage, deployment packages, Durable Functions state, application queues and tables, receipts, and translations. The api-mcp Container App accesses its task table through the integrated Container Apps environment. The Seed Job mounts the `seed-job-logs` file share over SMB using the account key, while the seed-status Function reads it over HTTPS using its managed identity. Network connectivity does not replace authorization: the existing managed identity roles and file-share credentials are still required.

Unlike SQL's temporary deployment access, Storage public network access remains disabled throughout provisioning and deployment, the default network action is `Deny`, and anonymous blob access is disabled. Local Functions, Storage Explorer, utility scripts, and deployment agents that directly access storage require a VNet-connected host or a VPN with routing and private DNS forwarding. Managed identity, account keys, and SAS tokens do not bypass these network restrictions. Browser receipt downloads go through the Functions API rather than directly to blob storage. Do not re-enable public storage access to work around connectivity failures; check private DNS, network reachability, and authorization instead. See the Storage Consumer Inventory below for the resource-to-consumer mapping.

## Serverless SQL and idle cost behavior

`modules/database.bicep` provisions Azure SQL Database as General Purpose serverless with `autoPauseDelay: 60` minutes and a minimum capacity of `0.5` vCores. Auto-pause is therefore enabled, but it requires no active sessions and no user-workload CPU during the delay.

The `api-functions` module has an important exception to the otherwise scale-to-zero demo design. `modules/flex-api-functions.bicep` configures one always-ready Flex Consumption instance for `function:OrderPlacedSqlTrigger`. This Azure SQL trigger polls Change Tracking on `Sales.SalesOrderHeader` so that new orders reliably start receipt, order-status, and manufacturing-agent processing. Because the listener polls SQL while the environment is deployed, it can keep the SQL Database from auto-pausing even when the Container Apps show zero replicas and no one is using the frontends.

The hourly `OrderDelivery_Timer` and weekly `ArchiveTransactionHistoryTimer` also open SQL connections when their schedules fire. They are periodic wake-ups rather than the continuous cause. The shopping simulator timer is stopped by default and reads its idle state from Table Storage before doing any SQL work.

### Recommended lifecycle for this demo

The deployment is intended to be used intermittently. To avoid paying for an idle deployed environment, delete it when the demo is not needed and recreate it for the next session:

```bash
azd down --no-prompt
azd up --no-prompt
```

This is a resource-lifecycle workaround, not a change to the application. Do not run `azd down` during local development that depends on the deployed Azure resources. The seed job and deployment hooks will run again during `azd up`.

### Possible future code or architecture changes

If retaining the environment while idle becomes important, possible designs include:

- Replace the SQL Change Tracking trigger with an order-creation outbox or queue write in the order transaction, allowing the Functions app and SQL listener to scale down.
- Move the SQL-trigger function into a separate Function App and start that component only during demonstrations that require automatic order processing.
- Disable the hourly delivery and weekly archive timers when the demo is idle, while retaining manual administrative endpoints.
- Accept delayed or manually initiated order processing and remove the always-ready listener entirely.

These alternatives require code, reliability, or operational changes. Removing the always-ready setting alone is not sufficient: Flex Consumption can assign a `NoOpListener`, and new orders may be missed.

---

## Top‑Level Templates

### `main.bicep`

- **Role**: Root orchestration template for the entire environment.
- **What it does**:
  - Declares global parameters (location, environment name, revision suffix, model names, etc.).
  - Composes and wires all module Bicep files in `modules/`.
  - Is the primary entry point used by `azd` for `azd provision`.

### `main.json`

- **Role**: ARM JSON output generated from `main.bicep`.
- **What it does**: Allows deployment with tooling that expects ARM templates rather than Bicep. Not edited manually.

### `main.parameters.json`

- **Role**: Parameter file for `main.bicep` / `main.json`.
- **What it does**: Supplies values for parameters such as environment name, location, OpenAI model names, and other configuration injected by `azd`.

---

## Module Templates (`modules/`)

Each module focuses on a single Azure resource or closely related resource set. `main.bicep` composes these modules.

### `identity.bicep`

- **Purpose**: Creates the managed identities used by the application.
- **Typical resources**:
  - User‑assigned or system‑assigned managed identities.
  - Role assignments granting access to Azure SQL, storage, and other services.
- **Usage**: Other modules (database, container apps, storage) take identity IDs from this module to enable passwordless access.

### `database.bicep` / `database.json`

- **Purpose**: Provisions the Azure SQL resources.
- **Typical resources**:
  - Azure SQL Server and AdventureWorks database.
  - Configuration for Entra ID admin / managed identity access.
- **Notes**: Works together with post‑provision scripts (see docs) to load schema and sample data.

### `sql-private-network.bicep`

- **Purpose**: Provides private network routing and DNS for Azure SQL.
- **Typical resources**: A VNet with dedicated Container Apps, Functions integration, and private endpoint subnets; an Azure SQL private endpoint; and a linked private DNS zone.
- **Notes**: The `azd up` deployment hooks temporarily permit only the deployment caller's IPv4 address while doing SQL bootstrap work, then disable public SQL access in `postup.sh`.

### `acr.bicep`

- **Purpose**: Creates an **Azure Container Registry**.
- **Typical resources**:
  - ACR instance used for remote container builds of `api`, `api-mcp`, and the frontend Container Apps.
- **Notes**: `azure.yaml` is configured so azd uses this registry for remote builds.

### `aca.bicep`

- **Purpose**: Sets up the **Azure Container Apps environment** shared by backend services.
- **Typical resources**:
  - Container Apps environment (vNet‑integrated as appropriate).
  - Shared networking and logging configuration.
- **Notes**: Other Container Apps modules (including aca-api and aca-api-mcp) deploy apps into this environment. Azure Functions uses its own Flex Consumption plan and VNet integration.

### `aca-api.bicep`

- **Purpose**: Deploys the **Data API Builder (DAB)** container app.
- **Typical responsibilities**:
  - Define the Container App for the `api` image.
  - Configure environment variables (connection strings via managed identity, DAB config, CORS for prod).
  - Wire to the Container Apps environment and ACR image.

### `flex-api-functions.bicep`

- **Purpose**: Deploys the **Azure Functions Flex Consumption** app (`api-functions`).
- **Typical responsibilities**:
  - Define the Flex Consumption plan and .NET isolated Function App with VNet integration.
  - Configure deployment-package storage and managed identity authentication.
  - Pass environment values (SQL connection string using AAD, MCP service URL, storage settings, AI endpoints, etc.).
  - Attach managed identity for SQL, Storage, and OpenAI access.

### `aca-api-mcp.bicep`

- **Purpose**: Deploys the **MCP server** container (`api-mcp`).
- **Typical responsibilities**:
  - Define the Container App that exposes the Model Context Protocol server endpoint.
  - Configure networking so the Functions app can call it securely.

### `swa-app.bicep`

- **Purpose**: Provisions the **Azure Static Web App** running the `app/` React frontend.
- **Typical responsibilities**:
  - Define the Static Web App resource and its environment.
  - Configure authentication/authorization and API backend URLs (Functions + DAB).
  - Wire runtime config for the frontend (e.g., `config.js` endpoints).

### `aca-app-admin.bicep`

- **Purpose**: Deploys the **admin portal** (`app-admin/`) as an Azure Container App.
- **Typical responsibilities**:
  - Define the Container App for the admin React SPA image (ACR remote build).
  - Set `minReplicas: 0` (scale-to-zero) to avoid idle cost.
  - Inject runtime config (API Functions URL, admin redirect URI, etc.).
  - Runs independently of the customer-facing Static Web App.

### `storage.bicep`

- **Purpose**: Creates **storage accounts** used by Functions.
- **Typical responsibilities**:
  - Blob containers for receipts, images, logs, and translations.
  - Queue storage for background jobs (image generation, thumbnailing, receipts, email, etc.).
  - Appropriate access policies for managed identities.
  - Policy-compliant network settings: `networkAcls.defaultAction: 'Deny'`, `publicNetworkAccess: 'Disabled'`, and `allowBlobPublicAccess: false`.
  - Private endpoints and VNet-linked private DNS zones for blob, queue, table, and file services, using the VNet and private-endpoint subnet from `sql-private-network.bicep`.

Storage data-plane access requires network connectivity to that VNet and private DNS resolution, in addition to the existing authorization. The deployed Container Apps and Functions environments are VNet-integrated. Local Functions, storage utility scripts, and deployment agents that directly access storage must run from a VNet-connected environment (or use a VPN with private DNS forwarding). Public blob URLs, including SAS URLs, are not reachable from outside the private network; serve externally consumed content through an authorized application endpoint. Foundry storage connections also require a supported private network path before they can access data; configuring a connection or managed identity alone does not provide network access.

#### Storage Consumer Inventory

All containers, queues, tables, and file shares are provisioned in `modules/storage.bicep`. Application code accesses existing resources; it does not provision them.

| Resource | Consumer | Network and Authorization |
| --- | --- | --- |
| File share `seed-job-logs` | Seed job mounts `/logs`; `SeedJobStatusFunction` reads logs for the admin portal | Container Apps VNet to file private endpoint over SMB/445 with account key; Flex VNet to file endpoint over HTTPS/443 with Storage File Data Privileged Reader and backup intent |
| Containers `azure-webjobs-hosts`, `azure-webjobs-secrets` | Functions host coordination and secrets | Flex VNet to blob private endpoint; runtime identity has Storage Blob Data Owner |
| Container `function-releases` | Flex Consumption deployment packages | Flex VNet to blob private endpoint; deployment storage uses the configured user-assigned identity |
| Container `adventureworks-receipts` | `PdfReceiptGenerator`, receipt checks/downloads, missing-receipt scans, and email attachment downloads | Flex VNet to blob private endpoint; runtime blob role. Browsers download via `DownloadOrderReceipt`, not directly from storage |
| Container `locales` | `TranslateLanguageFile` saves generated translations | Flex VNet to blob private endpoint; runtime blob role. Storefront translations are bundled; local translation-download utilities require private network access |
| Queues `order-receipt-generation`, `order-email-generation` | Receipt generation and confirmation-email Functions | Flex VNet to queue private endpoint; Storage Queue Data Contributor |
| Queues `ai-job-image-queue`, `ai-job-chat-queue`, `ai-job-embeddings-queue`, `product-thumbnail-generation` | AI job processor and thumbnail Functions | Same queue endpoint and runtime role |
| Queues `sales-order-status`, `production-wo-queue`, `supply-chain-orders-queue`, `simulation-order-queue`, `warehouse-ops-queue` | Order pipeline, manufacturing, purchasing, shopping, and warehouse Functions | Same queue endpoint and runtime role; Flex supports VNet-protected triggers and scaling |
| Queues `review-moderation-queue`, `manufacturing-agent-queue`, `auto-promotion-queue` | Moderation, manufacturing agent, and promotion queue Functions | Same queue endpoint and runtime role |
| Each application queue's `-poison` queue | Functions queue-trigger failure handling; AI-job cleanup and manufacturing-agent status/cleanup | Same queue endpoint and runtime role; provisioned alongside each primary queue |
| Tables `shoppingSimulator`, `awOrderPipelineConfig`, `awSupplyChain`, `awManufacturing`, `awWarehouse` | Shopping, order pipeline, supply-chain, manufacturing/workforce, and warehouse services | Flex VNet to table private endpoint; Storage Table Data Contributor |
| Tables `awBankAccounts`, `awBankTransactions` | Bank simulator service | Same table endpoint and runtime role |
| Tables `awManufacturingAgentConfig`, `awManufacturingAgentRuns`, `awManufacturingProposals`, `awAutoPromotionConfig` | Agent configuration, runs, proposals, and automatic promotions | Same table endpoint and runtime role |
| Tables `verifiedReviewsJob`, `reviewModerationJob` | Review service job state | Same table endpoint and runtime role |
| Table `awMcpTasks` | MCP `AzureTableMcpTaskStore` | MCP Container App VNet to table private endpoint; shared managed identity and account name configured in `aca-api-mcp.bicep` |
| Task-hub tables `AdventureWorksFunctionsHistory`, `AdventureWorksFunctionsInstances`, `AdventureWorksFunctionsPartitions`; queues `adventureworksfunctions-workitems`, `adventureworksfunctions-control-00` through `-03`; containers `adventureworksfunctions-leases`, `adventureworksfunctions-applease`, `adventureworksfunctions-largemessages` | Durable Functions Azure Storage provider (partition table is available if table partition management is used) | Flex VNet to blob/queue/table private endpoints; runtime blob owner, queue contributor, and table contributor roles |
| Table `AzureFunctionsDiagnosticEvents` | Functions host storage diagnostics | Flex VNet to table private endpoint; runtime table contributor role |

Task-hub resource names and partition count are derived at Bicep build time from `api-functions/host.json` (default partition count: four). Keep any deployed host-setting overrides consistent with that file. Do not change the partition count of an existing task hub.

The Foundry storage connection is registered in `aiservices.bicep`, but no current application or agent code consumes it directly. It must not be treated as proof of Foundry-managed network access to this private account. Adding a Foundry-hosted feature that directly reads storage requires its own supported private networking configuration.

### `applicationinsights.bicep`

- **Purpose**: Sets up **Application Insights** and related monitoring.
- **Typical responsibilities**:
  - Application Insights resource.
  - Connection string and instrumentation key outputs consumed by Functions, Container Apps, and Static Web Apps.

### `aiservices.bicep` / `aiservices.json`

- **Purpose**: Provisions **Azure OpenAI / Azure AI Services** used for embeddings, chat, translations, and image generation.
- **Typical responsibilities**:
  - Azure OpenAI resource and deployments for chat + embeddings models.
  - Key endpoints and model names exported as outputs/parameters into the app layer.

### `communication.bicep` / `communication.json`

- **Purpose**: Provisions **Azure Communication Services (Email)**.
- **Typical responsibilities**:
  - Communication Services resource with email enabled.
  - Configuration outputs (connection string or endpoint) used by the Functions email service.

### `webpubsub.bicep`

- **Purpose**: Provisions **Azure Web PubSub (Free tier)** for real-time push notifications to all frontend apps.
- **Typical responsibilities**:
  - Web PubSub resource (`Microsoft.SignalRService/webPubSub`) with `Free_F1` SKU.
  - Grants the user-assigned managed identity the `Web PubSub Service Owner` role for passwordless auth.
  - Outputs `webPubSubHostName` consumed by Functions and frontend Container Apps.

---

## How These Templates Are Used

- **Azure Developer CLI (`azd`)**
  - `azd up` → runs the full lifecycle: `preup` → `provision` (deploy Bicep) → `deploy` (containers / SWA) → `postdeploy` (app wiring).
  - `azure.yaml` controls which services are mapped to which modules and how remote builds target ACR.

- **Post‑Provision Scripts**
  - PowerShell scripts (described in the repo docs) run after infrastructure deployment to:
    - Configure SQL roles and load AdventureWorks sample data.
    - Update redirect URIs and CORS.
    - Discover available OpenAI models and set environment values.

If you want to understand where a specific Azure resource comes from, start at `main.bicep` and follow its module references into `modules/*.bicep` for the detailed resource declarations.

## Related documentation

- High-level application overview: [README.md](../README.md)
- Azure deployment flow and hooks: [QUICKSTART.md](../QUICKSTART.md), [scripts/README.md](../scripts/README.md)
- Database seeding and data loading: [seed-job/README.md](../seed-job/README.md)
- SQL schema, roles, and seed data: [seed-job/sql/README.md](../seed-job/sql/README.md)
- AI agent automation and MCP wiring: [docs/AI_AGENT_AUTOMATION.md](../docs/AI_AGENT_AUTOMATION.md), [docs/AI_AGENT_DEPLOYMENT_SUMMARY.md](../docs/AI_AGENT_DEPLOYMENT_SUMMARY.md)
- Application Insights integration and flow: [docs/features/monitoring/](../docs/features/monitoring/)
