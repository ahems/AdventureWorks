# Quickstart: Run AdventureWorks in GitHub Codespaces with `azd`

This guide walks you through cloning this repo into your own GitHub account, starting a devcontainer in **GitHub Codespaces**, and provisioning the full Azure environment with **Azure Developer CLI (`azd`)**. It also explains how `azure.yaml` and the azd lifecycle hooks work together.

---

## 1. Fork and Clone the Repository

1. **Fork on GitHub**
   - Go to the original AdventureWorks repository.
   - Click **Fork** to create a copy under your own GitHub account.

2. **(Optional) Clone locally**
   - If you want a local clone in addition to Codespaces, run:

     ```bash
     git clone https://github.com/<your-account>/AdventureWorks.git
     cd AdventureWorks
     ```

The remaining steps assume you are working in **your fork**.

---

## 2. Open in GitHub Codespaces (Dev Container)

This repository is configured with a devcontainer so you get all required tooling (Azure CLI, azd, .NET, Node, Docker‑in‑Docker) preinstalled.

1. From your fork on GitHub, click **Code → Codespaces → Create codespace on main**.
2. Wait for the container to build and VS Code (web or desktop) to connect.
3. Once the container is ready, you should see the repo under `/workspaces/AdventureWorks` and the Azure CLI (`az`) and Azure Developer CLI (`azd`) available in the integrated terminal.

> Tip: You can also open the devcontainer locally with VS Code Remote Containers using the same repo.

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

Once you have successfully signed in using azd, sign in via Powershell:

```pwsh
Connect-AzAccount -UseDeviceAuthentication -Tenant <your-tenant-id>
Connect-AzAccount Set-AzContext -Subscription <your-subscription-id>
```

Set the Azure regions you want to deploy services to:

```bash
azd env set AZURE_LOCATION "eastus2"
azd env set FOUNDRY_LOCATION "swedencentral"
azd env set PLAYWRIGHT_LOCATION "westeurope"
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
azd env set imageDeploymentModelName "gpt-image-1"
azd env set imageDeploymentSkuName "GlobalStandard"
azd env set imageDeploymentVersion "2025-04-15"
azd env set imageModelFormat "OpenAI"
```

## 4. Provision and Deploy with `azd up`

From the repo root inside the Codespace:

```bash
cd /workspaces/AdventureWorks
azd up
```

`azd up` will:

1. Execute the **preup** hook to create an AI Foundry and discover available model quotas for chat, embeddings, and image generation in your subscription (~2-3 minutes).
2. Run `azd provision` to deploy Bicep infrastructure templates under `infra/` (Container Apps, Azure SQL, Storage, OpenAI, etc.) — **~21 minutes**.
3. Execute **postprovision.sh** to configure Azure SQL managed identity permissions and deploy the seed-job Container App Job (~2-3 minutes). The seed-job runs asynchronously in the background to create database schema and import AdventureWorks seed data (**~8 minutes**).
4. Run `azd deploy` to build container images via ACR remote build and deploy services to Container Apps and Static Web Apps.
5. Execute the **postdeploy** hook to configure runtime CORS settings and environment variables on the API Container App.
6. Execute the **postup** hook to generate a local `.env` file in the repo root for easier debugging.

**Total deployment time: ~29 minutes** (infrastructure provisioning + seed-job execution)

At the end, `azd` will print out key endpoints such as the Static Web App URL, API URLs, and Function endpoints.

> **Tip:** After deployment completes, visit `https://<your-static-web-app-url>/health` to verify all services are running and the database is fully loaded. The health check will show the status of the API, Functions, and database connectivity.

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
    - `api-functions`: .NET Azure Functions (`containerapp`, `csharp`, Docker remote build).
    - `app`: React frontend (`staticwebapp`, `js`), custom `buildCommand` and `dist` output.

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
- `postdeploy` → `scripts/hooks/api-postdeploy.sh` (for api service)
- `postdeploy` → `scripts/hooks/app-postdeploy.sh` (for app service)

#### Execution Order Around `azd up`

1. `preup` (before anything else)
2. `azd provision` (deploy infra)
3. `postprovision`
4. `azd deploy` (build + deploy app services)
5. `predeploy` and `postdeploy` (around deployment, especially frontend)
6. `postup` (final message display after `azd up` completes)

---

### 5.2.1 `scripts/preup.ps1`

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

---

### 5.2.2 `scripts/postup.ps1`

**Hook:** `postup`

**When it runs:** After `azd up` completes successfully.

**Purpose:** Generate or update a project‑root `.env` file for easier local debugging.

What it does:

- Provides functions to:
  - Safely retrieve values from `azd env` (`Get-AzdValue`).
  - Parse and update `.env` files while preserving comments and unrelated entries.
- Resolves a small set of variables from the `azd` environment:
  - `IS_LOCALHOST` – always set to `true` as a local‑execution marker.
  - `APPLICATIONINSIGHTS_CONNECTION_STRING` – if available.
  - `AZURE_CLIENT_ID` – from `AZURE_CLIENT_ID` or `CLIENT_ID`.
  - `API_URL` – from `API_URL` or `GRAPHQL_API_URL`.
- Writes or updates `.env` in the repo root with these keys, quoting values where needed.

This makes it easy to run local tools, tests, or scripts that rely on simple `.env` semantics.

---

### 5.2.3 `scripts/postprovision.sh`

**Hook:** `postprovision`

**When it runs:** After `azd provision` (infrastructure deployment) but **before** app services are built and deployed.

**Duration:** The hook itself completes quickly (~2-3 minutes), but it launches an asynchronous seed-job that runs for **~8 minutes** in the background.

**Purpose:** Finalize infrastructure configuration, especially around Azure SQL, managed identity, and database seeding.

Key responsibilities:

- Sets environment variables for frontend build (VITE_API_URL, VITE_API_FUNCTIONS_URL).
- Configures Aspire Dashboard access by assigning Contributor role to the current user on the Container Apps Environment.
- Ensures the user‑assigned managed identity has the correct database permissions:
  - Connects to Azure SQL using the current user's Azure CLI credentials.
  - Executes `seed-job/sql/assign-database-roles.sql` to grant db_datareader, db_datawriter, and db_ddladmin roles to the managed identity.
- Deploys the **seed-job** Container App Job:
  - Builds the seed-job container image using Azure Container Registry (`az acr build`).
  - Updates the Container App Job with the new image.
  - Starts the seed-job asynchronously to populate the database with schema and data from `seed-job/sql/`.

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

### 5.2.4 `scripts/predeploy.sh`

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

### 5.2.5 `scripts/postdeploy.ps1`

**Hook:** `postdeploy`

**When it runs:** After `azd deploy` has deployed services (Container Apps, Static Web App, etc.).

**Purpose:** Final runtime configuration, primarily CORS and environment variables for the API Container App.

What it does:

- Reads `APP_REDIRECT_URI` from `azd env` and derives the base frontend URL (removing `/getAToken` if present).
- Retrieves `SERVICE_API_NAME` and `AZURE_RESOURCE_GROUP` from `azd env`.
- Uses `az containerapp update` to set an `APP_URL` environment variable on the **API Container App**, which the API code uses for:
  - CORS configuration.
  - Runtime awareness of the frontend origin.
- Prints out the configured API and Functions URLs.

Together with `predeploy.sh`, this script ensures the **frontend and backend agree on URLs and CORS settings**.

---

### 5.2.6 `scripts/postdown.ps1`

**Hook:** `postdown`

**When it runs:** After `azd down` tears down the Azure resources.

**Purpose:** Clean up local artifacts created for development.

What it does:

- Locates the repo root based on the script path.
- Deletes the root `.env` file generated by `postup.ps1`, if present.
- Deletes `api/.env`, if present.

This keeps the local workspace clean and avoids stale configuration values after environments are destroyed.

---

## 6. Next Steps

After `azd up` completes successfully:

- Browse to the Static Web App URL printed by `azd` to explore the AdventureWorks storefront.
- Use the Functions and API endpoints (see [api-functions/README.md](api-functions/README.md) and [infra/README.md](infra/README.md)) to understand how the backend is wired.
- Dive into the docs under `docs/` (AI agent, telemetry, SEO, translations, etc.) for deeper architectural guidance.

From here, you can iterate on the frontend (`app/`), Functions (`api-functions/`), MCP server (`api-mcp/`), or infrastructure (`infra/`) and redeploy using `azd deploy` as needed.
