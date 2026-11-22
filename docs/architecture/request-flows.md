---
title: AdventureWorks request flows (end-to-end sequence diagrams)
summary: Step-by-step sequence diagrams for the main AdventureWorks request paths — anonymous browsing, customer sign-in, checkout and the order pipeline, admin data calls with a DAB role, MCP tool calls proxied to Functions, and a hosted manufacturing agent run.
audience: [developer, security-reviewer, demo-presenter, ai-agent]
components: [app, app-admin, app-manufacturing, api, api-functions, api-mcp, manufacturing-agent]
related: [system-overview.md, identity-and-auth.md, realtime-eventing.md, ai-architecture.md, ../reference/functions-routes.md, ../features/manufacturing/manufacturing-agent.md]
---

# AdventureWorks request flows (end-to-end sequence diagrams)

These diagrams show what happens, hop by hop, for the most important requests in the
demo. Read the [system overview](system-overview.md) first for the component map, and
[identity and authentication](identity-and-auth.md) for how tokens are issued.

## 1. Anonymous storefront browsing

A visitor who has not signed in can browse the catalog. The storefront calls DAB with
no token, so DAB applies the `anonymous` role: read-only access to 33 catalog entities,
with internal fields such as `StandardCost` excluded.

```mermaid
sequenceDiagram
  autonumber
  actor V as Visitor
  participant SWA as Storefront (Static Web App)
  participant DAB as DAB API
  participant SQL as Azure SQL
  participant FN as Functions API

  V->>SWA: Open home or category page
  SWA-->>V: SPA + config.js (API URLs)
  V->>DAB: POST /graphql products(filter, first)
  Note over DAB: No token → role "anonymous" (read-only)
  DAB->>SQL: SELECT (managed identity)
  SQL-->>DAB: Rows
  DAB-->>V: { items, hasNextPage, endCursor }
  V->>FN: POST /api/search/semantic (public route)
  FN->>SQL: VECTOR_DISTANCE queries
  FN-->>V: Ranked products
```

Public Functions routes (Tier P) include semantic search, Help Me Choose, catalog
helpers, signup, password-reset pre-auth and health. Everything else needs a token.

## 2. Customer sign-in (e-shop credentials grant)

The storefront keeps its own email/password sign-in form. Behind the scenes it trades the
credentials for api-mcp tokens; there is no redirect to an OAuth login page.

```mermaid
sequenceDiagram
  autonumber
  actor C as Customer
  participant SPA as Storefront
  participant AS as api-mcp /token
  participant SQL as Azure SQL

  C->>SPA: Email + password
  SPA->>AS: POST /token grant=eshop-credentials<br/>client=adventureworks-eshop, resource=…/dab
  AS->>SQL: Verify password hash, resolve Person + Customer
  Note over AS: Consumer category only.<br/>Scopes = requested ∩ consumer role
  AS-->>SPA: DAB access token (10 min) + refresh token
  SPA->>AS: POST /token grant=refresh_token, resource=…/functions
  AS-->>SPA: Functions access token
  SPA->>AS: POST /token grant=refresh_token, resource=…/mcp
  AS-->>SPA: MCP access token
  Note over SPA: Tokens kept in sessionStorage (per tab),<br/>refreshed 60 s before expiry
```

Consumer DAB and Functions tokens carry `customer_id` and `business_entity_id` claims,
which DAB policies and Functions ownership checks use to limit the customer to their own
records.

## 3. Checkout and the order pipeline

Placing an order writes `Sales.SalesOrderHeader` and `Sales.SalesOrderDetail` rows
through Functions. A SQL trigger then fans the new order out to queues that simulate the
rest of the business.

```mermaid
sequenceDiagram
  autonumber
  participant SPA as Storefront
  participant FN as Functions HTTP
  participant SQL as Azure SQL
  participant TRG as OrderPlacedSqlTrigger
  participant Q as Storage queues
  participant WPS as Web PubSub
  participant ST as ProcessSalesOrderStatus
  participant TMR as OrderDelivery_Timer

  SPA->>FN: POST /api/orders (Functions token, orders.write)
  Note over FN: Customer IDs taken from signed claims
  FN->>SQL: INSERT SalesOrderHeader (Status 1 Pending)
  SPA->>FN: POST /api/orders/{id}/details
  FN->>SQL: INSERT SalesOrderDetail
  SQL-->>TRG: Change Tracking: new header row
  TRG->>WPS: orders: database-changed
  TRG->>Q: order-receipt-generation
  TRG->>Q: sales-order-status {Status 1} (delayed)
  opt Manufacturing agent mode is not Off
    TRG->>Q: manufacturing-agent-queue (new run)
    TRG->>WPS: orders: order-placed, manufacturing-agent: run-created
  end
  TRG->>Q: auto-promotion-queue (when counter hits threshold)
  Q-->>ST: Status message
  ST->>SQL: 1 → 2 Approved (or 4 Rejected)
  ST->>SQL: 2 → 5 Shipped (or 3 Backordered, then 5)
  ST->>WPS: orders: order-status-changed
  TMR->>SQL: Hourly: 5 Shipped → 7 Delivered after delivery window
  TMR->>WPS: orders: orders-delivered
```

Order statuses: 1 Pending, 2 Approved, 3 Backordered, 4 Rejected, 5 Shipped,
6 Cancelled, 7 Delivered. Delays and delivery windows come from the order pipeline
configuration (`awOrderPipelineConfig`). Shipped and delivered emails are only sent
when `ORDER_NOTIFICATIONS_EMAIL_ENABLED` is `true`; otherwise the content is logged.
The receipt queue produces a PDF in the private `adventureworks-receipts` container.

Events on the `orders` group are sanitized to a generic `orders-changed` signal before
they leave the server. See [real-time eventing](realtime-eventing.md).

## 4. Admin data call with a DAB role

Employees sign in with Authorization Code + PKCE. Every DAB request includes the bearer
token and an `X-MS-API-ROLE` header naming one of the roles in the token.

```mermaid
sequenceDiagram
  autonumber
  actor E as Employee
  participant ADM as Admin portal
  participant AS as api-mcp
  participant DAB as DAB API
  participant SQL as Azure SQL
  participant FN as Functions API

  E->>ADM: Sign in (email + password)
  ADM->>AS: Form POST /login → /authorize (PKCE S256,<br/>client=adventureworks-admin, resource=…/dab)
  AS->>SQL: Verify user, department → role → scopes
  AS-->>ADM: Redirect /oauth/callback?code=…
  ADM->>AS: POST /token (code + verifier)
  AS-->>ADM: DAB token + refresh token
  ADM->>AS: refresh_token with resource=…/functions and …/mcp
  AS-->>ADM: Functions and MCP tokens
  ADM->>DAB: POST /graphql<br/>Authorization: Bearer, X-MS-API-ROLE: executive-admin
  Note over DAB: Validate iss/aud/exp/signature,<br/>role must be in roles claim,<br/>apply entity permissions
  DAB->>SQL: Query
  DAB-->>ADM: Data
  ADM->>FN: GET /api/reporting/sales-trends (Functions token)
  Note over FN: Middleware: sales.read + internal category
  FN-->>ADM: Data
```

The manufacturing portal follows the same pattern with client
`adventureworks-manufacturing` and the `manufacturing-engineer` role.

## 5. MCP tool call via the Functions proxy

Some MCP tools (manufacturing, supply chain, bank and simulator) are thin proxies over
Functions routes. api-mcp checks the **user's** scope first, then calls Functions with a
short-lived service token that records the user as `obo_sub`.

```mermaid
sequenceDiagram
  autonumber
  participant CL as MCP client (agent or Inspector)
  participant MCP as api-mcp /mcp
  participant FN as Functions API
  participant TS as Table Storage / SQL

  CL->>MCP: tools/call begin_manufacturing_run<br/>(MCP-audience user token)
  Note over MCP: 1 identity → 2 mcp.access → 3 tool scope<br/>(manufacturing.write) → 4 access mode<br/>→ 5 service-principal allow-list<br/>→ 6 autonomy guard → 7 confirmation
  MCP->>MCP: Mint 5-min service JWT<br/>aud=…/functions, sub=service:api-mcp, obo_sub=user
  MCP->>FN: POST /api/manufacturing/... (Bearer service token)
  Note over FN: Validate token, route scope,<br/>non-consumer category
  FN->>TS: Update simulation state
  FN-->>MCP: 200 result
  MCP-->>CL: Tool result
```

The service token never widens access: the user's own scope has already been checked.
Forty Functions routes are reachable this way. The tool-to-scope list is in
[TOOL_SCOPE_MATRIX.md](../features/mcp-oauth/TOOL_SCOPE_MATRIX.md).

## 6. Storefront AI chat (delegated MCP token)

```mermaid
sequenceDiagram
  autonumber
  participant SPA as Storefront chat
  participant FN as Functions /api/agent/chat
  participant FD as Foundry Responses API
  participant MCP as api-mcp /mcp

  SPA->>FN: POST /api/agent/chat (MCP-audience token, message)
  Note over FN: Validate MCP token, resolve CustomerID<br/>from signed subject
  FN->>FD: GET agent definition (cached)
  FN->>FD: POST /openai/v1/responses<br/>tools + user token in MCP headers,<br/>x-policy-id: AdventureWorks-Eshop
  FD->>MCP: tools/call get_customer_orders (user token)
  Note over MCP: Ownership: customerId forced to caller
  MCP-->>FD: Caller's orders only
  FD-->>FN: Response text
  FN-->>SPA: { response, toolsUsed, threadId, safety }
```

Details are in [AI architecture](ai-architecture.md).

## 7. Hosted manufacturing agent run

When the manufacturing agent mode is not Off, every new order triggers an agent run.

```mermaid
sequenceDiagram
  autonumber
  participant Q as manufacturing-agent-queue
  participant FN as ManufacturingAgentQueueTrigger
  participant TBL as awManufacturingAgentRuns
  participant HA as Hosted manufacturing-agent
  participant AS as api-mcp /token
  participant MCP as api-mcp /mcp
  participant WPS as Web PubSub

  Q-->>FN: Run message
  FN->>FN: Re-check mode (discard if Off)
  FN->>TBL: Mark run started
  FN->>WPS: manufacturing-agent: run-started
  FN->>HA: POST Responses (Entra token for ai.azure.com)<br/>"Mode=ProposePending (2)"
  HA->>AS: managed-identity grant (client adventureworks-agents)
  AS-->>HA: MCP token (scopes for the mode)
  HA->>MCP: Read tools (status, inventory, shortages, …)
  opt Mode = FullyAutonomous
    HA->>MCP: begin_manufacturing_run / place_supply_order
  end
  HA-->>FN: JSON {findingsSummary, toolsUsed,<br/>recommendedActions, actionsExecuted}
  opt Mode = ProposePending
    FN->>FN: Create a proposal per recommended action
  end
  FN->>TBL: Mark run completed
  FN->>WPS: manufacturing-agent: run-completed
```

Modes: Off (0, default), ReadOnly (1), ProposePending (2) and FullyAutonomous (3).
Failed calls are retried with exponential backoff (10 s × 2^n, up to 8 attempts). See
[manufacturing agent](../features/manufacturing/manufacturing-agent.md) and the
[hosted agent service](../services/manufacturing-agent.md).

## Related documentation

- [System overview](system-overview.md)
- [Identity and authentication](identity-and-auth.md)
- [Real-time eventing](realtime-eventing.md)
- [Functions route reference](../reference/functions-routes.md)
- [ROUTE_SCOPE_MATRIX.md](../features/functions-oauth/ROUTE_SCOPE_MATRIX.md)
