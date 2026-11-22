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
