# AdventureWorks Functions API — Complete Route-to-Scope Authorization Matrix

> This document is the human-readable **source of truth** for authorizing the
> `api-functions` HTTP surface as an OAuth-protected resource, mirroring the MCP
> [`TOOL_SCOPE_MATRIX.md`](../mcp-oauth/TOOL_SCOPE_MATRIX.md). It reuses the same
> business-domain scopes ([`OAuthScopes.cs`](../../../api-mcp/AdventureWorks/Auth/OAuthScopes.cs))
> and the same authorization server in `api-mcp`. It classifies **every** one of the
> **187** HTTP-triggered routes discovered in `api-functions` — no route is left
> unclassified. Non-HTTP triggers (queue / SQL / timer) are internal and not part of
> this matrix.

**Status:** Phase A (inventory & classification). This is the design artifact that
later phases enforce (resource-server middleware in `api-functions`, per-route policy,
frontend token attachment, tests). No runtime behavior changes with this document.

## How to read this matrix

| Column | Meaning |
| ------ | ------- |
| **Method / route** | The HTTP method(s) and `/api/...` route template as declared by the Functions `HttpTrigger`. |
| **Tier** | `Anonymous` (no token), `Consumer` (token + record ownership), `Internal-only` (token + non-consumer category), or `Anonymous — v1 descope` (see below). |
| **Required scope** | The single business-domain OAuth scope the access token must carry (in addition to a valid resource-bound token). `—` = none (anonymous). |
| **Access mode** | `Anonymous` = reachable with no token. `Self-or-internal (ownership)` = consumers may act only on their own records (server-resolved owner id), internal roles unrestricted. `Internal-only` = requires the scope **and** a non-consumer category (defense-in-depth). |
| **Ownership key** | For ownership-checked routes, the identifier validated/overwritten server-side against the caller's resolved owner id. A client-supplied value can never widen access. |

## Summary

| Tier | Access | Count |
| ---- | ------ | ----- |
| **P** | Anonymous | 18 |
| **C** | Consumer (ownership) | 9 |
| **I** | Internal-only | 116 |
| **M** | Anonymous — v1 descope (MCP-proxied) | 44 |
| | **Total** | **187** |

### Routes per required scope (protected routes only)

| Required scope | Route count | In existing catalog? |
| -------------- | ----------- | -------------------- |
| `admin.write` | 39 | yes |
| `sales.read` | 20 | yes |
| `admin.read` | 19 | yes |
| `manufacturing.read` | 15 | yes |
| `manufacturing.write` | 15 | yes |
| `orders.write` | 6 | yes |
| `orders.read` | 5 | yes |
| `customers.read` | 3 | yes |
| `customers.write` | 3 | **new — added by this work** |

> The only scope not already in the shared catalog is **`customers.write`**, required
> for consumer self-service address writes (and internal customer mutations). All other
> routes map onto the existing 12-scope catalog already used by MCP and DAB.

## Tier M — the v1 descope (documented limitation)

`api-mcp` proxies a subset of these endpoints over HTTP (machine-to-machine) to back its
manufacturing, supply-chain, bank and simulator MCP tools
(`ManufacturingService`, `SupplyChainService`, `BankService`, `SimulatorService`). Those
outbound calls currently carry **no** `Authorization` header, and the authorization server
supports only `authorization_code` + PKCE (no client-credentials / token-exchange grant),
so `api-mcp` cannot yet obtain a Functions-audience token on its own behalf.

**Decision (v1):** the exact (method, route) pairs reachable through those four proxy
services — **44** endpoints — remain `Anonymous` for now, so the MCP tools keep
working. They are still protected *at the MCP layer* (the MCP tools that call them require
`manufacturing.*` / `sales.read` / `admin.write` / `mcp.admin` scopes and are `Internal-only`).
A later phase protects them directly by making `api-mcp` a confidential client that mints a
down-scoped Functions token (RFC 8693 token exchange or client-credentials). Until then this
is an **accepted, documented limitation** — note it includes some mutating endpoints
(`manufacturing/begin`, `manufacturing/stop`, `supply/order`, `bank/deposit`, `bank/withdraw`,
config PUTs, `simulators/reset`).

## Matrix by functional area

### Platform & discovery (public) (6)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/health` | P | — | Anonymous | — |
| `GET /api/openapi.json` | P | — | Anonymous | — |
| `GET /api/seed/status` | P | — | Anonymous | — |
| `GET /api/sitemap.xml` | P | — | Anonymous | — |
| `GET /api/swagger/ui` | P | — | Anonymous | — |
| `GET /api/webpubsub/negotiate` | P | — | Anonymous | — |

### Catalog search (public) (5)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/helpme/catalog-meta` | P | — | Anonymous | — |
| `POST /api/helpme/questions` | P | — | Anonymous | — |
| `POST /api/helpme/recommend` | P | — | Anonymous | — |
| `POST /api/search/semantic` | P | — | Anonymous | — |
| `GET /api/search/suggestions` | P | — | Anonymous | — |

### AI assistant (public pass-through) (2)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/agent/chat` | P | — | Anonymous | — |
| `GET /api/agent/status` | P | — | Anonymous | — |

### Authentication (pre-auth, public) (5)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/password` | P | — | Anonymous | — |
| `POST /api/password/reset/complete` | P | — | Anonymous | — |
| `POST /api/password/reset/request` | P | — | Anonymous | — |
| `POST /api/password/reset/validate` | P | — | Anonymous | — |
| `POST /api/password/verify` | P | — | Anonymous | — |

### Addresses (consumer) (6)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/addresses` | C | `customers.read` | Self-or-internal (ownership) | businessEntityId |
| `POST /api/addresses` | C | `customers.write` | Self-or-internal (ownership) | businessEntityId |
| `GET /api/addresses/{id:int}` | C | `customers.read` | Self-or-internal (ownership) | businessEntityId |
| `PUT /api/addresses/{id:int}` | C | `customers.write` | Self-or-internal (ownership) | businessEntityId |
| `DELETE /api/addresses/{id:int}` | C | `customers.write` | Self-or-internal (ownership) | businessEntityId |
| `GET /api/person-addresses` | C | `customers.read` | Self-or-internal (ownership) | businessEntityId |

### Receipts (5)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/GenerateOrderReceipts_HttpStart` | I | `admin.write` | Internal-only | — |
| `POST /api/orders/generate-and-send-receipt` | C | `orders.read` | Self-or-internal (ownership) | salesOrderId(owner CustomerID) |
| `POST /api/orders/generate-missing-receipts` | I | `admin.write` | Internal-only | — |
| `GET /api/orders/{salesOrderId:int}/receipt` | C | `orders.read` | Self-or-internal (ownership) | salesOrderId(owner CustomerID) |
| `GET /api/orders/{salesOrderId:int}/receipt-status` | C | `orders.read` | Self-or-internal (ownership) | salesOrderId(owner CustomerID) |

### Reporting & analytics (14)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/reporting/dashboard-counts` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/discount-impact` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/inventory-by-category` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/monthly-trend` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/orders-by-status` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/product-price-history` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/product-profitability` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/product-profitability-detail` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/profitability-by-category` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/revenue-by-category` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/revenue-by-territory` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/sales-trends` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/slow-movers` | I | `sales.read` | Internal-only | — |
| `GET /api/reporting/top-products` | I | `sales.read` | Internal-only | — |

### Customer analytics (5)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/customer-country-breakdown` | I | `sales.read` | Internal-only | — |
| `GET /api/customer-monthly-revenue` | I | `sales.read` | Internal-only | — |
| `GET /api/customer-region-breakdown` | I | `sales.read` | Internal-only | — |
| `GET /api/customer-stats` | I | `sales.read` | Internal-only | — |
| `GET /api/customers/top-spenders` | I | `sales.read` | Internal-only | — |

### B2B store (8)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/orders/{orderId:int}/lines` | I | `admin.read` | Internal-only | — |
| `GET /api/product-catalog` | I | `admin.read` | Internal-only | — |
| `POST /api/store-orders` | I | `admin.write` | Internal-only | — |
| `GET /api/store-products` | I | `admin.read` | Internal-only | — |
| `GET /api/store-territories` | I | `admin.read` | Internal-only | — |
| `GET /api/stores` | I | `admin.read` | Internal-only | — |
| `GET /api/stores/{storeId:int}` | I | `admin.read` | Internal-only | — |
| `GET /api/stores/{storeId:int}/orders` | I | `admin.read` | Internal-only | — |

### Order lifecycle (8)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/orders/begin-processing-order` | I | `orders.write` | Internal-only | — |
| `GET /api/orders/delivery/trigger` | I | `orders.write` | Internal-only | — |
| `GET /api/orders/pipeline/config` | I | `orders.read` | Internal-only | — |
| `PUT /api/orders/pipeline/config` | I | `orders.write` | Internal-only | — |
| `POST /api/orders/pipeline/promote-approved` | I | `orders.write` | Internal-only | — |
| `POST /api/orders/pipeline/promote-pending` | I | `orders.write` | Internal-only | — |
| `GET /api/orders/pipeline/status` | I | `orders.read` | Internal-only | — |
| `POST /api/orders/{salesOrderId:int}/ship` | I | `orders.write` | Internal-only | — |

### Promotions (3)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/auto-promotion/config` | I | `admin.read` | Internal-only | — |
| `PUT /api/auto-promotion/config` | I | `admin.write` | Internal-only | — |
| `POST /api/auto-promotion/reset-counters` | I | `admin.write` | Internal-only | — |

### Reviews (9)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/generate-verified-reviews/start` | I | `admin.write` | Internal-only | — |
| `GET /api/generate-verified-reviews/status` | I | `admin.read` | Internal-only | — |
| `GET /api/generate-verified-reviews/summary` | I | `admin.read` | Internal-only | — |
| `GET /api/products/{productId}/customers-with-delivered-orders` | I | `admin.read` | Internal-only | — |
| `GET /api/products/{productId}/eligible-reviewer-count` | I | `admin.read` | Internal-only | — |
| `POST /api/products/{productId}/generate-reviews-with-replies` | I | `admin.write` | Internal-only | — |
| `POST /api/reviews/analyze-batch` | I | `admin.write` | Internal-only | — |
| `POST /api/reviews/moderation/start-analyze-approve-all` | I | `admin.write` | Internal-only | — |
| `GET /api/reviews/moderation/status` | I | `admin.read` | Internal-only | — |

### Cart recovery (1)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/carts/analyze-recovery` | I | `admin.read` | Internal-only | — |

### AI content & data generation (11)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/GenerateOrderWithAI` | I | `admin.write` | Internal-only | — |
| `POST /api/GenerateOrdersBulk` | I | `admin.write` | Internal-only | — |
| `POST /api/GenerateProductEmbeddings_HttpStart` | I | `admin.write` | Internal-only | — |
| `POST /api/GenerateProductImages_HttpStart` | I | `admin.write` | Internal-only | — |
| `POST /api/GenerateProductNameEmbeddings` | I | `admin.write` | Internal-only | — |
| `POST /api/GenerateProductReviewEmbeddings_HttpStart` | I | `admin.write` | Internal-only | — |
| `POST /api/GenerateProductReviewsUsingAI_HttpStart` | I | `admin.write` | Internal-only | — |
| `POST /api/GeneratePromotion` | I | `admin.write` | Internal-only | — |
| `POST /api/customers/generate-with-ai` | I | `admin.write` | Internal-only | — |
| `POST /api/products/generate-content` | I | `admin.write` | Internal-only | — |
| `POST /api/products/{productId}/generate-images` | I | `admin.write` | Internal-only | — |

### Localization & catalog admin (12)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/CreateCategory` | I | `admin.write` | Internal-only | — |
| `POST /api/CreateSubcategory` | I | `admin.write` | Internal-only | — |
| `POST /api/DeleteCategory` | I | `admin.write` | Internal-only | — |
| `POST /api/DeleteSubcategory` | I | `admin.write` | Internal-only | — |
| `POST /api/GenerateCategoryWithAI` | I | `admin.write` | Internal-only | — |
| `POST /api/GetSubcategoryProductCount` | I | `admin.read` | Internal-only | — |
| `POST /api/TranslateCategoryName` | I | `admin.write` | Internal-only | — |
| `POST /api/TranslateLanguageFile_HttpStart` | I | `admin.write` | Internal-only | — |
| `GET /api/TranslateLanguageFile_Status` | I | `admin.read` | Internal-only | — |
| `POST/GET /api/TranslateLanguageFile_Terminate` | I | `admin.write` | Internal-only | — |
| `POST /api/TranslateProductDescriptions_HttpStart` | I | `admin.write` | Internal-only | — |
| `POST /api/TranslatePromotion` | I | `admin.write` | Internal-only | — |

### Email & comms (3)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/customers/{customerId:int}/send-email` | I | `admin.write` | Internal-only | — |
| `POST /api/email/generate-ai-content` | I | `admin.write` | Internal-only | — |
| `POST /api/persons/{personId:int}/send-email` | I | `admin.write` | Internal-only | — |

### Ops & maintenance (3)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/ai-job-queue/status` | I | `admin.read` | Internal-only | — |
| `GET /api/archive/trigger` | I | `admin.write` | Internal-only | — |
| `POST /api/exchange-rates/refresh` | I | `admin.write` | Internal-only | — |

### Simulators (7)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/shopping-simulator/clear-queue` | I | `admin.write` | Internal-only | — |
| `GET /api/shopping-simulator/results` | I | `admin.read` | Internal-only | — |
| `POST /api/shopping-simulator/start` | I | `admin.write` | Internal-only | — |
| `GET /api/shopping-simulator/status` | I | `admin.read` | Internal-only | — |
| `POST /api/shopping-simulator/stop` | I | `admin.write` | Internal-only | — |
| `POST /api/simulation/orders/start` | I | `admin.write` | Internal-only | — |
| `POST /api/simulators/reset` | M | — | Anonymous (v1 — MCP-proxied) | — |

### Warehouse (13)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/warehouse/active` | I | `manufacturing.read` | Internal-only | — |
| `GET /api/warehouse/damage-config` | I | `manufacturing.read` | Internal-only | — |
| `PUT /api/warehouse/damage-config/{operationType}` | I | `manufacturing.write` | Internal-only | — |
| `GET /api/warehouse/damage-events` | I | `manufacturing.read` | Internal-only | — |
| `POST /api/warehouse/initialize` | I | `manufacturing.write` | Internal-only | — |
| `GET /api/warehouse/metrics` | I | `manufacturing.read` | Internal-only | — |
| `GET /api/warehouse/status` | I | `manufacturing.read` | Internal-only | — |
| `GET /api/warehouse/subcategory-config` | I | `manufacturing.read` | Internal-only | — |
| `PUT /api/warehouse/subcategory-config/{id}` | I | `manufacturing.write` | Internal-only | — |
| `GET /api/warehouse/supplier-receive-config` | I | `manufacturing.read` | Internal-only | — |
| `PUT /api/warehouse/supplier-receive-config/{id}` | I | `manufacturing.write` | Internal-only | — |
| `GET /api/warehouse/workforce` | I | `manufacturing.read` | Internal-only | — |
| `GET /api/warehouse/workforce/detail` | I | `manufacturing.read` | Internal-only | — |

### Manufacturing agent & proposals (13)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/manufacturing/agent-config` | I | `manufacturing.read` | Internal-only | — |
| `PUT /api/manufacturing/agent-config` | I | `manufacturing.write` | Internal-only | — |
| `DELETE /api/manufacturing/agent-queue` | I | `manufacturing.write` | Internal-only | — |
| `GET /api/manufacturing/agent-queue-status` | I | `manufacturing.read` | Internal-only | — |
| `DELETE /api/manufacturing/agent-queue/poison` | I | `manufacturing.write` | Internal-only | — |
| `GET /api/manufacturing/agent-runs` | I | `manufacturing.read` | Internal-only | — |
| `POST /api/manufacturing/agent-runs/{id}/step` | I | `manufacturing.write` | Internal-only | — |
| `GET /api/manufacturing/proposals` | I | `manufacturing.read` | Internal-only | — |
| `POST /api/manufacturing/proposals` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `POST /api/manufacturing/proposals/approve-all` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/manufacturing/proposals/reject-all` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/manufacturing/proposals/{id}/approve` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/manufacturing/proposals/{id}/reject` | I | `manufacturing.write` | Internal-only | — |

### Manufacturing control (13)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/manufacturing/active` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `POST /api/manufacturing/begin` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/manufacturing/location-config` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `PUT /api/manufacturing/location-config/{locationId:int}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/manufacturing/scrap-config` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `PUT /api/manufacturing/scrap-config/{locationId:int}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/manufacturing/scrap-events` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/manufacturing/status` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `POST /api/manufacturing/stop` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/manufacturing/vendor-quality` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/manufacturing/vendor-quality/{vendorId:int}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/manufacturing/workforce` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/manufacturing/workforce/detail` | I | `manufacturing.read` | Internal-only | — |

### Manufacturing planning (9)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/plan/catalog` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/plan/cost/{productId:int}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/plan/cost/{productId:int}/current` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/plan/feasibility` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/plan/feasibility/{productId:int}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/plan/overstock` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/plan/reorder-recommendations` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/plan/shortage-forecast` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/plan/thin-margin` | M | — | Anonymous (v1 — MCP-proxied) | — |

### Supply chain (15)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/supply/catalog` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/supply/catalog/{productId:int}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/supply/config` | I | `manufacturing.read` | Internal-only | — |
| `PUT /api/supply/config` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/supply/initialize` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/supply/order` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/supply/order/{orderId}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `DELETE /api/supply/order/{orderId}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/supply/orders` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/supply/orders/history` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/supply/quote` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `POST /api/supply/reorder-all` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/supply/restock/{vendorId}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/supply/vendors` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/supply/vendors/{vendorId}` | M | — | Anonymous (v1 — MCP-proxied) | — |

### Bank & financials (11)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/bank/accounts` | I | `sales.read` | Internal-only | — |
| `GET /api/bank/accounts/{currencyCode}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/bank/currencies` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `POST /api/bank/deposit` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/bank/status` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/bank/transactions` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/bank/transactions/{currencyCode}` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `POST /api/bank/withdraw` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/financials/manufacturing` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/financials/procurement` | M | — | Anonymous (v1 — MCP-proxied) | — |
| `GET /api/financials/summary` | M | — | Anonymous (v1 — MCP-proxied) | — |

