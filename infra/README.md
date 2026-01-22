# AdventureWorks Infrastructure (`infra`)

This folder contains the Infrastructure‑as‑Code for the AdventureWorks e‑commerce solution, written in **Azure Bicep** and orchestrated by **Azure Developer CLI (azd)**.

At a high level, these templates provision:

- An Azure Container Apps environment hosting:
  - Data API Builder (`api`) container
  - Azure Functions (`api-functions`) container
  - MCP server (`api-mcp`) container
- An Azure Static Web App for the React frontend (`app`)
- Azure SQL Database with the AdventureWorks schema
- Azure OpenAI / Azure AI resources
- Storage accounts for blobs and queues
- Azure Communication Services for email
- Application Insights and related monitoring
- Managed identities for passwordless authentication

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

### `acr.bicep`

- **Purpose**: Creates an **Azure Container Registry**.
- **Typical resources**:
  - ACR instance used for remote container builds of `api`, `api-functions`, and `api-mcp`.
- **Notes**: `azure.yaml` is configured so azd uses this registry for remote builds.

### `aca.bicep`

- **Purpose**: Sets up the **Azure Container Apps environment** shared by backend services.
- **Typical resources**:
  - Container Apps environment (vNet‑integrated as appropriate).
  - Shared networking and logging configuration.
- **Notes**: Other modules (aca-api, aca-api-functions, aca-api-mcp) deploy apps into this environment.

### `aca-api.bicep`

- **Purpose**: Deploys the **Data API Builder (DAB)** container app.
- **Typical responsibilities**:
  - Define the Container App for the `api` image.
  - Configure environment variables (connection strings via managed identity, DAB config, CORS for prod).
  - Wire to the Container Apps environment and ACR image.

### `aca-api-functions.bicep`

- **Purpose**: Deploys the **Azure Functions** container app (`api-functions`).
- **Typical responsibilities**:
  - Define the Container App running the .NET isolated Functions.
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

### `storage.bicep`

- **Purpose**: Creates **storage accounts** used by Functions.
- **Typical responsibilities**:
  - Blob containers for receipts, images, logs, and translations.
  - Queue storage for background jobs (image generation, thumbnailing, receipts, email, etc.).
  - Appropriate access policies for managed identities.

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
- SQL schema, roles, and seed data: [scripts/sql/README.md](../scripts/sql/README.md)
- AI agent automation and MCP wiring: [docs/AI_AGENT_AUTOMATION.md](../docs/AI_AGENT_AUTOMATION.md), [docs/AI_AGENT_DEPLOYMENT_SUMMARY.md](../docs/AI_AGENT_DEPLOYMENT_SUMMARY.md)
- Application Insights integration and flow: [docs/APP_INSIGHTS_INTEGRATION.md](../docs/APP_INSIGHTS_INTEGRATION.md), [docs/APP_INSIGHTS_CONNECTION_STRING_FLOW.md](../docs/APP_INSIGHTS_CONNECTION_STRING_FLOW.md)
