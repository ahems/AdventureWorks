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

1. From your fork on GitHub, click **Code → Codespaces → Create codespace on main** (or `dev`).
2. Wait for the container to build and VS Code (web or desktop) to connect.
3. Once the container is ready, you should see the repo under `/workspaces/AdventureWorks` and the Azure CLI (`az`) and Azure Developer CLI (`azd`) available in the integrated terminal.

> Tip: You can also open the devcontainer locally with VS Code Remote Containers using the same repo.

---

## 3. Log in to Azure

Inside the Codespace terminal:

```bash
azd auth login
```

azd env set "TENANT_ID" ed9aa516-5358-4016-a8b2-b6ccb99142d0 // 3Cloud Lab
azd env set "AZURE_SUBSCRIPTION_ID" 6c8e23df-4aec-4ed5-bec5-79853ea6c6c6 // Data Lab

Then ensure `azd` is pointed at the correct subscription:

```bash
azd config set defaults.subscription <your-subscription-id>
```

Also sign in using a Powershell Terminal:

```pwsh
Connect-AzAccount -UseDeviceAuthentication -Tenant <your-tenant-id>
Connect-AzAccount Set-AzContext -Subscription <your-subscription-id>
```

Set the Azure region you want to deploy to:

```bash
azd env set 'AZURE_LOCATION'='eastus2'
```

Optionally, if you want to deploy your AI Foundry in a different region, do so like this:

```bash
azd env set 'FOUNDRY_LOCATION'='swedencentral'
```

---

## 4. Provision and Deploy with `azd up`

From the repo root inside the Codespace:

```bash
cd /workspaces/AdventureWorks
azd up
```

`azd up` will:

1. Execute the **preup** hook to prepare Azure AD registrations and discover OpenAI models.
2. Run `azd provision` to deploy Bicep templates under `infra/`.
3. Execute **postprovision** scripts to configure SQL roles and import data.
4. Run `azd deploy` to build and push containers to ACR and deploy Container Apps / Static Web Apps.
5. Execute the **postdeploy** hook to finish configuration (CORS, frontend config, etc.).
6. Execute the **postup** hook to generate local `.env` helpers for debugging.

At the end, `azd` will print out key endpoints such as the Static Web App URL, API URLs, and Function endpoints.

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

- `preup` → `scripts/preup.ps1`
- `postup` → `scripts/postup.ps1`
- `postprovision` → `scripts/postprovision.ps1`
- `predeploy` → `scripts/predeploy.sh`
- `postdeploy` → `scripts/postdeploy.ps1`
- `postdown` → `scripts/postdown.ps1`

#### Execution Order Around `azd up`

1. `preup` (before anything else)
2. `azd provision` (deploy infra)
3. `postprovision`
4. `azd deploy` (build + deploy app services)
5. `predeploy` and `postdeploy` (around deployment, especially frontend)
6. `postup` (final local config after `azd up` completes)

When you later tear down resources with `azd down`, `postdown` runs for cleanup.

---

### 5.2.1 `scripts/preup.ps1`

**Hook:** `preup`

**When it runs:** Before `azd up` begins provisioning or deployment.

**Purpose:** Prepare the Azure tenant and `azd` environment values for this application.

Key responsibilities:

- Ensures the PowerShell Gallery is trusted and required modules are present (`Az.*`, etc.).
- Provides helper functions to read and write `azd` environment values (`Get-AzdValue`, `Set-AzdValue`).
- Ensures you are logged into Azure (`Ensure-AzLogin`) with the correct tenant and subscription.
- Creates or reuses **Entra ID (AAD) app registrations**:
  - `Ensure-AppRegistration` – creates a web app registration, service principal, and secret; persists `CLIENT_ID` and `CLIENT_SECRET` into the `azd` environment.
  - `Ensure-ApiAppRegistration` – creates an API application registration with app roles and identifier URIs.
- Sets or updates `azd` environment values needed for later stages (API auth, model discovery, etc.).

This script is responsible for the **identity scaffolding** that the rest of the app and scripts depend on.

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

### 5.2.3 `scripts/postprovision.ps1`

**Hook:** `postprovision`

**When it runs:** After `azd provision` (infrastructure deployment) but **before** app services are built and deployed.

**Purpose:** Finalize infrastructure configuration, especially around Azure SQL and managed identity.

Key responsibilities:

- Ensures required PowerShell modules are installed and imported:
  - `Microsoft.Graph`
  - `Az.Resources`, `Az.ManagedServiceIdentity`, `Az.Sql`
- Retrieves environment values from `azd env`:
  - `TENANT_ID`, `AZURE_RESOURCE_GROUP`, `SQL_DATABASE_NAME`, `USER_MANAGED_IDENTITY_NAME`, `SQL_SERVER_NAME`.
- If certain values are missing, discovers them from the deployed resource group and writes them back to `azd env`.
- Connects to Azure with the correct tenant context if not already authenticated.
- Uses Azure SQL management cmdlets and ADO.NET to:
  - Ensure the user‑assigned managed identity has the correct permissions on the SQL Server and database.
  - Load or update the AdventureWorks schema and seed data using embedded SQL and/or JSON import helpers (functions like `Import-JsonTable`).

In short, `postprovision` wires up the **database and identity layer** so the app can talk to SQL using managed identity and the right roles.

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
