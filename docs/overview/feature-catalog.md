---
title: AdventureWorks feature catalog
summary: Every user-visible feature of the AdventureWorks demo — storefront, admin portal, manufacturing portal, MCP Inspector and platform capabilities — with the app route that shows it, the backend that powers it and the page that documents it.
audience: [demo-presenter, developer, ai-agent]
components: [app, app-admin, app-manufacturing, api, api-functions, api-mcp, mcp-inspector, manufacturing-agent]
related: [what-it-demonstrates.md, demo-walkthrough.md, ../apps/storefront.md, ../apps/admin-portal.md, ../apps/manufacturing-portal.md, ../reference/functions-routes.md]
---

# AdventureWorks feature catalog

This catalog lists every user-visible feature in the AdventureWorks demo, grouped by business domain
in the same order as [`docs/features/`](../README.md#5-features-by-domain). Each row names the app and
route where you see it, the backend that implements it and the page that explains it.

**Apps:** **Store** = storefront ([docs](../apps/storefront.md)); **Admin** = admin portal
([docs](../apps/admin-portal.md)); **Mfg** = manufacturing portal ([docs](../apps/manufacturing-portal.md)).
**Backends:** **DAB** = Data API builder GraphQL/REST; **Fn** = Azure Functions (`/api/...`);
**MCP** = api-mcp tools; **Foundry** = Microsoft Foundry agents. Full route lists are in
[Functions routes](../reference/functions-routes.md) and [DAB entities](../reference/dab-entities.md).

## Commerce

| Feature | App / route | Backend | Doc |
| --- | --- | --- | --- |
| Home page with hero, categories, featured products and recently viewed | Store `/` | DAB products, categories, photos | [Catalog and browsing](../features/commerce/catalog-and-browsing.md) |
| Category listing with filters | Store `/category/:categoryId` | DAB | [Catalog and browsing](../features/commerce/catalog-and-browsing.md) |
| Product detail: gallery, sizes/colours, reviews, notify when available | Store `/product/:productId` | DAB | [Catalog and browsing](../features/commerce/catalog-and-browsing.md) |
| Sale page | Store `/sale` | DAB special offers | [Catalog and browsing](../features/commerce/catalog-and-browsing.md) |
| Compare up to three products | Store `/compare` | DAB | [Catalog and browsing](../features/commerce/catalog-and-browsing.md) |
| Guest cart that merges into the account on sign-in | Store `/cart` | Fn `cart/session`, `cart/items`, `cart/merge` | [Cart and checkout](../features/commerce/cart-and-checkout.md) |
| Checkout: address, shipping, tax, currency, discount code | Store `/checkout`, `/order-confirmation` | Fn `orders/checkout`, `orders/checkout/quote`, `addresses`; DAB rates | [Cart and checkout](../features/commerce/cart-and-checkout.md) |
| Order history and tracking | Store `/account`, `/order-tracking/:orderId` | DAB orders; Fn `orders/details` | [Order lifecycle](../features/commerce/order-lifecycle.md) |
| Simulated order pipeline (Pending → Approved → Shipped → Delivered) | Background | Fn SQL trigger, `sales-order-status` queue, hourly delivery timer | [Order lifecycle](../features/commerce/order-lifecycle.md) |
| Order list, detail, ship, begin processing, cancel | Admin `/orders`, `/orders/:orderId` | DAB; Fn `orders/{id}/ship`, `orders/{id}/cancel`, `orders/begin-processing-order` | [Order lifecycle](../features/commerce/order-lifecycle.md) |
| Order pipeline timing and manual promotion | Admin `/order-pipeline` | Fn `orders/pipeline/*` | [Order lifecycle](../features/commerce/order-lifecycle.md) |
| B2B store accounts and reseller orders | Admin `/stores` | Fn `stores`, `store-orders` | [Order lifecycle](../features/commerce/order-lifecycle.md) |
| PDF receipts: download, resend, generate missing | Store `/account`; Admin `/orders/:orderId` | Fn receipt queue, private blob storage | [Receipts](../features/commerce/receipts.md) |
| Returns policy and FAQ pages | Store `/returns`, `/faq` | Static content | [Storefront](../apps/storefront.md) |
| Special offers: create, assign products, translate | Admin `/promotions` | DAB; Fn `TranslatePromotion` | [Promotions](../features/promotions/promotions.md) |
| AI promotion wizard with multi-turn refinement | Admin `/promotions` | Fn `GeneratePromotion`; Foundry | [Promotions](../features/promotions/promotions.md) |
| Auto-promotion settings and order-count thresholds | Admin `/auto-promotions` | Fn `auto-promotion/*` | [Promotions](../features/promotions/promotions.md) |
| Clearance promotions from slow movers | Admin `/slow-movers` | DAB; promotions flow | [Promotions](../features/promotions/promotions.md) |
| SEO meta tags, structured data, robots.txt and sitemap | Store product/category pages, `/sitemap.xml` | Fn `sitemap.xml` | [SEO](../features/seo/seo.md) |

## Customers

| Feature | App / route | Backend | Doc |
| --- | --- | --- | --- |
| Sign up and sign in | Store `/auth` | Fn `signup`; api-mcp e-shop credentials grant | [Accounts and sign-in](../features/customers/accounts-and-sign-in.md) |
| Profile, addresses and payment methods | Store `/account` | DAB; Fn `addresses`, `payment-methods` | [Accounts and sign-in](../features/customers/accounts-and-sign-in.md) |
| Change password and reset a forgotten password | Store `/account`, `/reset-password` | Fn `password`, `password/reset/*` | [Passwords and reset](../features/customers/passwords-and-reset.md) |
| Employee sign-in with OAuth + PKCE | Admin `/login`; Mfg `/login` | api-mcp | [Accounts and sign-in](../features/customers/accounts-and-sign-in.md) |
| Customer list, detail, addresses, payment methods, password reset | Admin `/customers`, `/customers/:customerId` | DAB; Fn `person-addresses`, `addresses`, `password`, `password/reset/admin-request` | [Admin portal](../apps/admin-portal.md) |
| Customer statistics by country, region and month | Admin `/customer-stats` | Fn `customer-stats`, breakdowns | [Reporting](../features/finance/reporting.md) |
| Order confirmation email with PDF receipt | Background after checkout | Fn email queue; Azure Communication Services | [Email notifications](../features/email/email-notifications.md) |
| Shipped and delivered emails (off by default) | Background | Fn order pipeline | [Email notifications](../features/email/email-notifications.md) |
| AI-written email to one or many customers | Admin `/customers` | Fn `email/generate-ai-content`, `persons/{id}/send-email`; Foundry | [Email notifications](../features/email/email-notifications.md) |
| 23 UI languages, localized product names, currencies, imperial/metric units | Store (language and currency pickers) | DAB names, currency rates | [Localization](../features/i18n/localization.md) |
| Cultures and localized descriptions | Admin `/cultures` | DAB | [Localization](../features/i18n/localization.md) |
| Currency exchange-rate refresh | Admin `/currencies` | Fn `exchange-rates/refresh` | [Localization](../features/i18n/localization.md) |

## Content and AI

| Feature | App / route | Backend | Doc |
| --- | --- | --- | --- |
| AI shopping assistant chat for signed-in customers | Store (chat overlay) | Fn `agent/chat`; Foundry `eshop-chat-agent` + MCP | [AI chat](../features/ai/ai-chat.md) |
| AI business assistant chat | Admin `/` | Fn `agent/chat`; Foundry `admin-chat-agent` + MCP | [AI chat](../features/ai/ai-chat.md) |
| Semantic product search and suggestions | Store `/search`, header search | Fn `search/semantic`, `search/suggestions`; SQL vectors | [Semantic search](../features/search/semantic-search.md) |
| "Help me choose" product wizard | Store `/help-me-choose` | Fn `helpme/*`; Foundry + MCP | [Help me choose](../features/search/help-me-choose.md) |
| Admin product search | Admin `/search` | DAB | [Admin portal](../apps/admin-portal.md) |
| Product reviews and helpful votes | Store `/product/:productId` | DAB; Fn `reviews/{id}/vote` | [Product reviews](../features/reviews/product-reviews.md) |
| Review moderation with AI analysis and replies | Admin `/reviews` | DAB; Fn `reviews/*`; Foundry | [Product reviews](../features/reviews/product-reviews.md) |
| AI verified-purchaser review generation | Admin `/utilities`, `/product/:productId` | Fn `generate-verified-reviews/*`; Foundry | [Product reviews](../features/reviews/product-reviews.md) |
| Product management and AI product wizard | Admin `/products`, `/product/:productId` | DAB; Fn `products/generate-content` | [AI content generation](../features/ai/ai-content-generation.md) |
| AI product images | Admin `/product/:productId` | Fn `products/{id}/generate-images`; Foundry image model | [AI content generation](../features/ai/ai-content-generation.md) |
| Categories and subcategories with AI suggestions and translation | Admin `/categories`, `/category/:categoryId` | Fn category functions; Foundry | [AI content generation](../features/ai/ai-content-generation.md) |
| AI-generated customers | Admin `/customers` | Fn `customers/generate-with-ai`; MCP customer generator | [AI content generation](../features/ai/ai-content-generation.md) |
| AI product-description translation | Admin `/product/:productId` | Fn `TranslateProductDescriptions_HttpStart`; Foundry | [Localization](../features/i18n/localization.md) |
| Generate single or bulk AI orders | Admin `/generate-order` | Fn `GenerateOrderWithAI`, `GenerateOrdersBulk`; Foundry | [Shopping simulator](../features/simulators/shopping-simulator.md) |
| AI cart-recovery analysis | Admin `/stale-carts` | Fn `carts/analyze-recovery`; Foundry | [AI content generation](../features/ai/ai-content-generation.md) |
| Foundry agent catalog | All apps (behind the features above) | Foundry; api-mcp | [Foundry agents](../features/ai/foundry-agents.md) |
| MCP tool exploration | MCP Inspector; Admin `/utilities` links | api-mcp `/mcp`, DAB `/mcp` | [MCP Inspector](../apps/mcp-inspector.md) |

## Manufacturing and supply

| Feature | App / route | Backend | Doc |
| --- | --- | --- | --- |
| Production hub dashboard and KPIs | Mfg `/` | Fn `manufacturing/status`, `workforce`, `plan/catalog`; DAB | [Manufacturing overview](../features/manufacturing/manufacturing-overview.md) |
| Define: manufactured products and models, cost roll-up | Mfg `/define`, `/define/products/:id`, `/define/models` | DAB; Fn `plan/cost/{id}` | [Manufacturing overview](../features/manufacturing/manufacturing-overview.md) |
| Assembly instructions, diagrams and part sheets | Mfg `/define/models/:id/instructions`, `/define/parts/:id/instructions` | DAB; Fn `manufacturing/parts/{id}/documents` | [Manufacturing content](../features/manufacturing/manufacturing-content.md) |
| Engineer: BOM and routing editors, work-center locations | Mfg `/engineer`, `/engineer/bom/:productId`, `/engineer/routing/:productId`, `/engineer/locations` | DAB | [Manufacturing overview](../features/manufacturing/manufacturing-overview.md) |
| Plan: work orders and schedule | Mfg `/plan`, `/plan/work-orders/:id`, `/plan/schedule` | DAB; Fn `manufacturing/begin` | [Planning and feasibility](../features/manufacturing/planning-and-feasibility.md) |
| Plan: customer demand with schedule and reorder | Mfg `/plan/demand` | DAB orders; Fn `plan/feasibility`, `supply/*` | [Planning and feasibility](../features/manufacturing/planning-and-feasibility.md) |
| Planning intelligence: shortages, reorder, overstock, thin margin | Mfg `/plan/intelligence` | Fn `plan/*` | [Planning and feasibility](../features/manufacturing/planning-and-feasibility.md) |
| Execute: shortages, active operations, scrap and supplier quality | Mfg `/execute` | Fn `manufacturing/*`; DAB routings | [Production simulation](../features/manufacturing/production-simulation.md) |
| Live shop floor and workstation instructions | Mfg `/execute/shop-floor`, `/execute/work-order/:id` | DAB; Fn work-order queue | [Production simulation](../features/manufacturing/production-simulation.md) |
| Finished-good tracker | Mfg `/execute/tracker` | DAB | [Production simulation](../features/manufacturing/production-simulation.md) |
| Shop-floor workforce by shift | Mfg `/execute/workforce` | Fn `manufacturing/workforce` | [Production simulation](../features/manufacturing/production-simulation.md) |
| Supply: vendors, quotes, purchase orders, risk analysis | Mfg `/supply`, `/supply/vendors/:vendorId`, `/supply/orders/:orderId` | DAB; Fn `supply/*` | [Supply chain](../features/supply-chain/supply-chain.md) |
| Receive: inventory, reorder and build dialogs | Mfg `/receive`, `/receive/inventory/:productId` | DAB; Fn `supply/*`, `manufacturing/begin` | [Supply chain](../features/supply-chain/supply-chain.md) |
| Cost analysis and cost-versus-price history | Mfg `/receive/costing`, `/receive/costing/:productId` | DAB; Fn `plan/cost/{id}/current` | [Planning and feasibility](../features/manufacturing/planning-and-feasibility.md) |
| Warehouse dashboard, live floor, workforce and configuration | Mfg `/warehouse`, `/warehouse/floor`, `/warehouse/workforce`, `/warehouse/config` | Fn `warehouse/*` | [Warehouse operations](../features/warehouse/warehouse-operations.md) |
| Warehouse monitor and inventory transactions | Admin `/warehouse`, `/inventory-transactions` | Fn `warehouse/*`; DAB | [Warehouse operations](../features/warehouse/warehouse-operations.md) |
| Manufacturing AI agent: modes, auto-shutoff, queue, proposals, activity | Mfg `/manufacturing-agent` | Fn `manufacturing/agent-*`, `proposals/*`; hosted agent + MCP | [Manufacturing agent](../features/manufacturing/manufacturing-agent.md) |

## Simulators and finance

| Feature | App / route | Backend | Doc |
| --- | --- | --- | --- |
| AI shopping simulator (1–72 h, auto-stop) | Admin `/shopping-simulator` | Fn `shopping-simulator/*`, timer, queue; Foundry order agent | [Shopping simulator](../features/simulators/shopping-simulator.md) |
| Manufacturing and supply-chain simulation controls | Mfg `/settings` | Fn `manufacturing/stop`, `supply/initialize`, `supply/config`, `scrap-config`, `location-config` | [Simulator controls](../features/simulators/simulator-controls.md) |
| Finance manager: bank balance, transactions, spend | Mfg `/plan/finance` | Fn `bank/*`, `financials/*` | [Bank simulator](../features/finance/bank-simulator.md) |
| Dashboard KPIs and recent orders | Admin `/` | Fn `reporting/dashboard-counts`; DAB | [Reporting](../features/finance/reporting.md) |
| Sales, category, territory and inventory reports | Admin `/reports` | Fn `reporting/*` | [Reporting](../features/finance/reporting.md) |
| Product profitability, loss makers and slow movers | Admin `/product-profitability`, `/loss-makers`, `/slow-movers` | Fn `reporting/*`; DAB price updates | [Reporting](../features/finance/reporting.md) |

## Platform

| Feature | App / route | Backend | Doc |
| --- | --- | --- | --- |
| Live updates in all apps, with "live updates unavailable" notice | All apps | Fn `webpubsub/negotiate`; Web PubSub | [Real-time eventing](../architecture/realtime-eventing.md) |
| Health diagnostics and seed status | Store `/health` | Fn `health`, `health/readiness`, `seed/status`; api-mcp `/ready` | [Health diagnostics](../features/monitoring/HEALTH_DIAGNOSTICS.md) |
| Utilities hub with MCP Inspector links | Admin `/utilities` | — | [Admin portal](../apps/admin-portal.md) |
| OpenAPI document and Swagger UI for Functions | Fn `/api/openapi.json`, `/api/swagger/ui` | Fn | [Azure Functions](../services/functions.md) |
| Telemetry and distributed tracing | All apps and services | Application Insights | [Monitoring](../operations/monitoring.md) |
