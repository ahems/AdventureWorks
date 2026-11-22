---
title: Azure resources reference
summary: Every Azure resource that azd provisions for the demo, with its Bicep module, SKU and sizing, purpose and identity configuration.
audience: [developer, operator, architect, ai-agent]
components: [infra]
related:
  - docs/architecture/system-overview.md
  - docs/architecture/networking.md
  - docs/architecture/identity-and-auth.md
  - docs/reference/environment-variables.md
  - docs/reference/storage-resources.md
  - docs/AZD_DEPLOYER_PERMISSIONS.md
---

# Azure resources reference

This page lists the Azure resources in one deployed demo environment. Everything is created by `azd up` from [`infra/main.bicep`](../../infra/main.bicep), except the Foundry account, which `preup.sh` creates first, and the hosted Manufacturing agent, which azd deploys as a service.

**How this page was derived.** Resources, SKUs and sizes come from the `module` declarations in [`infra/main.bicep`](../../infra/main.bicep) (including the parameter values it passes, which override module defaults) and the resource definitions in [`infra/modules/`](../../infra/modules/). The hosted agent comes from [`azure.yaml`](../../azure.yaml) and [`manufacturing-agent/`](../../manufacturing-agent/). Resource names use the prefix shown plus a token that is unique to the environment.

The environment is a disposable demo. To change a resource, edit the Bicep and ask the environment owner to recreate the environment; do not change resources in place. See [deployment](../operations/deployment.md).

## Identity and security

| Resource | Module | SKU / tier | Purpose | Identity and access |
|---|---|---|---|---|
| User-assigned managed identity `av-identity-*` | [`identity.bicep`](../../infra/modules/identity.bicep) | — | Shared runtime identity for DAB, Functions, api-mcp, the frontends and the inspector | Granted data roles on SQL, storage, Web PubSub, Communication Services, Key Vault and Foundry |
| User-assigned managed identity `av-seed-identity-*` | `main.bicep` | — | SQL Entra administrator and seed-job identity | `AcrPull` |
| Key Vault `av-kv-*` | [`keyvault.bicep`](../../infra/modules/keyvault.bicep) | Standard | Holds the api-mcp token-signing certificate `mcp-signing` | RBAC authorization; runtime identity has Key Vault Secrets User; private endpoint; network ACL default Deny |

## Networking

| Resource | Module | Purpose |
|---|---|---|
| Virtual network `av-vnet-*` with three subnets | [`sql-private-network.bicep`](../../infra/modules/sql-private-network.bicep) | Subnets for the Container Apps environment, the Function App and private endpoints |
| SQL private endpoint and private DNS zone | `sql-private-network.bicep` | Private access to Azure SQL |
| Storage and Key Vault private endpoints | `storage.bicep`, `keyvault.bicep` | Private access to storage (blob, queue, table, file) and Key Vault |

See [networking](../architecture/networking.md).

## Data

| Resource | Module | SKU / tier | Purpose | Identity and access |
|---|---|---|---|---|
| Azure SQL server `av-sql-*` and database | [`database.bicep`](../../infra/modules/database.bicep) | General Purpose serverless `GP_S_Gen5_4`, 0.5 minimum vCores, auto-pause after 60 minutes, 32 GB | AdventureWorks database | Entra-only authentication; administrator is the seed identity; public network access disabled after deployment; private endpoint |
| Storage account | [`storage.bicep`](../../infra/modules/storage.bicep) | Standard_LRS, StorageV2, Cool access tier | Functions host and Durable Task hub, application queues, tables and blobs, seed-log file share | Shared key access off; public network access off; private endpoints; runtime identity has data roles |

See [storage resources](storage-resources.md) for every queue, table and container, and [data stores](../architecture/data-stores.md).

## Compute

| Resource | Module | Size and scale | Purpose | Identity and access |
|---|---|---|---|---|
| Container Apps environment `av-env-*` | [`aca.bicep`](../../infra/modules/aca.bicep) | Consumption, VNet-injected, external ingress | Hosts the container apps and the seed job; includes the managed Aspire Dashboard component | Runtime identity |
| Container app `av-api-*` (DAB) | [`aca-api.bicep`](../../infra/modules/aca-api.bicep) | 2 CPU, 4 Gi, 0–3 replicas | GraphQL and REST API | Runtime identity to SQL; validates api-mcp JWTs |
| Container app `av-mcp-*` (api-mcp) | [`aca-api-mcp.bicep`](../../infra/modules/aca-api-mcp.bicep) | 1 CPU, 2 Gi, 0–1 replicas | OAuth authorization server and MCP tools | Runtime identity; signing certificate from Key Vault |
| Container app `av-app-admin-*` | [`aca-app-admin.bicep`](../../infra/modules/aca-app-admin.bicep) | 0.25 CPU, 0.5 Gi, 0–3 replicas | Admin portal | Runtime identity |
| Container app `av-app-manufactur-*` | [`aca-app-manufacturing.bicep`](../../infra/modules/aca-app-manufacturing.bicep) | 0.25 CPU, 0.5 Gi, 0–3 replicas | Manufacturing portal | Runtime identity |
| Container app `av-mcp-inspector-*` | [`aca-mcp-inspector.bicep`](../../infra/modules/aca-mcp-inspector.bicep) | 0.25 CPU, 0.5 Gi, 0–1 replicas | MCP Inspector | Runtime identity |
| Container Apps job `av-seed-job-*` | [`aca-seed-job.bicep`](../../infra/modules/aca-seed-job.bicep) | 2 CPU, 4 Gi, manual trigger, 2,000-second timeout, no retries | Creates and loads the database | Seed identity |
| Function App and plan `av-func-*` | [`flex-api-functions.bicep`](../../infra/modules/flex-api-functions.bicep) | Flex Consumption FC1, up to 5 instances, 2,048 MB, .NET 10 isolated, two always-ready instances (one each for the two SQL trigger functions) | Business logic, queues, timers, Durable orchestrations | Runtime identity; VNet integration; OAuth enforced |
| Static Web App `av-app-*` | [`swa-app.bicep`](../../infra/modules/swa-app.bicep) | Standard; the main location when Static Web Apps supports it (`westus2`, `centralus`, `eastus2`, `westeurope`, `eastasia`), otherwise East US 2 (`staticWebAppLocation`) | Storefront | Deployment token |
| Container registry `avacr*` | [`acr.bicep`](../../infra/modules/acr.bicep) | Basic | Images built remotely by azd | Admin user off; both identities have `AcrPull` |

Container apps scale to zero, so the first request after an idle period is slow.

## Messaging and communication

| Resource | Module | SKU / tier | Purpose | Identity and access |
|---|---|---|---|---|
| Web PubSub `av-wps-*` | [`webpubsub.bicep`](../../infra/modules/webpubsub.bicep) | Free_F1 (20 concurrent connections, 20,000 messages per day) | Real-time push to the three frontends | Local auth off; runtime identity has Web PubSub Service Owner |
| Communication Services, Email Communication Service and Azure-managed domain `av-comms-*` | [`communication.bicep`](../../infra/modules/communication.bicep) | Global resource, United States data location | Transactional email | Local auth off; runtime identity has Communication and Email Service Owner |

## AI

| Resource | Module | SKU / tier | Purpose | Identity and access |
|---|---|---|---|---|
| Foundry account (AIServices) | [`aiservices.bicep`](../../infra/modules/aiservices.bicep); created first by `preup.sh` | S0 in `FOUNDRY_LOCATION` | Models and agents | Local auth off; system and user-assigned identities |
| Foundry project `av-aiproject-*` | `aiservices.bicep` | — | Prompt agents, the api-mcp connection and the hosted agent | Runtime identity has Azure AI Developer and data roles |
| Model deployments `chat`, `embedding` and an optional image deployment (`gpt-image-2`) | `aiservices.bicep` | Model, SKU and capacity selected by `preup.sh` | Chat, embeddings and image generation | Entra authentication |
| Responsible AI policy and blocklist | [`eshop-chat-guardrails.bicep`](../../infra/modules/eshop-chat-guardrails.bicep) | — | Guardrails for storefront chat | — |
| Hosted agent `manufacturing-agent` | `azure.yaml` (`host: azure.ai.agent`) | 0.5 CPU, 1 Gi | Manufacturing Responses agent | Agent identity trusted by api-mcp |

See [AI architecture](../architecture/ai-architecture.md) and [Foundry agents](../features/ai/foundry-agents.md).

## Monitoring

| Resource | Module | SKU / tier | Purpose |
|---|---|---|---|
| Log Analytics workspace | [`applicationinsights.bicep`](../../infra/modules/applicationinsights.bicep) | PerGB2018, 30-day retention, 1 GB daily cap | Logs for Container Apps and Application Insights |
| Application Insights | `applicationinsights.bicep` | Workspace-based | Telemetry from every service |

See [monitoring](../operations/monitoring.md).

## Test-only resources

[`infra/testing/auth-assurance-job.bicep`](../../infra/testing/auth-assurance-job.bicep) defines a job that `tests/scripts/run-auth-assurance-job.py` deploys for authorization tests. It is not part of `azd up`.
