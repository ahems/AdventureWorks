---
title: Storefront app (app/) — React SPA on Azure Static Web Apps
summary: Component README for the AdventureWorks customer storefront; how to run, build, test, configure and deploy it, with links to the full storefront guide.
audience: [developer, ai-agent]
components: [app]
related: [docs/apps/storefront.md, docs/architecture/realtime-eventing.md, docs/features/monitoring/HEALTH_DIAGNOSTICS.md, docs/operations/deployment.md]
---

# Storefront app (`app/`)

The customer-facing AdventureWorks e-shop: browse and search the catalog, manage a
cart, check out, view orders and receipts, chat with the AI assistant and switch
between 23 locales. It reads catalog data from the DAB GraphQL API, calls Azure
Functions for business workflows and signs users in through the api-mcp OAuth server.
For the page-by-page guide, see **[docs/apps/storefront.md](../docs/apps/storefront.md)**.

**Tech and hosting:** React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui and TanStack
Query, built locally and deployed to **Azure Static Web Apps** (azd service `app`).

## Key folders

| Path | Contents |
|---|---|
| `src/pages/`, `src/components/` | Routes and UI components |
| `src/data/apiService.ts`, `src/hooks/` | GraphQL data service and React Query hooks |
| `src/hooks/useRealTimeUpdates.ts` | Web PubSub event → query-invalidation dispatcher |
| `src/locales/` | Bundled translation JSON (23 locales) |
| `scripts/` | Build-time config generation and `node --test` regression tests |
| `staticwebapp.config.template.json` | SPA fallback, sitemap redirect and security headers |

## Build and test

The storefront runs only in Azure; build and test locally, then deploy.

```bash
cd app
npm ci
npm run build        # generates config.js and builds dist/
npm run lint
npm run typecheck    # tsc --noEmit for tsconfig.app.json and tsconfig.node.json
node --test scripts/*.test.mjs
```

The storefront has no `npm test` script; run the `node --test` files directly. The
cross-frontend live-updates regression is
`node --experimental-vm-modules --test tests/scripts/test-live-updates.mjs` (from the repo root).

## Configuration

Runtime values come from `window.APP_CONFIG` in `/config.js` (generated during
`azd deploy`), falling back to `VITE_API_URL`, `VITE_API_FUNCTIONS_URL` and
`VITE_API_MCP_URL`, which `predeploy.sh` writes to `.env.production`. See
[runtime configuration](../docs/apps/storefront.md#runtime-configuration) and the
[environment variables reference](../docs/reference/environment-variables.md).

## Deploy

```bash
azd deploy app --no-prompt
```

The predeploy hook writes `.env.production` and `staticwebapp.config.json`; see
[deployment](../docs/operations/deployment.md).

## Related docs

- [Storefront guide](../docs/apps/storefront.md)
- [Health diagnostics (`/health`)](../docs/features/monitoring/HEALTH_DIAGNOSTICS.md)
- [Real-time eventing](../docs/architecture/realtime-eventing.md)
- [Localization](../docs/features/i18n/localization.md)
- [DAB naming conventions](../docs/architecture/dab-naming-conventions.md)
- [Testing strategy](../docs/testing/testing-strategy.md)
