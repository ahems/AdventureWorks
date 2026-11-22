---
title: Data API builder service (GraphQL, REST and MCP)
summary: How the DAB container exposes 69 AdventureWorks tables and views as GraphQL, REST and MCP endpoints, how it authenticates callers with api-mcp tokens and roles, and how it is built, started and deployed.
audience: [developer, operator, architect, ai-agent]
components: [api, api-mcp, infra]
related:
  - docs/reference/dab-entities.md
  - docs/architecture/dab-naming-conventions.md
  - docs/architecture/identity-and-auth.md
  - docs/features/mcp-oauth/README.md
  - docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md
---

# Data API builder service: GraphQL, REST and MCP

The `api` service is [Microsoft Data API builder](https://learn.microsoft.com/azure/data-api-builder/) (DAB). It turns the AdventureWorks tables and views into GraphQL, REST and MCP endpoints with no custom code. The folder [`api/`](../../api/) holds only [`dab-config.json`](../../api/dab-config.json), a [`dockerfile`](../../api/dockerfile) and a startup wrapper, [`entrypoint.sh`](../../api/entrypoint.sh).

## What it serves

All three endpoints run in one Azure Container App (`av-api-*`) on port 80 behind HTTPS ingress.

| Endpoint | Path | Used by |
|---|---|---|
| GraphQL | `/graphql` (introspection on) | Storefront and admin portal |
| REST | `/api/{Entity}` and `/api/{Entity}/{key}/{value}` | Manufacturing portal, scripts |
| MCP | `/mcp` | The MCP Inspector (Foundry agents use the api-mcp tools instead) |

- The `API_URL` azd output is the GraphQL endpoint and already ends in `/graphql/`. Strip that suffix to get the REST and MCP base.
- DAB exposes **69 entities** (66 tables and 3 views; no stored procedures). Every entity uses DAB's default names: REST path `/api/<Entity>`, GraphQL list `<camelPlural>` and single-record `<camelSingular>_by_pk`. See [DAB entities](../reference/dab-entities.md) for every entity, role and relationship, and [DAB naming conventions](../architecture/dab-naming-conventions.md) for the naming rules.
- `Person.Address` is not exposed because its `SpatialLocation` column uses the SQL `geography` type, which DAB does not support. Use the Functions address routes instead.
- `HumanResources.Employee` is exposed through the `HumanResources.vEmployee` view because the table has `hierarchyid` columns.
- `host.mode` is `development`, so detailed errors, GraphQL tooling and Swagger are available. Response caching is off.

### Lists and pagination

GraphQL lists return `{ items, hasNextPage, endCursor }`; REST lists return `{ value, nextLink }`. A page holds **100 items by default**; that is not the total. Follow every page:

- GraphQL: `first` and `after`, using `hasNextPage` and `endCursor`.
- REST: `$first` and `$after`, or the returned `nextLink`. DAB does not support `$top` or `$skip`.

## Authentication and roles

```mermaid
sequenceDiagram
    participant C as "Client (SPA, script or agent)"
    participant M as "api-mcp (OAuth server)"
    participant D as "DAB container"
    participant S as "Azure SQL"
    C->>M: "Sign in with PKCE, request DAB resource"
    M-->>C: "JWT (aud = issuer/dab, roles, business_entity_id, customer_id)"
    C->>D: "Request + Authorization: Bearer + X-MS-API-ROLE"
    D->>D: "Validate issuer and audience; role must be in roles claim"
    D->>D: "Apply entity permissions, field rules and row policy"
    D->>S: "SQL as runtime managed identity"
    S-->>D: "Rows"
    D-->>C: "GraphQL or REST response"
```

- **Token validation.** DAB uses its `AzureAD` JWT provider as a generic bearer-token validator. The issuer (`DAB_JWT_ISSUER`) is the api-mcp public URL and the audience (`DAB_JWT_AUDIENCE`) is `<issuer>/dab`. These are api-mcp tokens, not Entra ID tokens.
- **Role selection.** The caller names a role in the `X-MS-API-ROLE` header, and that role must be in the token's `roles` claim. A token without the header runs as `authenticated`; no token runs as `anonymous`.
- **Roles.** Nine roles are used: `anonymous`, `authenticated`, `consumer`, `sales-admin`, `marketing-admin`, `inventory-admin`, `operations-admin`, `executive-admin` and `manufacturing-engineer`. `anonymous` can only read, and only the 33 public catalog entities.
- **Row ownership.** Database policies limit self-service data to the caller: `business_entity_id` for person, contact, cart and review rows, and `customer_id` for `SalesOrderHeader`.
- **Field rules.** Some fields are hidden from public and consumer roles, for example product cost and stocking fields, inventory shelf and bin, and reviewer email.
- **CORS.** Every origin is allowed, without credentials. Callers send bearer tokens, not cookies.

See [identity and authentication](../architecture/identity-and-auth.md) and the [OAuth server](../features/mcp-oauth/README.md) for how tokens and roles are issued.

## Calling DAB

Use [`scripts/utilities/azure-auth.py`](../../scripts/utilities/azure-auth.py). It signs in, requests a DAB-audience token and adds `X-MS-API-ROLE` for you:

```bash
# GraphQL
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource dab --path /graphql --method POST \
  --data '{"query":"{ products(first: 5) { items { ProductID Name } hasNextPage endCursor } }"}'

# REST
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource dab --path '/api/Product?$first=5'
```

Check the GraphQL `errors` array as well as the HTTP status. See [authenticated local scripts](../testing/AZURE_AUTHENTICATED_SCRIPTS.md).

## Data access and real-time changes

- DAB connects to SQL as the runtime user-assigned managed identity, using `DATABASE_CONNECTION_STRING` with `Authentication=Active Directory Default`. There are no SQL passwords.
- The seed job grants that identity `db_datareader`, `db_datawriter`, `EXECUTE` and object-level `VIEW DEFINITION`.
- DAB itself does not publish Web PubSub events. SQL triggers on selected tables write DAB changes to `dbo.RealtimeNotificationOutbox`, and the Functions `DatabaseChanges` listener publishes them. See [Web PubSub events](../reference/webpubsub-events.md).

## Container image and startup

- **Image.** The runtime image is `mcr.microsoft.com/azure-databases/data-api-builder` without a version tag, so each build uses the latest DAB release. The config file is copied to `/App`.
- **Startup wrapper.** [`entrypoint.sh`](../../api/entrypoint.sh) runs before DAB:
  1. Sets `DAB_MCP_ALLOWED_HOST` to the container app's host name, so the `/mcp` endpoint accepts requests for that host.
  2. Waits until the managed identity endpoint returns a token.
  3. Sleeps 30 seconds to give the database time to resume.
  4. Starts DAB with `dab-config.json`.
- **Probes.** A TCP startup probe on port 80 starts after 60 seconds and allows 12 failures 10 seconds apart. DAB's own `/health` endpoint reports the DAB process, not database readiness.

## Hosting

| Setting | Value |
|---|---|
| Resource | Container app `av-api-*` ([`aca-api.bicep`](../../infra/modules/aca-api.bicep)) |
| Size | 2 CPU, 4 Gi |
| Scale | 0–3 replicas; rules at 10 concurrent requests, 70% CPU and 75% memory |
| Build | Remote build in ACR (`azure.yaml`, `remoteBuild: true`) |
| Telemetry | Application Insights via `APPLICATIONINSIGHTS_CONNECTION_STRING` |

The container scales to zero, so the first request after an idle period waits for startup. The `api` service postdeploy hook, [`api-postdeploy.sh`](../../scripts/hooks/api-postdeploy.sh), sets an `APP_URL` environment variable to the storefront URL. `dab-config.json` does not read it; CORS is defined in the config file.

Runtime settings are listed in [environment variables](../reference/environment-variables.md#dab-api-api).

## Deploying and running locally

- **Deploy:** `azd deploy api --no-prompt` rebuilds the image and creates a new revision.
- **Run locally:** the VS Code task **start api (DAB)** runs `dab start` in `api/`. Provide `DATABASE_CONNECTION_STRING`, `DAB_JWT_ISSUER`, `DAB_JWT_AUDIENCE` and `DAB_MCP_ALLOWED_HOST` (for example `localhost`). Do not disable authentication. The deployed database is private, so local DAB needs a database you can reach; prefer testing against the deployed API.
