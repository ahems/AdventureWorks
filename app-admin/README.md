---
title: Admin portal app (app-admin/) — React SPA on Azure Container Apps
summary: Component README for the AdventureWorks employee admin portal; how to run, build, configure and deploy it, with links to the full admin portal guide.
audience: [developer, ai-agent]
components: [app-admin]
related: [docs/apps/admin-portal.md, docs/architecture/realtime-eventing.md, docs/operations/deployment.md]
---

# Admin portal app (`app-admin/`)

The internal back-office for AdventureWorks employees: dashboard KPIs, products,
customers, orders, B2B stores, reviews, promotions, stale carts, reports, simulators
and AI utilities. Only employees can sign in (api-mcp OAuth, authorization code +
PKCE). For the page map and feature tour, see
**[docs/apps/admin-portal.md](../docs/apps/admin-portal.md)**.

**Tech and hosting:** React 18.3, TypeScript, Vite, Tailwind CSS, shadcn/ui, TanStack
Query and Recharts, packaged as a container (remote ACR build) and hosted on
**Azure Container Apps** with scale-to-zero (azd service `app-admin`).

## Key folders

| Path | Contents |
|---|---|
| `src/pages/` | One component per admin page |
| `src/services/` | Functions/DAB/MCP API helpers, including the Functions OAuth interceptor and `dabFetch` (authenticated DAB GraphQL/REST fetch) |
| `src/lib/permissions.ts`, `src/hooks/useCan.ts`, `src/components/Can.tsx` | Scope-based UI gating from the token's `scope` claim |
| `src/hooks/` | React Query hooks and live-update listeners |
| `src/context/AuthContext.tsx` | OAuth sign-in state and resource tokens |
| `docker-entrypoint.sh` | Writes `config.js` from Container App environment variables at start-up |

## Build and test

The portal runs only in Azure; build and test locally, then deploy.

```bash
cd app-admin
npm ci
npm run build
npm run lint
npm run typecheck
npm test
```

`npm test` runs the Vitest suite (jsdom): `dabFetch` headers and token-refresh retry,
the DAB REST hooks using it, and scope gating. The cross-frontend live-updates regression
(`node --experimental-vm-modules --test tests/scripts/test-live-updates.mjs`) covers its
event batching and no-polling rule.

## API calls and permissions

- Send every DAB call (GraphQL or REST) through `graphqlClient` or `dabFetch` from
  `@/services/dabFetch`; they attach the DAB-audience bearer token and `X-MS-API-ROLE`.
  Do not call DAB with plain `fetch`. Functions calls use plain `fetch`; the
  interceptor in `src/services/functionsAuthInterceptor.ts` adds the Functions token.
- Gate actions with `useCan(Scopes.X)` or `<Can scope={Scopes.X}>` so roles without the
  required scope do not see (or cannot click) them. This is UI only; DAB and Functions
  remain authoritative.

## Monitoring and browser observability

`/monitoring` and its navigation entry require executive-admin and `monitoring.read`.
Capture controls additionally require `monitoring.write`; the Functions API remains
authoritative. The page reads the protected summary (`1h`, `6h`, `24h`), trace and capture
contracts using Functions-audience tokens. It shows source timestamps, observed zeros,
unknown/null counters, partial/forbidden/throttled/unavailable outcomes and retained stale
snapshots separately. Source rows and trace timelines are real backend projections, not
sample/demo telemetry. Azure ingestion is delayed: application push events invalidate
cached reads but do not prove that telemetry has arrived.

The existing Web PubSub connection, fixed-window batching, in-flight follow-ups and
focus/reconnect recovery drive reads; there is no polling or manual refresh control.
Rich capture is off by default, explicitly session/job selected and server-bounded to
15 minutes/100 root operations. The countdown is display-only. Stop does not delete
ingested content; supported reasoning summaries may be absent and provider-managed
tracing remains independent. Operator portal/workbook/Grafana links require separate
Entra/RBAC access.

Session capture selects the server-issued monitoring session GUID shown in an owned
chat. It is recovered from stored conversation metadata after ownership verification,
not inferred from a caller ID, tab or arbitrary trace header. Rich job capture is supported
only for persisted manufacturing agent runs using their exact canonical `RunId`. The
consumer verifies stored order/customer/nonterminal provenance and shares one root across
retries; queue `CaptureId` does not enable capture. Captured content is the application
request and parsed hosted findings/actions output, not internal hosted tool traces,
hidden reasoning or provider-managed content. Other jobs remain metadata-only.
No arbitrary capture header or browser token enables rich tracing.
Container CPU/memory limits are per replica while platform metric rollups can span
replicas/revisions; the view does not invent pressure percentages from those values.

Browser telemetry disables header capture, restricts W3C correlation to configured
solution hosts, normalizes routes and centrally redacts URL queries, nested/serialized
credentials and error content. React/query/mutation/HTTP failures and HTTP-200 GraphQL
logical errors retain separate outcomes; Web Vitals and realtime connection states
contain no signed URLs or message payloads. Set `VITE_BUILD_VERSION` at build time to
identify a known build; otherwise the version is unknown.

Focused tests: `npm test -- src/pages/MonitoringPage.test.tsx src/services/monitoringService.test.ts src/lib/browserSignals.test.ts src/components/TelemetryErrorBoundary.test.tsx`.

## Configuration

At container start `docker-entrypoint.sh` writes `window.APP_CONFIG` (`API_URL`,
`API_FUNCTIONS_URL`, `API_MCP_URL`, `APPINSIGHTS_CONNECTIONSTRING` and app links).
See [runtime configuration](../docs/apps/admin-portal.md#runtime-configuration)
and the [environment variables reference](../docs/reference/environment-variables.md).

## Deploy

```bash
azd deploy app-admin --no-prompt
```

## Related docs

- [Admin portal guide](../docs/apps/admin-portal.md)
- [Reporting](../docs/features/finance/reporting.md)
- [Foundry agents](../docs/features/ai/foundry-agents.md)
- [Shopping simulator](../docs/features/simulators/shopping-simulator.md)
- [Real-time eventing](../docs/architecture/realtime-eventing.md)
- [Functions routes](../docs/reference/functions-routes.md)
