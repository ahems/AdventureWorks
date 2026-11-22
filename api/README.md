---
title: DAB API service (api/) — Data API builder GraphQL, REST and MCP
summary: Component README for the Data API builder container that exposes the AdventureWorks database as GraphQL, REST and MCP endpoints secured by api-mcp OAuth tokens; files, configuration, local run and deployment.
audience: [developer, operator, ai-agent]
components: [api]
related: [docs/services/dab-api.md, docs/reference/dab-entities.md, docs/architecture/dab-naming-conventions.md, docs/architecture/identity-and-auth.md]
---

# DAB API service (`api/`)

The `api` service is [Microsoft Data API builder](https://learn.microsoft.com/azure/data-api-builder/)
(DAB). With no custom code, it turns 69 AdventureWorks entities (66 tables and 3 views)
into **GraphQL** (`/graphql`), **REST** (`/api`) and native **MCP** (`/mcp`) endpoints.
Callers send resource-bound user JWTs issued by api-mcp plus an `X-MS-API-ROLE`
header; DAB enforces entity, field and row-ownership permissions and reaches Azure SQL
as the runtime managed identity. For the full service guide, see
**[docs/services/dab-api.md](../docs/services/dab-api.md)**.

**Tech and hosting:** Data API builder container image
(`mcr.microsoft.com/azure-databases/data-api-builder`), remote-built in ACR and hosted
on **Azure Container Apps** with scale-to-zero (azd service `api`).

## Files

| File | Purpose |
|---|---|
| `dab-config.json` | Data source, REST/GraphQL/MCP runtime, JWT issuer/audience, CORS, telemetry and all entity permissions |
| `dockerfile` | Build stage installs the DAB tool; runtime stage copies the config and `entrypoint.sh` |
| `entrypoint.sh` | Startup wrapper: derives `DAB_MCP_ALLOWED_HOST`, waits for a managed identity token, then starts DAB |

Entity names follow DAB's default naming rules; see
[DAB naming conventions](../docs/architecture/dab-naming-conventions.md) and the
[DAB entity reference](../docs/reference/dab-entities.md). `Person.Address` is not
exposed (its `geography` column is unsupported); use the Functions address routes.

## Configuration

DAB reads `@env()` placeholders from the Container App environment:

| Variable | Purpose |
|---|---|
| `DATABASE_CONNECTION_STRING` | Azure SQL connection string with `Authentication=Active Directory Default` |
| `DAB_JWT_ISSUER`, `DAB_JWT_AUDIENCE` | api-mcp issuer and the `<issuer>/dab` audience |
| `DAB_MCP_ALLOWED_HOST` | Trusted host for `/mcp`; derived by `entrypoint.sh` in Azure (use `localhost` for a direct local `dab start`) |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Telemetry |

Runtime database access (read, write, `EXECUTE` and object-level `VIEW DEFINITION`) is
granted to the managed identity by the seed job. See the
[environment variables reference](../docs/reference/environment-variables.md#dab-api-api).

## Call, run and deploy

```bash
# Authenticated GraphQL call against the deployed API
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource dab --path /graphql --method POST \
  --data '{"query":"{ products(first: 5) { items { ProductID Name } hasNextPage endCursor } }"}'

# Deploy a new revision
azd deploy api --no-prompt
```

List pages hold 100 items by default; follow GraphQL `first`/`after` cursors or REST
`$first`/`$after` and `nextLink`. To run locally, use the VS Code task
**start api (DAB)** with the variables above; never disable authentication. The
deployed database is private, so prefer testing against the deployed API.

## Related docs

- [DAB API service guide](../docs/services/dab-api.md)
- [DAB entity reference](../docs/reference/dab-entities.md)
- [Identity and authentication](../docs/architecture/identity-and-auth.md)
- [OAuth server](../docs/features/mcp-oauth/README.md)
- [End-to-end authentication assurance](../docs/features/authentication/END_TO_END_AUTHENTICATION.md)
- [Seed data generation (vector columns)](../docs/operations/seed-data-generation.md#vector-columns)
- [Authenticated local scripts](../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md)
