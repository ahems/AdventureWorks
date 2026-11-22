---
title: Environment variables and azd outputs reference
summary: Every azd environment value, Bicep input and output, hook-set value, per-service runtime setting and frontend runtime configuration key, with the file that sets it.
audience: [developer, operator, ai-agent]
components: [infra, scripts, api, api-functions, api-mcp, seed-job, app, app-admin, app-manufacturing, mcp-inspector]
related:
  - docs/operations/deployment.md
  - docs/reference/azure-resources.md
  - docs/reference/scripts.md
  - docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md
---

# Environment variables and azd outputs reference

This page lists the configuration values used across the solution: what azd stores, what Bicep receives and returns, what hooks add, and what each running service reads.

**How this page was derived.** Bicep inputs come from [`infra/main.parameters.json`](../../infra/main.parameters.json). azd outputs come from the `output` statements in [`infra/main.bicep`](../../infra/main.bicep). Hook-set values come from `azd env set` calls in [`scripts/hooks/`](../../scripts/hooks/) and [`scripts/utilities/agents/`](../../scripts/utilities/agents/). Service settings come from the `env` or `appSettings` blocks in [`infra/modules/`](../../infra/modules/), plus the settings that postdeploy hooks apply. Frontend keys come from [`app/scripts/generate-config.sh`](../../app/scripts/generate-config.sh) and the `docker-entrypoint.sh` files in `app-admin/` and `app-manufacturing/`.

## Reading values

azd stores values in the selected environment. It does not export them into your shell. Read only the values you need:

```bash
azd env get-value API_URL --no-prompt
azd env get-value API_FUNCTIONS_URL --no-prompt
```

To call protected APIs, use [`scripts/utilities/azure-auth.py`](../../scripts/utilities/azure-auth.py). It reads the endpoints it needs from the selected environment. Do not source or print the whole azd `.env` file.

## Inputs set before provisioning

The `preup` hook ([`preup.sh`](../../scripts/hooks/preup.sh)) writes these values. You can also set some of them yourself before `azd up`.

| azd value | Set by | Purpose |
|---|---|---|
| `AZURE_ENV_NAME`, `AZURE_LOCATION`, `AZURE_SUBSCRIPTION_ID` | azd / user | Environment name, region and subscription |
| `AZURE_RESOURCE_GROUP` | `preup.sh` | Resource group (`rg-<env>`) that preup creates |
| `OBJECT_ID` | `preup.sh` | Signed-in deployer's object ID; becomes the `aadAdminObjectId` Bicep parameter |
| `FOUNDRY_LOCATION` | user / `preup.sh` | Region for the Foundry account and model deployments |
| `AZURE_OPENAI_ACCOUNT_NAME` | `preup.sh` | Foundry (AIServices) account name |
| `SQL_DATABASE_NAME` | `preup.sh` | Database name |
| `SKIP_LOCAL_DEV_ROLE_ASSIGNMENTS` | user / `preup.sh` | Skips deployer data-plane role assignments (default `false`) |
| `DEPLOYER_PRINCIPAL_TYPE` | user / workflow | `User` (default) or `ServicePrincipal` |
| `chatGptModelName`, `chatGptDeploymentVersion`, `chatGptSkuName`, `availableChatGptDeploymentCapacity` | `preup.sh` | Selected chat model and capacity |
| `embeddingDeploymentModelName`, `embeddingDeploymentVersion`, `embeddingDeploymentSkuName`, `availableEmbeddingDeploymentCapacity` | `preup.sh` | Selected embedding model and capacity |
| `imageDeploymentModelName`, `imageDeploymentVersion`, `imageDeploymentSkuName`, `imageModelFormat`, `availableImageDeploymentCapacity` | `preup.sh` | Selected image model and capacity (optional) |
| `CHAT_MODEL_NAME_REGEX` | user / `preup.sh` | Optional filter for chat model selection, for example `^(gpt-4\.1|gpt-4o)$` |

### Bicep parameter mapping

[`infra/main.parameters.json`](../../infra/main.parameters.json) maps azd values to Bicep parameters:

| Bicep parameter | azd value | Default |
|---|---|---|
| `environmentName` | `AZURE_ENV_NAME` | — |
| `aadAdminObjectId` | `OBJECT_ID` | — |
| `sqlDatabaseName` | `SQL_DATABASE_NAME` | — |
| `foundryname` | `AZURE_OPENAI_ACCOUNT_NAME` | — |
| `foundryLocation` | `FOUNDRY_LOCATION` | — |
| `chatGptModelName`, `chatGptDeploymentVersion`, `chatGptSkuName`, `availableChatGptDeploymentCapacity` | same names | — |
| `embeddingModelName`, `embeddingDeploymentVersion`, `embeddingSkuName`, `availableEmbeddingDeploymentCapacity` | `embeddingDeploymentModelName`, `embeddingDeploymentVersion`, `embeddingDeploymentSkuName`, `availableEmbeddingDeploymentCapacity` | — |
| `imageModelName`, `imageDeploymentVersion`, `imageSkuName`, `imageModelFormat`, `availableImageDeploymentCapacity` | `imageDeploymentModelName`, `imageDeploymentVersion`, `imageDeploymentSkuName`, `imageModelFormat`, `availableImageDeploymentCapacity` | — |
| `skipLocalDevRoleAssignments` | `SKIP_LOCAL_DEV_ROLE_ASSIGNMENTS` | `false` |
| `deployerPrincipalType` | `DEPLOYER_PRINCIPAL_TYPE` | `User` |
| `restoreOpenAi`, `useFreeLimit` | fixed | `false` |

`location` is not mapped; Bicep uses the resource group's location, which `preup.sh` creates in `AZURE_LOCATION`.

## azd outputs from provisioning

azd saves every `output` of `infra/main.bicep` into the environment.

### Endpoints

| Output | Value |
|---|---|
| `APP_URL`, `APP_REDIRECT_URI` | Storefront Static Web App URL |
| `APP_ADMIN_URL` | Admin portal container app URL |
| `APP_MANUFACTURING_URL` | Manufacturing portal container app URL |
| `API_URL` | DAB GraphQL endpoint, including `/graphql/`. Strip it to get the REST base |
| `API_FUNCTIONS_URL` | Function App base URL |
| `API_MCP_URL`, `MCP_SERVICE_URL` | api-mcp MCP endpoint, including `/mcp`. Strip it to get the OAuth issuer |
| `MCP_INSPECTOR_URL`, `MCP_INSPECTOR_APP_URL` | MCP Inspector container app URL |
| `WEB_PUBSUB_HOST_NAME` | Web PubSub host name |

### Resources and identities

| Output | Value |
|---|---|
| `AZURE_CLIENT_ID`, `USER_MANAGED_IDENTITY_NAME` | Runtime user-assigned managed identity |
| `SEED_MANAGED_IDENTITY_NAME`, `SEED_MANAGED_IDENTITY_CLIENT_ID`, `SEED_MANAGED_IDENTITY_PRINCIPAL_ID` | Seed (SQL administrator) managed identity |
| `SQL_SERVER_NAME` | Azure SQL logical server |
| `STORAGE_ACCOUNT_NAME` | Storage account |
| `AZURE_CONTAINER_REGISTRY_ENDPOINT` | Container registry login server |
| `CONTAINER_APP_ENVIRONMENT_NAME` | Container Apps environment |
| `SERVICE_APP_NAME`, `SERVICE_APP_ADMIN_NAME`, `SERVICE_APP_MANUFACTURING_NAME`, `SERVICE_API_NAME`, `SERVICE_API_FUNCTIONS_NAME`, `SERVICE_API_MCP_NAME`, `SERVICE_SEED_JOB_NAME`, `SERVICE_MCP_INSPECTOR_NAME` | Resource names azd uses to deploy each service |
| `MCP_SIGNING_KEY_VAULT_NAME`, `MCP_SIGNING_KEY_VAULT_URI`, `MCP_SIGNING_CERTIFICATE_NAME` | Key Vault and certificate (`mcp-signing`) for api-mcp token signing |
| `AZURE_STATIC_WEB_APP_DEPLOYMENT_TOKEN` | Static Web App deployment token (secret) |
| `COMMUNICATION_SERVICE_NAME`, `COMMUNICATION_SERVICE_ENDPOINT`, `EMAIL_SENDER_DOMAIN` | Communication Services and email sender domain |
| `APPLICATIONINSIGHTS_CONNECTION_STRING`, `APPINSIGHTS_CONNECTIONSTRING`, `APPINSIGHTS_INSTRUMENTATIONKEY` | Application Insights |

### AI

| Output | Value |
|---|---|
| `PROJECT_NAME`, `PROJECT_RESOURCE_ID`, `AZURE_AI_PROJECT_ID` | Foundry project |
| `AI_FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_PROJECT_ENDPOINT` | Foundry project endpoint |
| `chatGptDeploymentName` | Chat model deployment name |

## Values set by hooks after provisioning

| azd value | Set by | Purpose |
|---|---|---|
| `VITE_API_URL`, `VITE_API_FUNCTIONS_URL` | `postprovision.sh` | Storefront build-time endpoints |
| `AI_AGENT_*_ID` (18 values) | agent scripts called by `create-foundry-agents.sh` | Foundry agent IDs: `CHAT`, `ADMIN_CHAT`, `ORDER`, `PROMOTION`, `CART_RECOVERY`, `REVIEW`, `CUSTOMER`, `PRODUCT_CONTENT`, `MANUFACTURING_CONTENT`, `TRANSLATION`, `REVIEW_BATCH`, `REVIEW_ANALYSIS`, `EMAIL_CONTENT`, `CATALOG_SUGGESTION`, `HELP_ME_CHOOSE`, `WORKFLOW_CHAT`, `WORKFLOW_PROMOTION`, `WORKFLOW_ORDER` |
| `AI_AGENT_*_MEMORY_STORE` | agent scripts | Foundry memory store names for agents that use memory |
| `FOUNDRY_AGENT_CONFIG_HASH` | `postprovision.sh`, `postdeploy.sh` | Fingerprint of the agent definitions; `postdeploy` recreates agents only when it changes |
| `AGENT_MANUFACTURING_AGENT_RESPONSES_ENDPOINT` | azd (`azure.ai.agent` service) | Responses endpoint of the hosted Manufacturing agent |
| `MANUFACTURING_AGENT_ENDPOINT` | `postdeploy.sh` | Copy of the hosted agent endpoint that Functions uses; kept from the earlier deployment when a service-scoped deploy doesn't republish it |

`postdeploy.sh` also sets these **api-mcp container settings** directly. They are not azd values:

| Container setting | Purpose |
|---|---|
| `OAUTH_ESHOP_REDIRECT_URIS`, `OAUTH_ADMIN_REDIRECT_URIS`, `OAUTH_MANUFACTURING_REDIRECT_URIS`, `OAUTH_INSPECTOR_REDIRECT_URIS` | `<app URL>/oauth/callback` for each first-party client |
| `MCP_TRUSTED_SERVICE_PRINCIPAL_IDS` | Service principals allowed to use the managed-identity grant (Functions and the hosted agent) |
| `MCP_FUNCTIONS_PRINCIPAL_ID`, `MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID` | Principal IDs that `ServicePrincipalPolicy` maps to the Functions and hosted-agent callers |

## Runtime settings by service

### DAB API (`api`)

Set in [`infra/modules/aca-api.bicep`](../../infra/modules/aca-api.bicep).

| Setting | Purpose |
|---|---|
| `DATABASE_CONNECTION_STRING` | SQL connection with `Authentication=Active Directory Default` and the runtime identity |
| `DAB_JWT_ISSUER`, `DAB_JWT_AUDIENCE` | api-mcp issuer and the DAB audience (`<issuer>/dab`) |
| `AZURE_CLIENT_ID`, `TENANT_ID` | Runtime managed identity |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Telemetry |
| `ASPNETCORE_URLS` | Listen address |
| `Logging__LogLevel__Default`, `Logging__LogLevel__Microsoft`, `Logging__LogLevel__Azure` | Log levels |
| `APP_URL` | Storefront URL, set by `api-postdeploy.sh`; DAB CORS comes from `dab-config.json` |

See [DAB API](../services/dab-api.md).

### Azure Functions (`api-functions`)

Set in [`infra/modules/flex-api-functions.bicep`](../../infra/modules/flex-api-functions.bicep) unless noted.

| Setting | Purpose |
|---|---|
| `SQL_CONNECTION_STRING` | SQL connection with `Authentication=Active Directory Default` |
| `AzureWebJobsStorage__accountName`, `__blobServiceUri`, `__queueServiceUri`, `__tableServiceUri`, `__credential`, `__clientId` | Identity-based host storage (queues, tables, Durable hub) |
| `FUNCTIONS_OAUTH_MODE` | `enforced` in Azure (code default `disabled`; `audit` logs without blocking) |
| `FUNCTIONS_JWT_ISSUER`, `FUNCTIONS_JWT_AUDIENCE` | api-mcp issuer and the Functions audience (`<issuer>/functions`) |
| `API_FUNCTIONS_URL` | Own base URL, used to build links and callbacks |
| `AZURE_CLIENT_ID` | Runtime managed identity; also the expected SQL principal in `Sql.SessionPrincipal` telemetry |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Telemetry |
| `AI_FOUNDRY_PROJECT_ENDPOINT`, `AZURE_OPENAI_ENDPOINT`, `chatGptDeploymentName`, `EMBEDDING_GENERATION_ENDPOINT` | Foundry project, model endpoint and deployments |
| `AI_AGENT_*_ID` | Agent IDs. Bicep sets 10 of them; `api-functions-postdeploy.sh` writes all 19 |
| `MCP_SERVICE_URL` | api-mcp `/mcp` endpoint (`api-functions-postdeploy.sh`) |
| `MANUFACTURING_AGENT_ENDPOINT` | Hosted Manufacturing agent endpoint (`api-functions-postdeploy.sh`) |
| `WEB_PUBSUB_HOST_NAME` | Web PubSub host for negotiation and publishing |
| `COMMUNICATION_SERVICE_ENDPOINT`, `EMAIL_SENDER_DOMAIN` | Email sending |
| `SIMULATION_TIME_SCALE_FACTOR`, `SIMULATION_SCRAP_RATE`, `MATERIALS_RETRY_DELAY_SECONDS` | Production simulation tuning |
| `ORDER_NOTIFICATIONS_EMAIL_ENABLED` | Not set by the template. Set it to `true` to send Shipped and Delivered emails; otherwise the email content is logged |

For local runs, start from [`api-functions/local.settings.example.json`](../../api-functions/local.settings.example.json) and never commit a populated copy. See [Azure Functions](../services/functions.md).

### OAuth and MCP server (`api-mcp`)

Set in [`infra/modules/aca-api-mcp.bicep`](../../infra/modules/aca-api-mcp.bicep) and updated by `postdeploy.sh`.

| Setting | Purpose |
|---|---|
| `ConnectionStrings__AdventureWorks` | SQL connection for credential checks and tools |
| `MCP_PUBLIC_BASE_URL` | Public base URL; the OAuth issuer |
| `MCP_SIGNING_KEY_VAULT_URI`, `MCP_SIGNING_CERTIFICATE_NAME`, `MCP_KEYVAULT_MANAGED_IDENTITY_CLIENT_ID` | Signing certificate in Key Vault and the identity that reads it |
| `MCP_ENTRA_TENANT_ID` | Tenant for validating managed-identity assertions |
| `MCP_TRUSTED_SERVICE_PRINCIPAL_IDS`, `MCP_FUNCTIONS_PRINCIPAL_ID`, `MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID` | Trusted service callers |
| `OAUTH_*_REDIRECT_URIS` | Redirect URIs for first-party clients |
| `API_FUNCTIONS_URL` | Functions base URL for proxied tool calls |
| `AZURE_OPENAI_ENDPOINT` | Model endpoint used by AI-backed tools |
| `AzureWebJobsStorage__accountName` | Storage account for the MCP task store (`awMcpTasks` table) |
| `AZURE_CLIENT_ID`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `ASPNETCORE_URLS` | Identity, telemetry and listen address |

See [OAuth and MCP server](../services/api-mcp.md).

### Seed job (`seed-job`)

Set in [`infra/modules/aca-seed-job.bicep`](../../infra/modules/aca-seed-job.bicep) and read by [`seed-job/seed-database.ps1`](../../seed-job/seed-database.ps1).

| Setting | Purpose |
|---|---|
| `SQL_SERVER_NAME`, `SQL_DATABASE_NAME` | Target database |
| `AZURE_CLIENT_ID` | Seed identity (SQL administrator); also the expected SQL principal in `Sql.SessionPrincipal` telemetry |
| `USER_MANAGED_IDENTITY_NAME`, `RUNTIME_MANAGED_IDENTITY_NAME`, `RUNTIME_MANAGED_IDENTITY_CLIENT_ID` | Runtime identity that the seed grants database access to |
| `AZURE_RESOURCE_GROUP`, `TENANT_ID` | Context |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Seed telemetry |
| `SEED_SKIP_EXISTING` | Set to `true` by `postprovision.sh` so tables that already have data are skipped |
| `MCP_DEMO_PASSWORD` | Optional override for the demo sign-in password |

See [Seed job](../services/seed-job.md).

### MCP Inspector (`mcp-inspector`)

Set in [`infra/modules/aca-mcp-inspector.bicep`](../../infra/modules/aca-mcp-inspector.bicep): `API_MCP_URL`, `API_DAB_MCP_URL`, `MCP_PROXY_FULL_ADDRESS`, `AZURE_CLIENT_ID` and `APPLICATIONINSIGHTS_CONNECTION_STRING`.

## Frontend runtime configuration

Each frontend reads endpoints at runtime from a generated `config.js`, so one build works in any environment.

| Key | Storefront (`app`) | Admin (`app-admin`) | Manufacturing (`app-manufacturing`) |
|---|---|---|---|
| `API_URL` | yes | yes | yes |
| `API_FUNCTIONS_URL` | yes | yes | yes |
| `API_MCP_URL` | yes | yes | yes |
| `APPINSIGHTS_CONNECTIONSTRING` | yes | yes | yes |
| `WEB_PUBSUB_HOST_NAME` | — | yes | yes |
| `APP_URL`, `APP_MANUFACTURING_URL`, `MCP_INSPECTOR_URL` | — | yes | — |
| `ODATA_BASE`, `MANUFACTURING_BASE` | — | — | yes (derived: DAB REST `/api` and Functions `/api`) |
| Generated by | [`app/scripts/generate-config.sh`](../../app/scripts/generate-config.sh) at build time | [`app-admin/docker-entrypoint.sh`](../../app-admin/docker-entrypoint.sh) at container start | [`app-manufacturing/docker-entrypoint.sh`](../../app-manufacturing/docker-entrypoint.sh) at container start |

The storefront build also uses `VITE_API_URL`, `VITE_API_FUNCTIONS_URL`, `VITE_API_MCP_URL` and `VITE_APPINSIGHTS_CONNECTIONSTRING`. `predeploy.sh` writes them to `app/.env.production`. For local runs, put overrides in `app/.env`; Vite does not read azd values. The Static Web App also has app settings (`API_URL`, `API_FUNCTIONS_URL`, `API_MCP_URL`, `APPINSIGHTS_CONNECTIONSTRING`, `WEB_PUBSUB_HOST_NAME`) from [`infra/modules/swa-app.bicep`](../../infra/modules/swa-app.bicep).

Admin and manufacturing receive their values as container environment variables from [`aca-app-admin.bicep`](../../infra/modules/aca-app-admin.bicep) and [`aca-app-manufacturing.bicep`](../../infra/modules/aca-app-manufacturing.bicep).
