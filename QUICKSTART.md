# Quickstart: Deploy the AdventureWorks Azure Demo

This guide covers deploying, exploring, and tearing down the Azure-hosted demo with **Azure Developer CLI (`azd`)**. It does not require running the application or its tests locally. A GitHub Codespace can be used as the deployment terminal.

> **What you're deploying:** See the [architecture diagram](docs/AdventureWorks-Reference-Architecture.svg) for a visual map of all Azure components provisioned by `azd up`.

---

## 1. Fork the Repository

Fork this repository on GitHub so you can create a Codespace and deploy resources into your own Azure subscription.

---

## 2. Open a deployment terminal

The repository's GitHub Codespace includes the deployment tools (Azure CLI, azd, .NET, Node.js, and PowerShell). It is used here only to run the Azure deployment; there is no need to start the app locally.

1. From your fork on GitHub, click **Code → Codespaces → Create codespace on main**.
2. Wait for the container to build and VS Code (web or desktop) to connect.
3. Once the container is ready, you should see the repo under `/workspaces/AdventureWorks` and the Azure CLI (`az`) and Azure Developer CLI (`azd`) available in the integrated terminal.

> If you use another deployment terminal, install Azure CLI (`az`), azd, PowerShell 7+ (`pwsh`), .NET 10, Node.js/npm, and Git LFS. The post-provision hook uses these tools to configure Azure SQL and build the frontend and seed-job.

---

## 3. Create an Environment and Log in to Azure

Inside the Codespace terminal:

```bash
azd env new <your-environment-name>
```

The value you use to name your environment will be prepended with 'rg-' and this will be the name of the resource group used to deploy to.

(Optional) If you need to set the Tenant ID or SUBSCRIPTION ID when logging in to Azure, you can do so first like so:

```bash
azd env set TENANT_ID "<your-tenant-id>"
azd env set AZURE_SUBSCRIPTION_ID "<your-subscription-id>"
```

Also ensure `azd` is pointed at the correct subscription:

```bash
azd config set defaults.subscription <your-subscription-id>
```

Login to Azure:

```bash
az login --tenant <your-tenant-id>
```

Note: If you encounter problems signing in to Azure due to multi-factor authentication enabled on your account, you may need to launch the codespace in Visual Studio Code on your desktop instead of in a browser.

Set the Azure regions you want to deploy services to:

```bash
azd env set AZURE_LOCATION "eastus2"
azd env set FOUNDRY_LOCATION "swedencentral"
```

Optional: Set the OpenAI model parameters to use for chat, embeddings and image generation (example values shown):

```bash
azd env set availableChatGptDeploymentCapacity 4500
azd env set availableEmbeddingDeploymentCapacity 754
azd env set availableImageDeploymentCapacity 1
azd env set chatGptDeploymentVersion "2025-04-14"
azd env set chatGptModelName "gpt-4.1-mini"
azd env set chatGptSkuName "Standard"
azd env set embeddingDeploymentModelName "text-embedding-3-small"
azd env set embeddingDeploymentSkuName "GlobalStandard"
azd env set embeddingDeploymentVersion 1
azd env set imageDeploymentModelName "gpt-image-2"
azd env set imageDeploymentSkuName "GlobalStandard"
azd env set imageDeploymentVersion "2026-04-21"
azd env set imageModelFormat "OpenAI"
```

## 4. Provision and Deploy with `azd up`

From the repo root inside the Codespace:

```bash
cd /workspaces/AdventureWorks
azd up --no-prompt
```

> **Important:** Always use `--no-prompt` to avoid interactive prompts that can stall the deployment. The `azd` preflight validation may warn about AI model catalog entries and prompt for confirmation — `--no-prompt` auto-accepts non-destructive warnings and ensures the deployment runs end-to-end without hanging.

`azd up` will:

1. Execute the **preup** hook to create an AI Foundry and discover available model quotas for chat, embeddings, and image generation in your subscription.
2. Run `azd provision` to deploy Bicep infrastructure templates under `infra/` (Container Apps, Azure SQL, Storage, OpenAI, etc.) — **~21 minutes**.
3. Execute **postprovision.sh** to temporarily allow the deployment host's IPv4 address through the SQL firewall, configure managed-identity permissions, and deploy the seed-job Container App Job. The seed job runs asynchronously and may take several minutes to create the database schema and import AdventureWorks data.
4. Run `azd deploy` to build Container Apps images via ACR remote build, publish the .NET Functions project to Flex Consumption, and deploy the frontend to Static Web Apps.
5. Execute the **postdeploy** hook to configure runtime CORS settings and environment variables on the API Container App.
6. Execute the **postup** hook to disable public SQL network access and print the demo URLs.

The deployment host's address is discovered automatically for temporary SQL setup access. After deployment, public SQL access is disabled; the application reaches SQL through Private Link.

Deployment time varies with Azure region, model quota, and resource provisioning. The seed job runs asynchronously and may continue after provisioning finishes.

At the end, the deployment prints browser-ready URLs for the storefront, admin portal, manufacturing dashboard, service health page, and API explorers.

Open the **service and seed-data status** URL first. Wait until the seed job reports completed before exploring the demo data. The Admin and Manufacturing Container Apps may take a moment to wake from scale-to-zero.

### Important: what happens when the demo is idle

The SQL Database is configured as General Purpose serverless with a 60-minute auto-pause delay. This does not mean the database will pause whenever the frontends and Container Apps are idle. `api-functions` keeps one Flex Consumption instance always ready for `OrderPlacedSqlTrigger`, which polls SQL Change Tracking on `Sales.SalesOrderHeader` so new orders can be processed reliably. That listener maintains SQL activity and prevents the zero-session condition required for auto-pause. The hourly delivery timer and weekly transaction-history archive are additional, intermittent SQL callers.

Azure resources are not automatically shut down when the demo is idle. When the demo is finished, delete the deployment to stop ongoing costs:

```bash
azd down --no-prompt
```

This deletes the deployed Azure resources. To run the demo again later, use `azd up --no-prompt`.

---

## 5. Files Used by `azd`

### 5.1 `azure.yaml`

`azure.yaml` is the **central configuration file** for Azure Developer CLI.

Key sections:

- **`name`**
  - Logical application name: `adventureworks`.

- **`hooks`**
  - Defines lifecycle scripts that run at specific `azd` phases (see below).

- **`services`**
  - Lists application services that `azd` will deploy:
    - `api-mcp`: MCP server (host: `containerapp`, language: `docker`, remote ACR build).
    - `api`: Data API Builder (`containerapp`, `docker`, remote build).
    - `api-functions`: .NET isolated Azure Functions (`function`, `csharp`, direct project publish to Flex Consumption).
    - `app`: React frontend (`staticwebapp`, `js`), custom `buildCommand` and `dist` output.
    - `app-admin`: Admin portal (`containerapp`, `docker`, remote ACR build).
    - `mcp-inspector`: MCP Inspector UI (`containerapp`, `docker`, remote ACR build).

- **`infra`**
  - Points at the Bicep templates in `infra/` for infrastructure provisioning.

`azd` reads this file to know **what to deploy**, **how to build it**, and **which hooks to run**.

---

## 5.2 azd Lifecycle Hooks and Scripts

The hooks configured in `azure.yaml` live under `scripts/` and are invoked automatically by `azd`.

### Hook Overview

Defined hooks:

- `preup` → `scripts/hooks/preup.sh`
- `postprovision` → `scripts/hooks/postprovision.sh`
- `predeploy` → `scripts/hooks/predeploy.sh`
- `postup` → `scripts/hooks/postup.sh`
- root `postdeploy` → `scripts/hooks/postdeploy.sh`
- service `postdeploy` hooks → API, Functions, and Static Web App configuration scripts

#### Execution Order Around `azd up`

1. `preup` (before anything else)
2. `azd provision` (deploy infra)
3. `postprovision`
4. `azd deploy` (build + deploy app services)
5. `predeploy` and `postdeploy` (around deployment, especially frontend)
6. `postup` (final message display after `azd up` completes)

---

### 5.2.1 `scripts/hooks/preup.sh`

**Hook:** `preup`

**When it runs:** Before `azd up` begins provisioning or deployment.

**Purpose:** Create an AI Foundry and discover available AI model quotas for the application.

Key responsibilities:

- Provides helper functions to read and write `azd` environment values (`Get-AzdValue`, `Set-AzdValue`).
- Ensures you are logged into Azure with the correct tenant and subscription.
- Creates an **AI Foundry** in your subscription.
- Discovers and validates available model quotas for:
  - Chat models (e.g., GPT-4, GPT-5x, etc.)
  - Embedding models (e.g., text-embedding-ada-002, gpt-x, etc.)
  - Image generation models (e.g., gpt-image-x)
- Sets or updates `azd` environment values with discovered model names and availability for later stages.

This script is responsible for the **AI infrastructure preparation** that the rest of the app depends on.

Chat selection defaults to the `balanced` policy, ranking model family and version
ahead of available capacity. Optional `azd` settings are `CHAT_MODEL_NAME_REGEX`,
`CHAT_MODEL_COST_TIER` (`economy`, `balanced`, or `premium`), and
`CHAT_MODEL_MIN_CAPACITY` (default `1`). A valid policy with no matching candidates
uses the general-chat fallback; policy evaluation errors abort with jq diagnostics
instead of being reported as a no-match. Complete existing model selections are
preserved and skip discovery on subsequent runs.

---

### 5.2.2 `scripts/hooks/postup.sh`

**Hook:** `postup`

**When it runs:** After `azd up` completes successfully.

**Purpose:** Finish the deployment and show the URLs for using the Azure-hosted demo.

The hook disables public access to Azure SQL, prints the storefront and service-health URLs, and includes links to the API explorers and optional MCP Inspector. Use the service-health page to confirm the seed job has completed before exploring database-backed features.

---

### 5.2.3 `scripts/hooks/postprovision.sh`

**Hook:** `postprovision`

**When it runs:** After `azd provision` (infrastructure deployment) but **before** app services are built and deployed.

**Duration:** Varies by Azure environment. It launches an asynchronous seed job that may take several minutes to finish.

**Purpose:** Finalize infrastructure configuration, especially around Azure SQL, managed identity, and database seeding.

Key responsibilities:

- Prepares frontend build endpoints and the MCP OAuth signing certificate.
- Configures Aspire Dashboard access by assigning Contributor role to the current user on the Container Apps Environment.
- Ensures the user‑assigned managed identity has the correct database permissions:
  - Connects to Azure SQL using the current user's Azure CLI credentials.
  - Executes `seed-job/sql/assign-database-roles.sql` to grant db_datareader, db_datawriter, and db_ddladmin roles to the managed identity.
- Enables SQL Change Tracking for order processing and assigns project-scoped Azure AI permissions.
- Creates or updates the Azure AI agents used by the demo.
- Deploys the **seed-job** Container App Job:
  - Builds the seed-job container image using Azure Container Registry (`az acr build`).
  - Updates the Container App Job with the new image.
  - Starts the seed-job asynchronously to populate the database with schema and data from `seed-job/sql/`.
- Refreshes the azd environment with the deployment outputs.

The seed-job runs as a containerized Azure Container App Job that:

- Executes `seed-database.ps1` inside the container.
- Loads SQL scripts (`AdventureWorks.sql`, `AdventureWorks-AI.sql`) and CSV files (both original and AI-enhanced).
- Populates product images from the `seed-job/images/` directory.
- **Takes approximately 8 minutes** to complete database seeding.

In short, `postprovision` wires up the **database and identity layer**, then triggers an asynchronous job to populate the database so the app can talk to SQL using managed identity with a fully seeded dataset.

**Note:** You can monitor seed-job execution with:

```bash
az containerapp job execution list --name <seed-job-name> --resource-group <resource-group>
```

For complete details on the seed-job architecture, components, and data loading process, see [seed-job/README.md](../seed-job/README.md).

---

### 5.2.4 `scripts/hooks/predeploy.sh`

**Hook:** `predeploy`

**When it runs:** Before `azd deploy` builds and deploys app services (especially the Static Web App).

**Purpose:** Prepare the frontend build with the correct runtime API endpoints.

What it does:

- Reads `API_URL`, `API_FUNCTIONS_URL`, and `APPINSIGHTS_CONNECTIONSTRING` from `azd env`.
- Exports them as `VITE_API_URL`, `VITE_API_FUNCTIONS_URL`, and `VITE_APPINSIGHTS_CONNECTIONSTRING` so they’re available during `npm run build`.
- Writes `app/.env.production` with these Vite variables to drive the production build.
- Cleans `app/dist` to ensure a fresh build.
- Generates `app/staticwebapp.config.json` from `staticwebapp.config.template.json` by substituting `{{API_FUNCTIONS_URL}}` with the actual Functions endpoint.

This ensures the deployed Static Web App is built **against the correct backend URLs and telemetry settings**.

---

### 5.2.5 `scripts/hooks/postdeploy.sh`

**Hook:** `postdeploy`

**When it runs:** After `azd deploy` has deployed services (Container Apps, Static Web App, etc.).

**Purpose:** Final runtime configuration for OAuth redirects, CORS, and the Azure Functions app settings.

What it does:

- Configures the API Container App's CORS origin.
- Sets OAuth callback URLs on the MCP service after all frontend URLs are available.
- Injects Foundry agent configuration into the Azure Functions app.

Together, the hooks prepare Azure resources, deploy the app, and print the links needed to use it. No local app startup or local tests are part of this demo workflow.

---

## 6. Next Steps

After `azd up` completes, open the storefront URL printed by the deployment. Visit its `/health` page and wait for the seed job to report completed before exploring database-backed features. The Admin and Manufacturing apps may take a moment to wake from scale-to-zero.

When the demo is finished, run `azd down --no-prompt` from the project directory to delete the Azure resources and stop ongoing costs. Run `azd up --no-prompt` later to deploy the demo again.
