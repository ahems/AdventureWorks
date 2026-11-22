---
title: Manufacturing portal app (app-manufacturing/) — React SPA on Azure Container Apps
summary: Component README for the AdventureWorks Manufacturing Hub; how to run, test, build, configure and deploy it, with links to the full manufacturing portal guide.
audience: [developer, ai-agent]
components: [app-manufacturing]
related: [docs/apps/manufacturing-portal.md, docs/features/manufacturing/manufacturing-overview.md, docs/features/manufacturing/manufacturing-content.md, docs/architecture/realtime-eventing.md]
---

# Manufacturing portal app (`app-manufacturing/`)

The AdventureWorks Manufacturing Hub for employees: products and bills of materials,
routings and instructions, planning, work-order execution, supply chain, receiving,
the warehouse and the hosted Manufacturing agent, organized into seven production
stages. It reads most data from the DAB REST API and calls Azure Functions for
workflows. For the page-by-page guide, see
**[docs/apps/manufacturing-portal.md](../docs/apps/manufacturing-portal.md)**.

**Tech and hosting:** React 18.3, TypeScript, Vite, Tailwind CSS, shadcn/ui and TanStack
Query; tested with Vitest. Packaged as a container (remote ACR build) and hosted on
**Azure Container Apps** (azd service `app-manufacturing`).

## Key folders

| Path | Contents |
|---|---|
| `src/pages/` | Stage pages (Define, Engineer, Plan, Execute, Supply, Receive, Warehouse) and agent pages |
| `src/services/`, `src/config/api.ts` | DAB REST and Functions clients; runtime URL resolution |
| `src/hooks/useRealTimeUpdates.ts` | Web PubSub event → query-invalidation dispatcher |
| `src/components/LoadingSkeletons.tsx` | Shared loading skeletons (required on every data page) |
| `src/data/manufacturing/`, `public/illustrations/` | Bundled instruction JSON and SVG illustrations |
| `scripts/export-illustrations.mjs` | Illustration export used by `npm run illustrations:export` |

## Run, test and build

```bash
cd app-manufacturing
npm install
npm run dev                  # Vite dev server on http://localhost:8080
npm test                     # Vitest (vitest run); npm run test:watch for watch mode
npm run lint
npm run build
npm run illustrations:export # regenerate the illustration export via Functions
```

> **Dev-port caveat:** api-mcp's built-in development redirect for this client is
> `http://localhost:5175/oauth/callback`, but Vite listens on 8080. For local sign-in,
> run `npm run dev -- --port 5175` (or register your own callback on api-mcp).

## Configuration

At container start `docker-entrypoint.sh` writes `window.APP_CONFIG`; `src/config/api.ts`
resolves each value from `APP_CONFIG`, then `VITE_*`, then localhost defaults. Locally,
set `VITE_API_URL`, `VITE_API_FUNCTIONS_URL` and `VITE_API_MCP_URL` in
`app-manufacturing/.env`. See
[runtime configuration](../docs/apps/manufacturing-portal.md#runtime-configuration) and the
[environment variables reference](../docs/reference/environment-variables.md).

## Deploy

```bash
azd deploy app-manufacturing --no-prompt
```

## Related docs

- [Manufacturing portal guide](../docs/apps/manufacturing-portal.md)
- [Manufacturing overview](../docs/features/manufacturing/manufacturing-overview.md)
- [Manufacturing content](../docs/features/manufacturing/manufacturing-content.md)
- [Manufacturing agent](../docs/features/manufacturing/manufacturing-agent.md)
- [Real-time eventing](../docs/architecture/realtime-eventing.md)
- [Testing strategy](../docs/testing/testing-strategy.md)
