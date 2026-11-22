---
title: Infrastructure as code (infra/) — Bicep modules for the AdventureWorks Azure environment
summary: Component README for the Bicep templates that azd provisions, covering the module list, private networking, deployer role-assignment limits with the RBAC condition, and SQL idle-cost behavior, with links to the full Azure resource and networking references.
audience: [developer, operator, security-reviewer, ai-agent]
components: [infra]
related: [docs/reference/azure-resources.md, docs/architecture/networking.md, docs/operations/deployment.md, docs/AZD_DEPLOYER_PERMISSIONS.md, docs/reference/storage-resources.md]
---

# Infrastructure as code (`infra/`)

This folder contains the **Azure Bicep** templates that the Azure Developer CLI (azd)
provisions for the AdventureWorks demo: Azure Container Apps (DAB API, api-mcp, admin
and manufacturing portals, MCP Inspector and the seed job), Azure Functions Flex
Consumption, Azure Static Web Apps, Azure SQL (serverless), Storage, Key Vault,
Microsoft Foundry and Azure OpenAI, Azure Communication Services, Web PubSub,
Application Insights, managed identities and the private network. For every resource,
see **[docs/reference/azure-resources.md](../docs/reference/azure-resources.md)**; for the
network design, see **[docs/architecture/networking.md](../docs/architecture/networking.md)**.
The visual overview is the [architecture diagram](../docs/AdventureWorks-Reference-Architecture.svg).

## Files

| Path | Purpose |
|---|---|
| `main.bicep` | Root template; composes all modules and exports azd outputs |
| `main.parameters.json` | Maps azd environment values to Bicep parameters |
| `azd-role-assignment-allowlist.json` | Built-in role IDs that Bicep and hooks may assign |
| `azd-deployer-role.json` | Custom deployer role (role-assignment write/delete only) |
| `testing/auth-assurance-job.bicep` | Test-only resources for the authentication assurance suite |

## Modules (`modules/`)

| Module | Provisions |
|---|---|
| `identity.bicep` | Runtime and seed user-assigned managed identities |
| `keyvault.bicep` | Key Vault (RBAC) for the api-mcp token-signing certificate |
| `storage.bicep` | Storage account: blob containers, application queues (+ poison), tables, the `seed-job-logs` file share and private endpoints |
| `communication.bicep` | Azure Communication Services and Email |
| `webpubsub.bicep` | Azure Web PubSub (Free tier) with local auth disabled |
| `aiservices.bicep` | Foundry account and project, model deployments and connections |
| `eshop-chat-guardrails.bicep` | Content-filter (RAI) policy and blocklist for the storefront chat (called from `aiservices.bicep`) |
| `database.bicep` | Azure SQL server and serverless database; seed identity as Entra administrator |
| `sql-private-network.bicep` | VNet, subnets, SQL private endpoint and private DNS |
| `acr.bicep` | Azure Container Registry for remote builds |
| `applicationinsights.bicep` | Application Insights and Log Analytics |
| `aca.bicep` | Container Apps environment and the seed-log storage mount |
| `aca-api.bicep`, `aca-api-mcp.bicep` | DAB API and OAuth/MCP server Container Apps |
| `aca-app-admin.bicep`, `aca-app-manufacturing.bicep`, `aca-mcp-inspector.bicep` | Internal frontends and the MCP Inspector Container Apps |
| `aca-seed-job.bicep` | Seed Container Apps job |
| `flex-api-functions.bicep` | Functions Flex Consumption app, VNet integration and two always-ready instances |
| `swa-app.bicep` | Static Web App for the storefront |
| `swa-app-admin.bicep` | Not referenced by `main.bicep` (the admin portal runs on Container Apps) |

Storage queues, tables and containers are declared only here; application code never
creates them. See [storage resources](../docs/reference/storage-resources.md).

## Private networking

SQL and Storage are private: public network access is disabled and services reach them
through VNet integration, private endpoints and private DNS zones. Key Vault uses a
private endpoint with a deny-by-default network ACL. The seed
job initializes SQL through the private endpoint and grants the runtime identity its
database access; `postprovision.sh` never opens private-only SQL to the deployment host
(its firewall and role-assignment path applies only to legacy public-enabled servers).
Local tools outside the VNet cannot reach SQL or Storage directly; use the deployed APIs.
The seed job's `/logs` file share is mounted with the environment's managed identity
(SMB OAuth, no account key). Details: [networking](../docs/architecture/networking.md).

## Azure role assignments and deployer limits

The templates create no custom role definitions. Runtime identities receive built-in roles,
each scoped to the Communication, Web PubSub or Foundry resource it uses. Every built-in
role ID that Bicep or the hooks assign is listed in
[azd-role-assignment-allowlist.json](./azd-role-assignment-allowlist.json).

The deployer needs Contributor plus the subscription-specific
[deployer role](./azd-deployer-role.json), which adds only
`Microsoft.Authorization/roleAssignments/write` and `.../delete`. That role is assigned
with an Azure RBAC condition (version `2.0`) that limits both actions to the allow-listed
role IDs:

```text
((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR
 (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {<allowlisted GUIDs>}))
AND
((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR
 (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {<allowlisted GUIDs>}))
```

Use the same comma-separated GUID set from the JSON file in both clauses, and update the
allowlist whenever Bicep or a hook adds a role assignment. For the full rationale and the
grant commands, see [Deployer permissions](../docs/AZD_DEPLOYER_PERMISSIONS.md).

## Serverless SQL and idle cost

`database.bicep` provisions a General Purpose serverless database with auto-pause after
60 minutes. The two Flex always-ready listeners (`OrderPlacedSqlTrigger` and
`DatabaseChanges`) keep observing SQL Change Tracking while the environment exists, so
the database may not auto-pause even when the Container Apps are scaled to zero. For an
intermittently used demo, the environment owner can delete it when finished and
recreate it for the next session (see [deployment](../docs/operations/deployment.md)).
See [data stores](../docs/architecture/data-stores.md).

## How these templates are used

`azd provision` (part of `azd up`) deploys `main.bicep`. The bash hooks in
`scripts/hooks/` run around it; see [deployment](../docs/operations/deployment.md) for
the full lifecycle. Agents must not run `azd provision`, `azd up` or `azd down`;
infrastructure changes reach Azure when the user recreates the demo environment.

## Related docs

- [Azure resources reference](../docs/reference/azure-resources.md)
- [Networking](../docs/architecture/networking.md)
- [Deployment](../docs/operations/deployment.md) and [CI/CD](../docs/operations/ci-cd.md)
- [Deployer permissions](../docs/AZD_DEPLOYER_PERMISSIONS.md)
- [Environment variables](../docs/reference/environment-variables.md)
- [Seed job](../seed-job/README.md)
