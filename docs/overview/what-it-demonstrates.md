---
title: What the AdventureWorks demo demonstrates
summary: The Azure architecture and engineering patterns the AdventureWorks demo shows — passwordless managed identity, private networking, Data API builder, a self-contained OAuth server, per-tool MCP authorization, Foundry agents, push-based real-time updates, infrastructure-as-code and least-privilege deployment — and the simplifications it accepts as a demo.
audience: [demo-presenter, developer, security-reviewer]
components: [app, app-admin, app-manufacturing, api, api-functions, api-mcp, mcp-inspector, manufacturing-agent, seed-job, infra]
related: [../../README.md, feature-catalog.md, demo-walkthrough.md, ../architecture/system-overview.md, ../architecture/identity-and-auth.md]
---

# What the AdventureWorks demo demonstrates

AdventureWorks shows how to build a realistic, AI-enabled line-of-business system on Azure from a
decades-old relational database, without rewriting the data model. This page summarises the patterns
it demonstrates — useful when presenting the demo or deciding which parts to reuse — and the
simplifications it deliberately accepts because it is a demo.

## Azure patterns shown

| Pattern | How the demo uses it | Read more |
| --- | --- | --- |
| **Passwordless access with managed identity** | Every service reaches Azure SQL, Storage, Key Vault, Web PubSub, Communication Services and Foundry with a user-assigned managed identity. SQL connection strings use `Authentication=Active Directory Default`; no keys or passwords are stored. Storage accounts disable shared-key access. | [Identity and authentication](../architecture/identity-and-auth.md) |
| **Private networking** | Azure SQL, Storage and Key Vault are reachable only through private endpoints in a virtual network. Container Apps run in a VNet-integrated environment and Functions use VNet integration. Public SQL access is disabled at the end of every deployment. | [Networking](../architecture/networking.md) |
| **Instant APIs with Data API builder** | DAB turns 69 AdventureWorks tables and views into GraphQL, REST and MCP endpoints with JWT-based, role-specific permissions and row-level policies — no hand-written CRUD code. | [Data API builder](../services/dab-api.md) |
| **Serverless business logic** | 245 .NET 10 isolated-worker functions on Flex Consumption: HTTP APIs, queue workers, timers, SQL change triggers and Durable orchestrations, with two always-ready instances for the SQL listeners. | [Azure Functions](../services/functions.md) |
| **Self-contained OAuth server with resource-bound tokens** | api-mcp (OpenIddict) signs in AdventureWorks database users and issues tokens bound to one audience — MCP, DAB or Functions — with scopes derived from the user's role. Signing keys live in Key Vault. | [MCP OAuth](../features/mcp-oauth/README.md) |
| **MCP server with per-tool authorization** | 63 MCP tools, each checked for scope, ownership, read/write access mode, the calling workload and (for autonomous actions) the agent's current mode. Destructive tools ask for confirmation. | [api-mcp](../services/api-mcp.md), [Tool scope matrix](../features/mcp-oauth/TOOL_SCOPE_MATRIX.md) |
| **Workload identity for agents** | Functions and the hosted agent exchange their managed-identity tokens for narrowly scoped MCP tokens, each limited to an allow-list of tools. | [Identity and authentication](../architecture/identity-and-auth.md) |
| **Microsoft Foundry agents** | 21 Foundry agents (prompt, workflow and intent) for chat, content, translation, reviews, promotions and order generation, plus a hosted Manufacturing agent that observes, proposes or acts with human approval. A Responsible AI policy guards the customer chat. | [AI architecture](../architecture/ai-architecture.md) |
| **Real-time push without polling** | Mutations publish events through Azure Web PubSub; database triggers feed a transactional outbox so even direct DAB writes notify the apps. All three frontends invalidate cached queries on events instead of polling. | [Real-time eventing](../architecture/realtime-eventing.md) |
| **Infrastructure as code only** | Every queue, table and blob container is declared in Bicep; application code never creates storage resources at runtime and only checks they exist at startup. | [Storage resources](../reference/storage-resources.md) |
| **Asynchronous database seeding** | A Container Apps job loads the database, ~1,800 product images, vector embeddings and translations in the background over the private network, so `azd up` does not wait for it. | [Seed job](../services/seed-job.md) |
| **Least-privilege deployment** | The deployer needs Contributor plus a role-assignment permission conditioned to an allow-list of roles, rather than Owner. | [Deployer permissions](../AZD_DEPLOYER_PERMISSIONS.md) |
| **One-command deployment** | `azd up` provisions Bicep, runs bash lifecycle hooks, remote-builds containers, publishes Functions and deploys the Static Web App and hosted agent. | [Deployment](../operations/deployment.md) |
| **Observability** | Application Insights and Log Analytics collect telemetry from the frontends, DAB, Functions, api-mcp and agents with distributed tracing; readiness endpoints report dependency health. | [Monitoring](../operations/monitoring.md) |

## Accepted demo limitations

These are deliberate simplifications that keep the demo self-contained and affordable. A production
system built on the same patterns would handle them differently.

- **Disposable environments.** There is no production environment; changes are deployed from source
  and environments are recreated rather than migrated or repaired.
- **Simulated business processes.** Order approval, shipping, delivery, manufacturing operations,
  vendor lead times, warehouse work and banking are simulations with configurable timings and random
  outcomes.
- **Client-calculated checkout totals.** The storefront calculates prices, discounts, tax and freight
  in the browser and the order API records them; there is no server-side pricing engine or payment
  processor.
- **Demo identities.** Users are AdventureWorks database people with demo passwords; there is no
  external identity provider, multi-factor authentication or email verification.
- **Anonymous AI features.** Semantic search and the "Help me choose" wizard are open to anonymous
  shoppers, so each use invokes AI models.
- **Email off by default.** Shipped and delivered notifications are logged instead of sent unless
  explicitly enabled; reserved test domains are never emailed.
- **Free and serverless tiers.** Web PubSub Free (20 connections, 20,000 messages per day), serverless
  SQL and scale-to-zero Container Apps keep cost low but limit sustained load.
- **No edge protection.** The ideal [reference architecture](../AdventureWorks-Reference-Architecture.svg)
  adds a web application firewall and egress firewall that the demo does not deploy.
- **Ongoing idle cost.** Two always-ready Functions instances keep the SQL listeners — and therefore
  the serverless database — running; delete the environment when finished.
