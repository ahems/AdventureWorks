# AdventureWorks Admin Portal (`app-admin`)

This project is the internal administration portal for the AdventureWorks e-commerce demo. It is a React + TypeScript + Vite SPA deployed as an **Azure Container App** (with `minReplicas: 0` for scale-to-zero).

---

## Overview

The admin portal gives store managers and employees visibility into every corner of the AdventureWorks business:

- **Dashboard** — live KPIs: product count, customer count, pending orders, reviews, and recent order activity.
- **Products / Categories** — browse and manage the product catalog, including product detail and category drill-downs.
- **Customers** — search customers, view purchase history, send emails, and see individual customer stats.
- **Orders** — browse all orders with status, drill into order lines, and manually advance order status.
- **Stores** — B2B store management: view store profiles, order history, and place phone/email orders on behalf of stores.
- **Reviews** — view product reviews, run AI-powered sentiment analysis, and generate synthetic reviews with merchant replies.
- **Promotions** — AI-powered promotion campaign generation with multi-turn refinement.
- **Stale Carts** — view abandoned carts and run the AI cart recovery analysis agent.
- **Generate Order** — simulate realistic purchase orders for any customer persona using the Foundry Order Generation agent.
- **Reports** — pre-aggregated analytics charts (revenue by category, monthly trend, top products, orders by status, revenue by territory, inventory by category). Powered by direct SQL aggregation in Azure Functions to bypass DAB's 100-item pagination limit. See [docs/features/reporting/REPORTING.md](../docs/features/reporting/REPORTING.md).
- **Product Profitability / Loss Makers / Slow Movers** — financial health reports by product.
- **Inventory Transactions** — detailed stock movement log.
- **Cultures / Currencies** — manage i18n cultures and refresh exchange rates.
- **Search** — full-text product search across the catalog.
- **Utilities** — admin tools for triggering AI content generation (images, descriptions, embeddings, reviews, translations).
- **Customer Stats** — aggregate spending and cohort analysis for the customer base.
- **AI Agent Chat** — embedded AI agent sidebar available on every authenticated page for quick lookups and actions.

---

## Tech Stack

| Layer        | Technology                                                           |
| ------------ | -------------------------------------------------------------------- |
| Framework    | React 19 + TypeScript + Vite                                         |
| Styling      | Tailwind CSS with custom `doodle-*` design tokens                    |
| Components   | shadcn/ui (Radix primitives)                                         |
| State / Data | TanStack Query (React Query)                                         |
| Charts       | Recharts                                                             |
| Routing      | React Router v6                                                      |
| Auth         | Custom `AuthContext` with credential-based login via Azure Functions |
| Build        | `npm run build` → `dist/`                                            |
| Container    | Docker multi-stage build (`node:20-bookworm-slim` via MCR mirror)    |
| Hosting      | Azure Container App (remote ACR build, `minReplicas: 0`)             |

---

## Project Structure

```
app-admin/src/
├── App.tsx                    # Root router with all page routes
├── components/
│   ├── AdminHeader.tsx        # Top nav with all section links + theme toggle
│   ├── AiAgentChat.tsx        # AI agent sidebar (available on all auth pages)
│   ├── Footer.tsx
│   └── ui/                   # shadcn/ui component library
├── context/
│   └── AuthContext.tsx        # Login state, credentials, logout
├── hooks/
│   ├── useDashboardStats.ts
│   ├── useReportingData.ts    # React Query hooks for reporting charts
│   └── ...                   # Per-feature data hooks
├── pages/
│   ├── Index.tsx              # Dashboard
│   ├── ProductsPage.tsx
│   ├── ProductPage.tsx
│   ├── CategoriesPage.tsx
│   ├── CategoryPage.tsx
│   ├── CustomersPage.tsx
│   ├── CustomerStatsPage.tsx
│   ├── OrdersPage.tsx
│   ├── StoresPage.tsx
│   ├── ReviewsPage.tsx
│   ├── PromotionsPage.tsx
│   ├── StaleCartsPage.tsx
│   ├── GenerateOrderPage.tsx
│   ├── ReportsPage.tsx
│   ├── ProductProfitabilityPage.tsx
│   ├── LossMakersPage.tsx
│   ├── SlowMoversPage.tsx
│   ├── InventoryTransactionsPage.tsx
│   ├── CulturesPage.tsx
│   ├── CurrenciesPage.tsx
│   ├── SearchPage.tsx
│   ├── UtilitiesPage.tsx
│   ├── LoginPage.tsx
│   └── NotFound.tsx
└── services/                 # API call helpers
```

---

## Authentication

Authentication uses a custom `AuthContext` that calls `POST /api/password/verify` on the Azure Functions backend. Credentials are stored in `localStorage` for session persistence. There is no OAuth/Entra ID integration for the admin portal — it uses the AdventureWorks `Person.Password` table directly.

All pages check `useAuth().isAuthenticated`. Unauthenticated users are redirected to `/login`.

---

## Environment / Configuration

The admin portal reads its runtime config from `public/config.js`, which is generated at container start by `docker-entrypoint.sh`. This allows environment variables injected into the Container App to be consumed by the SPA at runtime without a rebuild.

Key runtime variables:

| Variable                            | Purpose                                            |
| ----------------------------------- | -------------------------------------------------- |
| `VITE_API_URL`                      | GraphQL/REST endpoint of the DAB API Container App |
| `VITE_API_FUNCTIONS_URL`            | Base URL of the Azure Functions Container App      |
| `VITE_API_MCP_URL`                  | MCP service URL (for AI agent features)            |
| `VITE_APPINSIGHTS_CONNECTIONSTRING` | Application Insights connection string             |

---

## Local Development

The admin portal can be run locally against the Azure-deployed backend:

```bash
cd app-admin
npm install
npm run dev
```

Vite will start on `http://localhost:5174` (or similar). Set the API URLs in `app-admin/.env.local`:

```env
VITE_API_URL=https://<your-dab-containerapp>.azurecontainerapps.io/graphql/
VITE_API_FUNCTIONS_URL=https://<your-functions-app>.azurewebsites.net
```

Or, after `azd up`, copy values from `azd env get-values`.

---

## Deployment

The admin portal is deployed via `azd deploy app-admin`, which:

1. Triggers a remote Docker build in Azure Container Registry using `mcr.microsoft.com/mirror/docker/library/node:20-bookworm-slim` (MCR mirror to avoid Docker Hub rate limits).
2. Pushes the built image to ACR.
3. Updates the `av-app-admin-*` Container App revision with the new image.

The Container App is configured with `minReplicas: 0` to scale to zero when idle (cost-efficient for a demo).

---

## Related Documentation

- [docs/features/reporting/REPORTING.md](../docs/features/reporting/REPORTING.md) — SQL-backed chart architecture
- [docs/features/ai-agent/AI_AGENT_AUTOMATION.md](../docs/features/ai-agent/AI_AGENT_AUTOMATION.md) — admin AI agents (order, promotion, cart recovery, product content)
- [api-functions/README.md](../api-functions/README.md) — all backend Functions the admin portal calls
- [api/README.md](../api/README.md) — DAB GraphQL/REST API used for catalog and entity data
