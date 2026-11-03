# AdventureWorks Functions API — Complete Route-to-Scope Authorization Matrix

> This document is the human-readable **source of truth** for authorizing the
> `api-functions` HTTP surface as an OAuth-protected resource, mirroring the MCP
> [`TOOL_SCOPE_MATRIX.md`](../mcp-oauth/TOOL_SCOPE_MATRIX.md). It reuses the same
> business-domain scopes ([`OAuthScopes.cs`](../../../api-mcp/AdventureWorks/Auth/OAuthScopes.cs))
> and the same authorization server in `api-mcp`. It classifies **every** one of the
> **187** HTTP-triggered routes discovered in `api-functions` — no route is left
> unclassified. Non-HTTP triggers (queue / SQL / timer) are internal and not part of
> this matrix.

**Status:** Enforced. The registry in
[`FunctionAuthorizationRegistry.cs`](../../../api-functions/Auth/FunctionAuthorizationRegistry.cs)
implements this matrix and `FUNCTIONS_OAUTH_MODE=enforced` is deployed: only Tier P routes are
reachable without a valid Functions-audience token.

## How to read this matrix

| Column | Meaning |
| ------ | ------- |
| **Method / route** | The HTTP method(s) and `/api/...` route template as declared by the Functions `HttpTrigger`. |
| **Tier** | `Anonymous` (no token), `Consumer` (token + record ownership), or `Internal-only` (token + non-consumer category). Rows marked *MCP-proxied* are also called by api-mcp with its service token (see below). |
| **Required scope** | The single business-domain OAuth scope the access token must carry (in addition to a valid resource-bound token). `—` = none (anonymous). |
| **Access mode** | `Anonymous` = reachable with no token. `Self-or-internal (ownership)` = consumers may act only on their own records (server-resolved owner id), internal roles unrestricted. `Internal-only` = requires the scope **and** a non-consumer category (defense-in-depth). |
| **Ownership key** | For ownership-checked routes, the identifier validated/overwritten server-side against the caller's resolved owner id. A client-supplied value can never widen access. |

## Summary

| Tier | Access | Count |
| ---- | ------ | ----- |
| **P** | Anonymous | 18 |
| **C** | Consumer (ownership) | 12 |
| **I** | Internal-only (40 of them also MCP-proxied) | 157 |
| | **Total** | **187** |

### Routes per required scope (protected routes only)

| Required scope | Route count | In existing catalog? |
| -------------- | ----------- | -------------------- |
| `admin.write` | 42 | yes |
| `manufacturing.read` | 42 | yes |
| `sales.read` | 23 | yes |
| `manufacturing.write` | 23 | yes |
| `admin.read` | 19 | yes |
| `orders.write` | 6 | yes |
| `customers.write` | 5 | **new — added by this work** |
| `orders.read` | 5 | yes |
| `customers.read` | 4 | yes |

> The only scope not already in the shared catalog is **`customers.write`**, required
> for consumer self-service address writes (and internal customer mutations). All other
> routes map onto the existing 12-scope catalog already used by MCP and DAB.

## MCP-proxied routes — api-mcp service token

`api-mcp` proxies 40 of these endpoints over HTTP to back its manufacturing, supply-chain,
bank and simulator MCP tools (`ManufacturingService`, `SupplyChainService`, `BankService`,
`SimulatorService`). These routes were previously left anonymous (the former "Tier M" descope).
They are now ordinary **Internal-only** routes:

- Each outbound call from api-mcp carries a short-lived (5 min) **service token** minted
  in-process by [`FunctionsServiceTokenHandler`](../../../api-mcp/AdventureWorks/Auth/FunctionsServiceTokenHandler.cs),
  signed with the authorization server's own key: `iss` = the shared issuer,
  `aud` = `{issuer}/functions`, `category=service`, `sub=service:api-mcp`. It carries only the
  scopes the proxied routes need (`manufacturing.*`, `inventory.read`, `sales.read`, `admin.*`)
  and an audit-only `obo_sub` with the MCP caller's subject.
- The MCP tool itself still enforces the **end user's** scope first (e.g. `begin_manufacturing`
  requires `manufacturing.write`), so the service token never widens what a user can do.
- Browsers can reach the same routes only with their own per-user Functions token, so e.g.
  the manufacturing portal (manufacturing-engineer) can drive manufacturing but not the bank.

SQL-only active-operation and purchase-order read Functions have been removed.
The Manufacturing site reads these through OAuth-authenticated DAB REST calls;
MCP tools use native Managed Identity SQL reads, matching the other MCP data tools.
These reads are no longer part of the Functions authorization surface.

## Matrix by functional area

### Platform & discovery (public) (7)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/health` | P | — | Anonymous | — |
| `GET /api/health/readiness` | P | — | Anonymous | — |
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

### Authentication (6)

Sign-in itself happens at the api-mcp authorization server (`/login`), never against these
routes. Only the pre-auth reset flow and consumer signup are anonymous.

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/signup` | P | — | Anonymous | — |
| `POST /api/password/reset/complete` | P | — | Anonymous | — |
| `POST /api/password/reset/request` | P | — | Anonymous | — |
| `POST /api/password/reset/validate` | P | — | Anonymous | — |
| `POST /api/password` | C | `customers.write` | Self-or-internal (ownership); staff may reset **customer** (`IN`) passwords only | businessEntityID |
| `POST /api/password/verify` | C | `customers.read` | Self only (no password oracle) | businessEntityID |

### Addresses (consumer) (7)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/addresses` | C | `customers.read` | Self-or-internal (ownership) | businessEntityId |
| `POST /api/addresses` | C | `customers.write` | Self-or-internal (ownership) | businessEntityId |
| `GET /api/addresses/{id:int}` | C | `customers.read` | Self-or-internal (ownership) | businessEntityId |
| `PUT /api/addresses/{id:int}` | C | `customers.write` | Self-or-internal (ownership) | businessEntityId |
| `PUT /api/addresses/{id:int}/type` | C | `customers.write` | Self-or-internal (ownership) | businessEntityId |
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
| `GET, POST /api/manufacturing/illustrations/export` | I | `manufacturing.read` | Internal-only | — |
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
| `POST /api/simulators/reset` | I | `admin.write` | Internal-only (MCP-proxied) | — |

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
| `POST /api/manufacturing/proposals` | I | `manufacturing.write` | Internal-only (MCP-proxied) | — |
| `POST /api/manufacturing/proposals/approve-all` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/manufacturing/proposals/reject-all` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/manufacturing/proposals/{id}/approve` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/manufacturing/proposals/{id}/reject` | I | `manufacturing.write` | Internal-only | — |

### Manufacturing control (12)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `POST /api/manufacturing/begin` | I | `manufacturing.write` | Internal-only (MCP-proxied) | — |
| `GET /api/manufacturing/location-config` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `PUT /api/manufacturing/location-config/{locationId:int}` | I | `manufacturing.write` | Internal-only (MCP-proxied) | — |
| `GET /api/manufacturing/scrap-config` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `PUT /api/manufacturing/scrap-config/{locationId:int}` | I | `manufacturing.write` | Internal-only (MCP-proxied) | — |
| `GET /api/manufacturing/scrap-events` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/manufacturing/status` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `POST /api/manufacturing/stop` | I | `manufacturing.write` | Internal-only (MCP-proxied) | — |
| `GET /api/manufacturing/vendor-quality` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/manufacturing/vendor-quality/{vendorId:int}` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/manufacturing/workforce` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/manufacturing/workforce/detail` | I | `manufacturing.read` | Internal-only | — |

### Manufacturing planning (9)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/plan/catalog` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/plan/cost/{productId:int}` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/plan/cost/{productId:int}/current` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/plan/feasibility` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/plan/feasibility/{productId:int}` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/plan/overstock` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/plan/reorder-recommendations` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/plan/shortage-forecast` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/plan/thin-margin` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |

### Supply chain (12)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/supply/catalog` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/supply/catalog/{productId:int}` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/supply/config` | I | `manufacturing.read` | Internal-only | — |
| `PUT /api/supply/config` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/supply/initialize` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/supply/order` | I | `manufacturing.write` | Internal-only (MCP-proxied) | — |
| `DELETE /api/supply/order/{orderId}` | I | `manufacturing.write` | Internal-only (MCP-proxied) | — |
| `GET /api/supply/quote` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `POST /api/supply/reorder-all` | I | `manufacturing.write` | Internal-only | — |
| `POST /api/supply/restock/{vendorId}` | I | `manufacturing.write` | Internal-only (MCP-proxied) | — |
| `GET /api/supply/vendors` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/supply/vendors/{vendorId}` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |

### Bank & financials (11)

| Method / route | Tier | Required scope | Access mode | Ownership key |
| -------------- | ---- | -------------- | ----------- | ------------- |
| `GET /api/bank/accounts` | I | `sales.read` | Internal-only | — |
| `GET /api/bank/accounts/{currencyCode}` | I | `sales.read` | Internal-only (MCP-proxied) | — |
| `GET /api/bank/currencies` | I | `sales.read` | Internal-only (MCP-proxied) | — |
| `POST /api/bank/deposit` | I | `admin.write` | Internal-only (MCP-proxied) | — |
| `GET /api/bank/status` | I | `manufacturing.read` | Internal-only (MCP-proxied; manufacturing Finance page) | — |
| `GET /api/bank/transactions` | I | `manufacturing.read` | Internal-only (MCP-proxied; manufacturing Finance page) | — |
| `GET /api/bank/transactions/{currencyCode}` | I | `sales.read` | Internal-only (MCP-proxied) | — |
| `POST /api/bank/withdraw` | I | `admin.write` | Internal-only (MCP-proxied) | — |
| `GET /api/financials/manufacturing` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/financials/procurement` | I | `manufacturing.read` | Internal-only (MCP-proxied) | — |
| `GET /api/financials/summary` | I | `manufacturing.read` | Internal-only (MCP-proxied; manufacturing Finance page) | — |
