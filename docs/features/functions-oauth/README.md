# Functions API OAuth Authorization

For cross-solution coverage, executable validation and known gaps, see
[end-to-end authentication assurance](../authentication/END_TO_END_AUTHENTICATION.md).
Route counts reflect the latest source inventory; use the runner's reflected
inventory to detect later changes.

> Extends the self-contained AdventureWorks OAuth demo — already protecting the **MCP**
> server ([`docs/features/mcp-oauth`](../mcp-oauth/README.md)) and the **DAB** GraphQL/REST
> API (JWT config in [`api/dab-config.json`](../../../api/dab-config.json), see
> [`api/README.md`](../../../api/README.md)) — to the previously-anonymous
> **`api-functions`** HTTP surface.
>
> **Status: Enforced.** The `api-functions` resource server validates api-mcp-issued bearer
> tokens and applies per-route scope/category/ownership checks, with `FUNCTIONS_OAUTH_MODE=enforced`.
> All three first-party apps attach per-user Functions tokens minted silently from their sign-in
> refresh token, and api-mcp attaches a self-minted **service token** to the calls its MCP tools
> proxy. Only the explicit Tier P routes are reachable anonymously. See
> [Enforcement modes](#enforcement-modes) and [Remaining limitations](#remaining-limitations).

## Contents

- [What this covers](#what-this-covers)
- [Current state](#current-state)
- [Relationship to the MCP and DAB OAuth work](#relationship-to-the-mcp-and-dab-oauth-work)
- [Caller topology (who calls api-functions)](#caller-topology-who-calls-api-functions)
- [Authorization tiers](#authorization-tiers)
- [MCP-proxied routes — api-mcp service token](#mcp-proxied-routes--api-mcp-service-token)
- [Two design problems and their resolutions](#two-design-problems-and-their-resolutions)
- [Scopes and roles](#scopes-and-roles)
- [Ownership / record-level authorization](#ownership--record-level-authorization)
- [Resource identifier / audience design](#resource-identifier--audience-design)
- [Route-to-scope matrix](#route-to-scope-matrix)
- [Enforcement modes](#enforcement-modes)
- [Implementation roadmap](#implementation-roadmap)
- [Remaining limitations](#remaining-limitations)
- [Source map](#source-map)

## What this covers

### Executable worker boundary coverage

The [middleware matrix](../../../api-functions.Tests/FunctionsAuthorizationMiddlewareTests.cs)
invokes the real `FunctionsAuthorizationMiddleware` and access-token validator with
RSA-signed tokens, SDK HTTP request features and the SDK's real invocation-result
feature. It does not replace middleware decisions with mocked outcomes. The
test-only fixture uses reflection to construct the SDK's internal gRPC binding
feature; an incompatible SDK change fails the tests rather than silently skipping it.

For every protected policy it checks missing-token denial, wrong-scope denial,
matching internal access with signed subject/owner projection and consumer
category behavior. Every denial requires zero handler calls, an anonymous current
identity and the actual JSON response/status/challenge. Public policies remain
public even with an unusable token. Additional cases cover wrong MCP/DAB audiences,
issuer, signature, expiry, unknown category, malformed tokens, missing validator
configuration, unclassified HTTP functions and explicit non-enforcing/non-HTTP modes.
Forged client principal/role headers and query owner IDs cannot replace the signed identity.
Structurally invalid JWTs are rejected before metadata retrieval. Well-formed tokens
still require normal signing-key, issuer, audience and lifetime validation and fail
closed if OAuth metadata is unavailable.

An earlier matrix passed **733 cases over 196 policies**, and that complete Functions
suite now passes **1,053 tests**, including 22 address ownership handler cases and
six private fixture-identity cases. The assurance runner reconciles exact current-run TRX
case names against its reflected inventory: missing/skipped/duplicated/new-policy
evidence cannot pass. It retains a separate BLOCKED obligation for a complete real
host/route-binding and mutation-side-effect matrix and for SQL-backed ownership.
The middleware challenge now trims the issuer's trailing slash before advertising
`/.well-known/oauth-protected-resource`.

Run locally with existing restored dependencies:

```bash
dotnet test api-functions.Tests/api-functions.Tests.csproj --no-restore \
  --filter FullyQualifiedName~FunctionsAuthorizationMiddlewareTests
```

The live/all assurance profile additionally performs reviewed GET host denials
for absent/malformed/cross-audience tokens, manufacturing scope isolation, forged
internal headers and a reusable consumer. It also sends deliberately invalid
order-header/detail payloads with absent and malformed tokens; those payloads
cannot create an order. It requires the exact status, JSON policy error and
canonical metadata challenge, not just any 401/403. Missing fixtures remain
BLOCKED. These checks do not establish the complete deployed-handler matrix or
valid-token ownership and side effects.

`api-functions` is the .NET-isolated Azure Functions app (running on Flex Consumption) that
provides custom business logic for the e-shop, admin, and manufacturing frontends, plus AI
agent hosting and simulators. Every one of its **200 HTTP-triggered Functions is declared
`AuthorizationLevel.Anonymous`** at the platform level; authorization is applied by the OAuth
middleware instead. This work decides — for each route — whether it should stay
anonymous or become an OAuth-protected resource, and with which scope and access mode, reusing
the exact same authorization server, scope catalog, and validation approach already shipped for
MCP and DAB.

Non-HTTP queue, SQL, timer and Durable triggers are internal and not externally
reachable; their Azure dependency identities still require separate assurance.

## Current state

| Trigger kind | Count | In scope for OAuth? |
| ------------ | ----- | ------------------- |
| HTTP (`HttpTrigger`) | 200 | **Yes** — classified in the matrix |
| Queue (`QueueTrigger`) | 15 | No — internal |
| SQL (`SqlTrigger`) | 2 | No — internal |
| Timer (`TimerTrigger`) | 6 | No — internal |
| Durable activity / orchestration | 17 / 5 | No — internal |

All HTTP routes were anonymous before this work. `Program.cs` uses
`ConfigureFunctionsWebApplication()` (ASP.NET Core integration), so a JWT-validation
**middleware** (`IFunctionsWorkerMiddleware`,
[`FunctionsAuthorizationMiddleware`](../../../api-functions/Auth/FunctionsAuthorizationMiddleware.cs))
is now the enforcement point — the same signature/issuer/audience/lifetime/subject/scope checks
used by the MCP and DAB resource servers, validating against the api-mcp JWKS. Enforcement is
gated by [mode](#enforcement-modes). Every first-party client supplies a Functions token, so the
deployed mode is `enforced`.

## Relationship to the MCP and DAB OAuth work

The authorization server (OpenIddict, hosted in **api-mcp**) is already **multi-resource**
(RFC 8707): it mints short-lived, resource-bound JWTs for the MCP resource (`{issuer}/mcp`) and
the DAB resource (`{issuer}/dab`), signs them with a Key Vault-backed RSA key, and exposes JWKS.
Protecting Functions adds **one more resource identifier** (`{issuer}/functions`) to the same
server — `api-functions` becomes a pure **resource server** that validates tokens via the api-mcp
JWKS and needs **no Key Vault access of its own**. This keeps the least-privilege story clean and
reuses all existing building blocks.

## Caller topology (who calls api-functions)

Understanding every caller is what determines the tiers — especially which endpoints must stay
anonymous to avoid breaking existing behavior.

```mermaid
flowchart LR
  subgraph Browsers
    ESHOP[app / e-shop<br/>anonymous + consumer]
    ADMIN[app-admin<br/>employees only]
    MFG[app-manufacturing<br/>manufacturing staff only]
  end
  MCP[api-mcp<br/>MCP tools]
  FUNC[api-functions<br/>199 HTTP Functions]

  ESHOP -->|catalog, addresses, receipts,<br/>agent/chat, pre-auth| FUNC
  ADMIN -->|reporting, simulators, reviews,<br/>B2B store, AI generation| FUNC
  MFG -->|warehouse, planning, agent,<br/>manufacturing/supply| FUNC
  ESHOP -.->|agent/chat forwards<br/>MCP-audience token| FUNC
  FUNC -->|forwards user token| MCP
  MCP -->|"manufacturing/supply/bank/simulator<br/>(api-mcp service token)"| FUNC
```

Two facts drive the design:

1. **`api-functions` → `api-mcp`.** The `agent/chat` endpoint already forwards the caller's
   **MCP-audience** token to the protected `/mcp` so agent tool calls run as the real user.
2. **`api-mcp` → `api-functions`.** Four proxy services (`ManufacturingService`,
   `SupplyChainService`, `BankService`, `SimulatorService`) call 40 Functions endpoints,
   backing the manufacturing/supply/bank/simulator MCP tools, with an **api-mcp service token**.

## Authorization tiers

Every route is assigned exactly one tier (full list in
[`ROUTE_SCOPE_MATRIX.md`](./ROUTE_SCOPE_MATRIX.md)):

| Tier | Name | Meaning | Count |
| ---- | ---- | ------- | ----- |
| **P** | Anonymous | No token. Public catalog, discovery, health, password-reset pre-auth, consumer signup, and bounded cart capability handlers. | 20 |
| **A** | Authenticated (group-scoped) | Valid Functions token + `realtime.connect`; group grants also require the mapped domain scope/category. | 1 |
| **C** | Consumer (ownership) | Valid token + business scope; consumers are restricted to their **own** records. Some handlers also constrain internal callers. | 16 |
| **I** | Internal-only | Valid token + business scope + **non-consumer category** (defense-in-depth). Includes the 40 MCP-proxied routes. | 162 |
| | | **Total** | **199** |

## MCP-proxied routes — api-mcp service token

The 40 endpoints the four proxy services call were originally left anonymous ("Tier M") because
api-mcp had no way to obtain a Functions-audience token. They are now ordinary **Internal-only**
routes. api-mcp *is* the authorization server, so it mints its own token in-process — no client
secret, no extra grant, no network round-trip:

```mermaid
sequenceDiagram
  participant U as User (browser / agent)
  participant M as api-mcp (/mcp)
  participant F as api-functions
  U->>M: MCP tool call (MCP-audience user token)
  Note over M: tool policy checks the USER's scope<br/>(e.g. manufacturing.write)
  M->>M: FunctionsServiceTokenHandler mints a 5-min JWT<br/>aud={issuer}/functions, category=service
  M->>F: POST /api/manufacturing/begin (Bearer service token)
  Note over F: validates signature/iss/aud/exp via JWKS<br/>+ route scope + non-consumer category
  F-->>M: 200
  M-->>U: tool result
```

[`FunctionsServiceTokenHandler`](../../../api-mcp/AdventureWorks/Auth/FunctionsServiceTokenHandler.cs)
is a `DelegatingHandler` on the four proxy `HttpClient`s. The token carries `sub=service:api-mcp`,
`category=service`, only the scopes the proxied routes need (`manufacturing.read/write`,
`inventory.read`, `sales.read`, `admin.read/write`) and an audit-only `obo_sub` with the end user's
subject. Because the MCP tool has already enforced the end user's scope, the service token never
widens what a user can do; browsers reach the same routes only with their **own** per-user token.

## Two design problems and their resolutions

1. **`agent/chat` audience conflict.** If `agent/chat` validated a *Functions* audience, it could
   not also forward an *MCP* audience token to `/mcp` (a token targets exactly one resource; the AS
   returns `invalid_target` for multiple). **Resolution:** keep the agent-host endpoints
   (`agent/chat`, `agent/status`) **anonymous pass-throughs** (Tier P). The anonymous e-shop
   assistant is preserved, and MCP tool authorization is still enforced downstream at `/mcp`.
2. **`api-mcp` → `api-functions` M2M.** Resolved by the in-process service token above.

## Scopes and roles

Reuses the shared business-domain catalog in
[`OAuthScopes.cs`](../../../api-mcp/AdventureWorks/Auth/OAuthScopes.cs). Distribution across the protected Function policies (Tier A/C/I):

| Scope | Routes | New? |
| ----- | -----: | ---- |
| `admin.write` | 42 | existing |
| `manufacturing.read` | 43 | existing |
| `sales.read` | 23 | existing |
| `manufacturing.write` | 27 | existing |
| `admin.read` | 19 | existing |
| `orders.write` | 7 | existing |
| `customers.write` | 5 | existing |
| `orders.read` | 5 | existing |
| `customers.read` | 4 | existing |
| **`realtime.connect`** | 1 | **new — added by this work** |

`realtime.connect` is required to negotiate a browser Web PubSub capability. It does
not grant arbitrary group membership: the caller also needs each group's mapped
business scope, and internal groups require a recognized internal category.
The group-to-scope map is implemented and tested in `WebPubSubService`; the
seeded role grants and frontend scope requests are included in this work. The
`customers.write` scope remains required for self-owned address changes through
Functions. Scope assignments align with the sibling MCP matrix wherever a
parallel capability exists.

Roles resolve to scopes from source-controlled policy
([`ApplicationRoles.cs`](../../../api-mcp/AdventureWorks/Auth/ApplicationRoles.cs)).
The runtime does not query or require `Auth.RoleScope` or other authorization-catalog
tables. No permissions are hard-coded by user name.

## Ownership / record-level authorization

Tier C routes require the scope **and** record ownership. Ownership is resolved **server-side**
from the validated token's subject/owner claims (`customer_id` / `business_entity_id`), never from
a client-supplied identifier. Address endpoints overwrite consumer-supplied owner identifiers
with the signed owner, and id-addressed operations check the address link before reading or
mutating it. Consumer listings now filter the SQL query by that owner before pagination,
rather than filtering an already fetched global page. Internal roles (with the same scope)
retain unrestricted pagination.

The [address handler tests](../../../api-functions.Tests/AddressOwnershipTests.cs) exercise
22 two-owner, missing-owner, supplied-owner override and internal-compatibility cases with
the production camelCase serializer. Denied operations make no fake persistence reads or
mutations. Offline/all requires all exact current-run TRX cases to pass once; this handler
seam is not a SQL or running-host mutation proof.

Live/all uses GET-only address/person-address reads with the two retained consumers.
Nonempty fixtures must prove own-record success and the exact other-owner 403 error.
The targeted deployed run records **4 PASS, 2 BLOCKED** because both retained fixtures
have no addresses. Empty lists do not establish record ownership or nonempty pagination.
The standalone opt-in `--address-only` mode creates run-scoped fixtures through
Functions and DAB, records requests in an ephemeral test table, and verifies state
with read-only SQL. Exact owner/reference checks gate API cleanup; uncertain writes
or probes stop cleanup and are reported. This revised path has not yet been run
against the deployment. An earlier **29 PASS** private run used direct SQL fixtures
and does not verify the revised lifecycle or shared-address coverage. See the
[authentication guide](../authentication/END_TO_END_AUTHENTICATION.md#target-and-assurance-status).

The [password handler tests](../../../api-functions.Tests/PasswordOwnershipTests.cs)
add 30 two-owner/customer-type cases using `IPasswordService`. Consumer set/verify
is self-only; internal resets check the target is an individual customer before
writing, and internal verification is still self-only. Missing/unrecognized
identity context fails closed before storage. Worker token/scope enforcement
remains separate; signup stays public. Every exact current-run TRX case must pass
once in offline/all. Full Functions tests: **1,094 PASS**; Python regressions:
**102 PASS**. Normal targeted Functions deployment succeeded.

Live/all also uses the retained consumers for verification-only calls: correct
and incorrect own passwords, plus the exact other-owner denial in both
directions. The targeted deployed report has **9 PASS** (six verification calls,
two fixture logins and the handler-evidence gate). No passwords are changed or
accounts created. Customer-only reset mutations and SQL persistence are not
proven by these fake-write tests or read-only host requests.

## Resource identifier / audience design

- New canonical resource identifier **`{issuer}/functions`** (env-overridable, e.g.
  `FUNCTIONS_RESOURCE_IDENTIFIER`), added to the AS `AllowedResources()` allow-list next to the MCP
  and DAB identifiers — mirroring exactly how DAB was added.
- Frontends request the Functions resource via the RFC 8707 `resource` parameter and receive a
  token with `aud = {issuer}/functions`. Because each token targets a single resource, the MCP,
  DAB, and Functions tokens are **audience-isolated** and are stored under separate keys — a token
  minted for one resource is rejected by the others.
- Issuer, resource URI, endpoints, and redirect URIs are derived from deployed configuration (the
  api-mcp FQDN); no Azure hostnames are hard-coded.

## Route-to-scope matrix

The complete, authoritative source classification of all 199 Functions is in
**[`ROUTE_SCOPE_MATRIX.md`](./ROUTE_SCOPE_MATRIX.md)** — grouped by functional area, with method,
route, tier, required scope, access mode, and ownership key for every endpoint. It is the source of
truth the resource server enforces. Completeness is guaranteed by a reflection test
(`FunctionAuthorizationRegistryTests`) that fails closed if any HTTP-triggered `[Function]` is not
classified in the registry — exactly as `McpAuthorizationExtensions` does for MCP tools.

## Enforcement modes

The resource server reads `FUNCTIONS_OAUTH_MODE`
([`FunctionsOAuthOptions`](../../../api-functions/Auth/FunctionsOAuthOptions.cs)). Enforcement is
only possible when the issuer, audience, and OIDC metadata address are all resolved from
configuration. Explicit `enforced` or `audit` with incomplete configuration now fails
startup; invalid mode strings also fail instead of silently disabling protection.
An unset mode still defaults to `disabled` for local development.

| Mode | Token absent | Token present | Blocks? | Purpose |
| ---- | ------------ | ------------- | ------- | ------- |
| `disabled` | allowed | ignored | never | Explicit local pass-through; also the default when no mode is requested. Never valid for deployed assurance. |
| `audit` | allowed | validated; allow/deny logged to App Insights | never | Shadow mode for diagnosing a new client before enforcing. |
| `enforced` *(deployed)* | protected routes → `401` | validated + scope/category/ownership enforced | yes | Full enforcement. |

Infrastructure wires the mode in [`infra/main.bicep`](../../../infra/main.bicep) as `enforced`.
Tier P routes bypass middleware. `agent/chat` then validates an MCP-audience token
inside its handler; it is not an anonymous business endpoint.

### How each client obtains its Functions token

| Caller | Token source |
| ------ | ------------ |
| e-shop (`app/`) | Consumer token from the e-shop credential exchange; attached by `functionsFetch`. |
| admin (`app-admin/`) | Refresh-token resource switch to `{issuer}/functions`; attached to every Functions-bound `fetch` by [`functionsAuthInterceptor.ts`](../../../app-admin/src/services/functionsAuthInterceptor.ts). |
| manufacturing (`app-manufacturing/`) | Same pattern ([`functionsAuthInterceptor.ts`](../../../app-manufacturing/src/services/functionsAuthInterceptor.ts)). |
| api-mcp proxy tools | In-process service token ([`FunctionsServiceTokenHandler`](../../../api-mcp/AdventureWorks/Auth/FunctionsServiceTokenHandler.cs)). |
| AI agent chat | `agent/chat` is Tier P and receives the user's **MCP**-audience token, which it forwards to `/mcp`. |

## Implementation roadmap

The original OAuth integration phases are implemented; end-to-end assurance and
source/deployment reconciliation remain incomplete.

- **Phase A — Classification:** this document + the route matrix.
- **Phase B — Authorization server:** `functions` resource identifier + protected-resource
  metadata; `customers.write` scope and role grants; `FunctionsResourceTokenTests`.
- **Phase C — Resource server in `api-functions`:** JWT-validation middleware
  ([`FunctionsAuthorizationMiddleware`](../../../api-functions/Auth/FunctionsAuthorizationMiddleware.cs))
  + a visible per-route policy registry
  ([`FunctionAuthorizationRegistry`](../../../api-functions/Auth/FunctionAuthorizationRegistry.cs),
  mirroring the MCP tool registry) + Tier-C ownership checks
  ([`AddressFunctions`](../../../api-functions/Functions/AddressFunctions.cs),
  [`PasswordFunctions`](../../../api-functions/Functions/PasswordFunctions.cs)); structured App
  Insights authz telemetry.
- **Phase D — Frontends:** the e-shop, admin and manufacturing apps attach per-user Functions tokens
  silently after sign-in. Admin and manufacturing sign-in is performed solely by the api-mcp
  authorization server, which rejects users whose category does not match the portal.
- **Phase E — api-mcp service token:** the proxied endpoints graduated from anonymous to
  Internal-only.
- **Phase F — Infrastructure/AZD:** inject `FUNCTIONS_JWT_ISSUER` / `FUNCTIONS_JWT_AUDIENCE` /
  `FUNCTIONS_OAUTH_MODE=enforced` into the Function App settings from the deployed api-mcp FQDN.
- **Phase G — Docs & tests:** offline unit tests
  ([`api-functions.Tests`](../../../api-functions.Tests/)) covering registry completeness/no-stale
  entries, enforcement-mode resolution, and token-claim projection; portal category gating tests in
  [`api-mcp/AdventureWorks.Tests`](../../../api-mcp/AdventureWorks.Tests/PortalCategoryGatingTests.cs).

## Remaining limitations

- **Password-reset pre-auth flows and consumer signup stay anonymous by necessity** —
  `password/reset/*` and `signup` happen before the user has a token. `POST /api/password` and
  `POST /api/password/verify` now require a token: consumers act only on themselves, staff may only
  reset **customer** passwords, and verify is self-only (no password oracle).
- **`agent/status` stays public.** `agent/chat` bypasses Functions-audience middleware
  but requires a validated MCP-audience user token in its handler before forwarding;
  tool authorization is additionally enforced at `/mcp`.
- **`openapi.json` / `swagger/ui` stay anonymous** and may describe internal routes — acceptable for
  a demo; the routes themselves are still protected.

## Source map

| Path | Role |
| ---- | ---- |
| [`ROUTE_SCOPE_MATRIX.md`](./ROUTE_SCOPE_MATRIX.md) | Complete source route → tier/scope/mode/ownership matrix (all 199 Functions) |
| [`api-mcp/AdventureWorks/Auth/OAuthScopes.cs`](../../../api-mcp/AdventureWorks/Auth/OAuthScopes.cs) | Shared business-domain scope catalog (reused) |
| [`api-mcp/AdventureWorks/Auth/ApplicationRoles.cs`](../../../api-mcp/AdventureWorks/Auth/ApplicationRoles.cs) | Role → scope mapping (reused) |
| [`api-mcp/AdventureWorks/Auth/AuthorizationServerOptions.cs`](../../../api-mcp/AdventureWorks/Auth/AuthorizationServerOptions.cs) | Resource identifiers / `AllowedResources()` (includes `functions`) |
| [`api-mcp/AdventureWorks/Services/{Manufacturing,SupplyChain,Bank,Simulator}Service.cs`](../../../api-mcp/AdventureWorks/Services/) | The four proxy services whose calls carry the api-mcp service token |
| [`api-functions/Auth/`](../../../api-functions/Auth/) | The resource server: policy registry, options, token validator, user model, and enforcement middleware |
| [`api-functions/Functions/AddressFunctions.cs`](../../../api-functions/Functions/AddressFunctions.cs) | Tier-C consumer record-ownership reference implementation |
| [`app/src/services/eshopOAuth.ts`](../../../app/src/services/eshopOAuth.ts) | E-shop credential exchange and silent DAB/Functions token refresh |
| [`infra/modules/flex-api-functions.bicep`](../../../infra/modules/flex-api-functions.bicep) · [`infra/main.bicep`](../../../infra/main.bicep) | Injects issuer/audience/mode into the Flex Consumption Function App settings |
| [`api-functions.Tests/`](../../../api-functions.Tests/) | Offline resource-server unit tests (registry coverage, mode resolution, claim parsing) |
| [`docs/features/mcp-oauth/README.md`](../mcp-oauth/README.md) · [`api/README.md`](../../../api/README.md) | Sibling OAuth designs this extends (MCP + DAB) |
