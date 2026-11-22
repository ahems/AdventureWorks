---
title: Azure Functions route and trigger reference
summary: Complete catalog of the 238 Azure Functions in api-functions, with trigger, HTTP method and route, authorization tier, OAuth scope, Web PubSub push events and behaviour notes, grouped by feature area.
audience: [developer, operator, security-reviewer, ai-agent]
components: [api-functions]
related:
  - docs/services/functions.md
  - docs/features/functions-oauth/ROUTE_SCOPE_MATRIX.md
  - docs/reference/webpubsub-events.md
  - docs/reference/storage-resources.md
---

# Azure Functions route and trigger reference (all 238 functions)

This page lists every function in the `api-functions` Flex Consumption app: what triggers it, the HTTP route or trigger source, the OAuth tier and scope enforced by the Functions middleware, and the Web PubSub events it pushes.

**How this page was derived.** The rows were generated from the current source tree, not written by hand:

- Function names, triggers, HTTP methods, routes, queue names, timer schedules and SQL tables come from the `[Function]`, `[HttpTrigger]`, `[QueueTrigger]`, `[TimerTrigger]`, `[SqlTrigger]`, `[OrchestrationTrigger]` and `[ActivityTrigger]` attributes in `api-functions/Functions/*.cs` (queue-name constants resolved to their values).
- Tier, scope and ownership notes come from `api-functions/Auth/FunctionAuthorizationRegistry.cs`.
- The **Web PubSub push** and **Notes** columns were checked by hand against the `WebPubSubService.SendToGroupAsync` / `SendCoalescedAsync` call sites and `NotifyingTableClient` users in `api-functions/Services/`.
- The result was cross-checked against the per-route authorization matrix in [ROUTE_SCOPE_MATRIX.md](../features/functions-oauth/ROUTE_SCOPE_MATRIX.md).

If you add, rename or re-route a function, update this page and the route matrix. The registry itself is checked by `api-functions.Tests/FunctionAuthorizationRegistryTests.cs`, which fails if an HTTP function has no registry entry.

## Totals

| Trigger type | Count |
|---|---|
| HTTP | 205 |
| Durable activity | 6 |
| Queue | 16 |
| Timer | 7 |
| Durable orchestrator | 2 |
| SQL trigger | 2 |
| **Total** | **238** |

| HTTP authorization tier | Count | Meaning |
|---|---|---|
| Public | 20 | No token required: guest cart, sign-up, password reset, semantic search and Help Me Choose, AI chat entry points, health, OpenAPI, sitemap and seed status. Some of these routes apply their own checks when a token is present. |
| Authenticated | 1 | Any valid Functions-audience token (`/api/webpubsub/negotiate`, which also requires `realtime.connect`). |
| Consumer | 20 | Signed-in shopper; the registry adds an ownership check on the customer or business-entity identifier. |
| Internal | 164 | Employee or manufacturing category plus the listed scope. |

| Scope (HTTP functions) | Count |
|---|---|
| `manufacturing.read` | 43 |
| `admin.write` | 42 |
| `manufacturing.write` | 27 |
| `sales.read` | 23 |
| `admin.read` | 19 |
| `orders.write` | 9 |
| `orders.read` | 7 |
| `customers.read` | 5 |
| `customers.write` | 9 |
| `realtime.connect` | 1 |

Non-HTTP triggers have no tier or scope: they run inside the Functions host with the runtime managed identity. 40 of the internal HTTP routes are also reached by api-mcp tools through its Functions proxy (see [api-mcp](../services/api-mcp.md)).

## Legend

- **Method and route / source**: for HTTP, the method(s) and the full path including the `/api` prefix. Routes shown as `/api/<FunctionName>` use the default route (no `Route` set). For other triggers: queue name, timer CRON (six-field, seconds first, UTC), SQL table, or the Durable function type.
- **Web PubSub push**: `group:event`. Every event in the `orders` group is sent on the wire as `{"event":"orders-changed"}` and every event in the `finance` group as `{"event":"finance-changed"}`; the original event name is shown for traceability. `*` marks a conditional push. `state-changed` events come from `NotifyingTableClient` and are coalesced in a 5-second window. See [Web PubSub events](webpubsub-events.md).
- **Notes**: ownership checks, default routes and other behaviour worth knowing. Every HTTP `GET` is a pure read; see [GET routes are read-only](../services/functions.md#get-routes-are-read-only).

## Functions by feature area

### Orders and checkout

Source files: `CheckoutFunctions.cs`, `OrderDetailFunctions.cs`, `StoreOrderFunctions.cs`, `GenerateOrderWithAIFunction.cs`, `GenerateOrdersBulkFunction.cs`. 13 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `PlaceCheckoutOrder` | HTTP | POST `/api/orders/checkout` | Consumer | `orders.write` | — | Ownership: customerId + businessEntityId (signed consumer); both addresses linked to the person. Server-priced; header and lines in one SQL transaction. `OrderPlacedSqlTrigger` sends the order events. |
| `QuoteCheckout` | HTTP | POST `/api/orders/checkout/quote` | Consumer | `orders.read` | — | Same ownership checks; read-only server price and discount-code check |
| `GetOwnedOrderDetails` | HTTP | GET `/api/orders/details` | Consumer | `orders.read` | — | Ownership: orderIds(owner CustomerID) |
| `GetStores` | HTTP | GET `/api/stores` | Internal | `admin.read` | — | — |
| `GetStoreById` | HTTP | GET `/api/stores/{storeId:int}` | Internal | `admin.read` | — | — |
| `GetStoreOrders` | HTTP | GET `/api/stores/{storeId:int}/orders` | Internal | `admin.read` | — | — |
| `PlaceStoreOrder` | HTTP | POST `/api/store-orders` | Internal | `admin.write` | orders:order-placed | — |
| `GetStoreProducts` | HTTP | GET `/api/store-products` | Internal | `admin.read` | — | — |
| `GetOrderLines` | HTTP | GET `/api/orders/{orderId:int}/lines` | Internal | `admin.read` | — | — |
| `GetProductCatalog` | HTTP | GET `/api/product-catalog` | Internal | `admin.read` | — | — |
| `GetStoreTerritories` | HTTP | GET `/api/store-territories` | Internal | `admin.read` | — | — |
| `GenerateOrderWithAI` | HTTP | POST `/api/GenerateOrderWithAI` | Internal | `admin.write` | — | Default route (function name) |
| `GenerateOrdersBulk` | HTTP | POST `/api/GenerateOrdersBulk` | Internal | `admin.write` | — | Default route (function name) |

### Order pipeline, status processing and delivery

Source files: `OrderPlacedSqlTrigger.cs`, `ProcessSalesOrderStatus.cs`, `OrderStatusFunctions.cs`, `OrderPipelineControlFunction.cs`, `OrderDeliveryTimerFunction.cs`, `OrderCancelFunctions.cs`. 12 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `OrderPlacedSqlTrigger` | SQL trigger | `[Sales].[SalesOrderHeader]` | — | — | orders:database-changed; orders:order-placed; manufacturing-agent:run-created*; manufacturing-agent:state-changed (run table)*; promotions:state-changed (counter) | — |
| `ProcessSalesOrderStatus_QueueTrigger` | Queue | `sales-order-status` | — | — | orders:order-status-changed; finance:transaction (bank credit on ship) | — |
| `BeginProcessingOrder` | HTTP | POST `/api/orders/begin-processing-order` | Internal | `orders.write` | — | — |
| `ShipOrder` | HTTP | POST `/api/orders/{salesOrderId:int}/ship` | Internal | `orders.write` | — | — |
| `CancelOrder` | HTTP | POST `/api/orders/{salesOrderId:int}/cancel` | Internal | `orders.write` | orders:order-status-changed | Only Status 1, 2 or 3; 409 otherwise |
| `OrderPipeline_GetConfig` | HTTP | GET `/api/orders/pipeline/config` | Internal | `orders.read` | — | — |
| `OrderPipeline_PutConfig` | HTTP | PUT `/api/orders/pipeline/config` | Internal | `orders.write` | orders:state-changed (sanitized) | — |
| `OrderPipeline_GetStatus` | HTTP | GET `/api/orders/pipeline/status` | Internal | `orders.read` | — | — |
| `OrderPipeline_PromotePending` | HTTP | POST `/api/orders/pipeline/promote-pending` | Internal | `orders.write` | — | — |
| `OrderPipeline_PromoteApproved` | HTTP | POST `/api/orders/pipeline/promote-approved` | Internal | `orders.write` | — | — |
| `OrderDelivery_Timer` | Timer | `0 0 * * * *` | — | — | — | — |
| `OrderDelivery_HttpTrigger` | HTTP | POST `/api/orders/delivery/trigger` | Internal | `orders.write` | orders:orders-delivered | Promotes Status 5→7, sends delivered emails (flag-gated), pushes orders event |

### Carts and cart recovery

Source files: `OwnedCartFunctions.cs`, `CartRecoveryAnalysisFunction.cs`. 6 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `GuestCartSession` | HTTP | POST,DELETE `/api/cart/session` | Public | — | — | — |
| `OwnedCartItems` | HTTP | GET,POST,DELETE `/api/cart/items` | Public | — | — | — |
| `OwnedCartItem` | HTTP | PATCH,DELETE `/api/cart/items/{id:int}` | Public | — | — | — |
| `MergeGuestCart` | HTTP | POST `/api/cart/merge` | Consumer | `orders.write` | — | Ownership: consumer + guest session |
| `CleanupExpiredGuestCarts` | Timer | `0 */10 * * * *` | — | — | — | — |
| `AnalyzeCartRecovery` | HTTP | POST `/api/carts/analyze-recovery` | Internal | `admin.read` | — | — |

### Customers, addresses, passwords and payment methods

Source files: `AddressFunctions.cs`, `PasswordFunctions.cs`, `PasswordResetFunctions.cs`, `PaymentMethodFunctions.cs`, `GenerateCustomerWithAIFunction.cs`. 16 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `GetPersonAddresses` | HTTP | GET `/api/person-addresses` | Consumer | `customers.read` | — | Ownership: businessEntityId |
| `GetAddresses` | HTTP | GET `/api/addresses` | Consumer | `customers.read` | — | Ownership: businessEntityId |
| `GetAddressById` | HTTP | GET `/api/addresses/{id:int}` | Consumer | `customers.read` | — | Ownership: businessEntityId |
| `CreateAddress` | HTTP | POST `/api/addresses` | Consumer | `customers.write` | — | Ownership: businessEntityId |
| `UpdateAddress` | HTTP | PUT `/api/addresses/{id:int}` | Consumer | `customers.write` | — | Ownership: businessEntityId |
| `SetAddressType` | HTTP | PUT `/api/addresses/{id:int}/type` | Consumer | `customers.write` | — | Ownership: businessEntityId |
| `DeleteAddress` | HTTP | DELETE `/api/addresses/{id:int}` | Consumer | `customers.write` | — | Ownership: businessEntityId |
| `Signup` | HTTP | POST `/api/signup` | Public | — | — | — |
| `SetPassword` | HTTP | POST `/api/password` | Consumer | `customers.write` | — | Ownership: businessEntityID(self; internal → customers only) |
| `VerifyPassword` | HTTP | POST `/api/password/verify` | Consumer | `customers.read` | — | Ownership: businessEntityID(self only) |
| `RequestPasswordReset` | HTTP | POST `/api/password/reset/request` | Public | — | — | — |
| `AdminRequestPasswordReset` | HTTP | POST `/api/password/reset/admin-request` | Internal | `customers.write` | — | Staff reset email; reports not-eligible (409) instead of the generic anonymous 202 |
| `ValidateResetToken` | HTTP | POST `/api/password/reset/validate` | Public | — | — | — |
| `ResetPassword` | HTTP | POST `/api/password/reset/complete` | Public | — | — | — |
| `GetPaymentMethods` | HTTP | GET `/api/payment-methods` | Consumer | `customers.read` | — | Ownership: business_entity_id(self) |
| `CreatePaymentMethod` | HTTP | POST `/api/payment-methods` | Consumer | `customers.write` | — | Ownership: business_entity_id(self); masked test cards only |
| `GenerateCustomerWithAI` | HTTP | POST `/api/customers/generate-with-ai` | Internal | `admin.write` | — | — |

### Receipts and email

Source files: `ReceiptCheckFunction.cs`, `GenerateAndSendReceiptFunction.cs`, `GenerateOrderReceipts.cs`, `GenerateMissingReceiptsFunction.cs`, `SendEmailFunction.cs`, `SendPersonEmailFunction.cs`, `GenerateEmailContentFunction.cs`. 10 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `CheckOrderReceipt` | HTTP | GET `/api/orders/{salesOrderId:int}/receipt-status` | Consumer | `orders.read` | — | Ownership: salesOrderId(owner CustomerID) |
| `DownloadOrderReceipt` | HTTP | GET `/api/orders/{salesOrderId:int}/receipt` | Consumer | `orders.read` | — | Ownership: salesOrderId(owner CustomerID) |
| `GenerateAndSendReceipt` | HTTP | POST `/api/orders/generate-and-send-receipt` | Consumer | `orders.read` | — | Ownership: salesOrderId(owner CustomerID) |
| `SendOrderEmail_QueueTrigger` | Queue | `order-email-generation` | — | — | — | — |
| `GenerateOrderReceipts_HttpStart` | HTTP | POST `/api/GenerateOrderReceipts_HttpStart` | Internal | `admin.write` | — | Default route (function name) |
| `GenerateOrderReceipts_QueueTrigger` | Queue | `order-receipt-generation` | — | — | — | — |
| `GenerateMissingReceipts` | HTTP | POST `/api/orders/generate-missing-receipts` | Internal | `admin.write` | — | — |
| `SendCustomerEmail` | HTTP | POST `/api/customers/{customerId:int}/send-email` | Internal | `admin.write` | — | — |
| `SendPersonEmail` | HTTP | POST `/api/persons/{personId:int}/send-email` | Internal | `admin.write` | — | — |
| `GenerateEmailContent` | HTTP | POST `/api/email/generate-ai-content` | Internal | `admin.write` | — | — |

### Product reviews

Source files: `GenerateProductReviewsUsingAI.cs`, `GenerateReviewsWithRepliesFunction.cs`, `GenerateVerifiedReviewsFunction.cs`, `ReviewAnalysisFunction.cs`, `ReviewModerationQueueFunction.cs`, `ReviewJobWatchdog.cs`, `ReviewVoteFunctions.cs`. 14 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `GenerateProductReviewsUsingAI_HttpStart` | HTTP | POST `/api/GenerateProductReviewsUsingAI_HttpStart` | Internal | `admin.write` | — | Default route (function name) |
| `GenerateReviewsWithReplies` | HTTP | POST `/api/products/{productId}/generate-reviews-with-replies` | Internal | `admin.write` | — | — |
| `GetVerifiedReviewsSummary` | HTTP | GET `/api/generate-verified-reviews/summary` | Internal | `admin.read` | — | — |
| `StartBatchVerifiedReviews` | HTTP | POST `/api/generate-verified-reviews/start` | Internal | `admin.write` | reviews:generation-state-changed (svc) | Enqueues one `verified-reviews-queue` message per product; may replace a stale job |
| `GetVerifiedReviewsStatus` | HTTP | GET `/api/generate-verified-reviews/status` | Internal | `admin.read` | — | Pure read; reports computed `isStale` (>10 min idle) |
| `GetCustomersWithDeliveredOrders` | HTTP | GET `/api/products/{productId}/customers-with-delivered-orders` | Internal | `admin.read` | — | — |
| `GetProductEligibleReviewerCount` | HTTP | GET `/api/products/{productId}/eligible-reviewer-count` | Internal | `admin.read` | reviews:generation-progress | — |
| `AnalyzeReviewsBatch` | HTTP | POST `/api/reviews/analyze-batch` | Internal | `admin.write` | — | — |
| `ReviewModeration_StartAnalyzeApproveAll` | HTTP | POST `/api/reviews/moderation/start-analyze-approve-all` | Internal | `admin.write` | reviews:moderation-state-changed (svc) | — |
| `ReviewModeration_Status` | HTTP | GET `/api/reviews/moderation/status` | Internal | `admin.read` | — | — |
| `VerifiedReviews_QueueTrigger` | Queue | `verified-reviews-queue` | — | — | reviews:generation-progress; reviews:generation-state-changed (svc) | Idempotent per job and product |
| `ReviewModeration_QueueTrigger` | Queue | `review-moderation-queue` | — | — | reviews:moderation-progress; reviews:moderation-state-changed (svc) | — |
| `ExpireAbandonedReviewJobs` | Timer | `0 * * * * *` | — | — | reviews:<terminal event> (svc) | — |
| `VoteReviewHelpful` | HTTP | POST `/api/reviews/{productReviewId:int}/vote` | Consumer | `customers.write` | reviews:review-votes-changed (only when the count changed) | Voter is the signed business_entity_id; one `Production.ProductReviewVote` row per voter and review; count change in the same SQL transaction; repeat votes return 200 unchanged; own review 403 |
| `RemoveReviewHelpfulVote` | HTTP | DELETE `/api/reviews/{productReviewId:int}/vote` | Consumer | `customers.write` | reviews:review-votes-changed (only when the count changed) | Removes only the signed voter's vote row and decrements the count in the same transaction |

### Search, embeddings and AI job queues

Source files: `SemanticSearchFunction.cs`, `SearchSuggestionsFunction.cs`, `GenerateProductEmbeddings.cs`, `GenerateProductNameEmbeddings.cs`, `GenerateProductReviewEmbeddings.cs`, `AIJobProcessorFunction.cs`. 21 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `SemanticSearch` | HTTP | POST `/api/search/semantic` | Public | — | — | — |
| `GetSearchSuggestions` | HTTP | GET `/api/search/suggestions` | Public | — | — | — |
| `GenerateProductEmbeddings_HttpStart` | HTTP | POST `/api/GenerateProductEmbeddings_HttpStart` | Internal | `admin.write` | — | Default route (function name) |
| `GenerateProductNameEmbeddings_HttpStart` | HTTP | POST `/api/GenerateProductNameEmbeddings` | Internal | `admin.write` | — | — |
| `GenerateProductNameEmbeddings_Orchestrator` | Durable orchestrator | — | — | — | utilities:utility-status-changed via RegisterUtilityLifecycle (push-v1 only) | — |
| `FetchProductNamesActivity` | Durable activity | — | — | — | — | — |
| `GenerateNameEmbeddingsActivity` | Durable activity | — | — | — | — | — |
| `SaveNameEmbeddingsActivity` | Durable activity | — | — | — | — | — |
| `GenerateProductReviewEmbeddings_HttpStart` | HTTP | POST `/api/GenerateProductReviewEmbeddings_HttpStart` | Internal | `admin.write` | — | Default route (function name) |
| `AIJobProcessor_Image_QueueTrigger` | Queue | `ai-job-image-queue` | — | — | — | — |
| `AIJobProcessor_Embeddings_QueueTrigger` | Queue | `ai-job-embeddings-queue` | — | — | — | — |
| `AIJobProcessor_Chat_QueueTrigger` | Queue | `ai-job-chat-queue` | — | — | — | — |
| `AIJobQueue_Status` | HTTP | GET `/api/ai-job-queue/status` | Internal | `admin.read` | — | — |

### Product content, images, categories and translation

Source files: `GenerateProductContentFunction.cs`, `GenerateProductImages.cs`, `GenerateProductThumbnails.cs`, `TranslateCategoryNames.cs`, `TranslateProductDescriptions.cs`, `TranslateLanguageFile.cs`. 24 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `GenerateProductContent` | HTTP | POST `/api/products/generate-content` | Internal | `admin.write` | — | — |
| `GenerateProductImages_HttpStart` | HTTP | POST `/api/GenerateProductImages_HttpStart` | Internal | `admin.write` | — | Default route (function name) |
| `GenerateProductImages_SingleProduct` | HTTP | POST `/api/products/{productId}/generate-images` | Internal | `admin.write` | — | — |
| `GenerateProductThumbnails_QueueTrigger` | Queue | `product-thumbnail-generation` | — | — | — | — |
| `TranslateCategoryName` | HTTP | POST `/api/TranslateCategoryName` | Internal | `admin.write` | — | Default route (function name) |
| `CreateCategory` | HTTP | POST `/api/CreateCategory` | Internal | `admin.write` | — | Default route (function name) |
| `CreateSubcategory` | HTTP | POST `/api/CreateSubcategory` | Internal | `admin.write` | — | Default route (function name) |
| `GetSubcategoryProductCount` | HTTP | POST `/api/GetSubcategoryProductCount` | Internal | `admin.read` | — | Default route (function name) |
| `DeleteCategory` | HTTP | POST `/api/DeleteCategory` | Internal | `admin.write` | — | Default route (function name) |
| `DeleteSubcategory` | HTTP | POST `/api/DeleteSubcategory` | Internal | `admin.write` | — | Default route (function name) |
| `GenerateCategoryWithAI` | HTTP | POST `/api/GenerateCategoryWithAI` | Internal | `admin.write` | — | Default route (function name) |
| `TranslateProductDescriptions_HttpStart` | HTTP | POST `/api/TranslateProductDescriptions_HttpStart` | Internal | `admin.write` | — | Default route (function name) |
| `TranslateLanguageFile_HttpStart` | HTTP | POST `/api/TranslateLanguageFile_HttpStart` | Internal | `admin.write` | — | Default route (function name) |
| `TranslateLanguageFile_Status` | HTTP | GET `/api/TranslateLanguageFile_Status` | Internal | `admin.read` | — | Default route (function name) |
| `TranslateLanguageFile_Terminate` | HTTP | POST `/api/TranslateLanguageFile_Terminate` | Internal | `admin.write` | — | Terminates a Durable instance (`?instanceId=`); Default route (function name) |
| `TranslateLanguageFile_Orchestrator` | Durable orchestrator | — | — | — | utilities:utility-status-changed via RegisterUtilityLifecycle (push-v1 only) | — |
| `TranslateSectionActivity` | Durable activity | — | — | — | — | — |
| `SaveTranslationResultActivity` | Durable activity | — | — | — | — | — |

### Promotions and auto-promotions

Source files: `GeneratePromotionFunction.cs`, `TranslatePromotionDescriptions.cs`, `AutoPromotionControlFunction.cs`, `AutoPromotionQueueTrigger.cs`. 6 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `GeneratePromotion` | HTTP | POST `/api/GeneratePromotion` | Internal | `admin.write` | — | Default route (function name) |
| `TranslatePromotion` | HTTP | POST `/api/TranslatePromotion` | Internal | `admin.write` | — | Default route (function name) |
| `AutoPromotion_GetConfig` | HTTP | GET `/api/auto-promotion/config` | Internal | `admin.read` | — | — |
| `AutoPromotion_UpdateConfig` | HTTP | PUT `/api/auto-promotion/config` | Internal | `admin.write` | promotions:state-changed (table) | — |
| `AutoPromotion_ResetCounters` | HTTP | POST `/api/auto-promotion/reset-counters` | Internal | `admin.write` | promotions:state-changed (table) | — |
| `AutoPromotion_QueueTrigger` | Queue | `auto-promotion-queue` | — | — | promotions:auto-promotion-created | — |

### Exchange rates

Source files: `UpdateExchangeRatesFunction.cs`. 1 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `RefreshExchangeRates` | HTTP | POST `/api/exchange-rates/refresh` | Internal | `admin.write` | — | — |

### Reporting and analytics

Source files: `ReportingFunctions.cs`, `FinancialReportingFunction.cs`, `CustomerStatsFunction.cs`, `GetTopSpendersFunction.cs`. 22 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `ReportRevenueByCategoryReport` | HTTP | GET `/api/reporting/revenue-by-category` | Internal | `sales.read` | — | — |
| `ReportMonthlyTrend` | HTTP | GET `/api/reporting/monthly-trend` | Internal | `sales.read` | — | — |
| `ReportTopProducts` | HTTP | GET `/api/reporting/top-products` | Internal | `sales.read` | — | — |
| `ReportOrdersByStatus` | HTTP | GET `/api/reporting/orders-by-status` | Internal | `sales.read` | — | — |
| `ReportRevenueByTerritory` | HTTP | GET `/api/reporting/revenue-by-territory` | Internal | `sales.read` | — | — |
| `ReportInventoryByCategory` | HTTP | GET `/api/reporting/inventory-by-category` | Internal | `sales.read` | — | — |
| `ReportDashboardCounts` | HTTP | GET `/api/reporting/dashboard-counts` | Internal | `sales.read` | — | — |
| `ReportProductProfitability` | HTTP | GET `/api/reporting/product-profitability` | Internal | `sales.read` | — | — |
| `ReportProductProfitabilityDetail` | HTTP | GET `/api/reporting/product-profitability-detail` | Internal | `sales.read` | — | — |
| `ReportProfitabilityByCategory` | HTTP | GET `/api/reporting/profitability-by-category` | Internal | `sales.read` | — | — |
| `ReportDiscountImpact` | HTTP | GET `/api/reporting/discount-impact` | Internal | `sales.read` | — | — |
| `ReportSlowMovers` | HTTP | GET `/api/reporting/slow-movers` | Internal | `sales.read` | — | — |
| `ReportSalesTrends` | HTTP | GET `/api/reporting/sales-trends` | Internal | `sales.read` | — | — |
| `ReportProductPriceHistory` | HTTP | GET `/api/reporting/product-price-history` | Internal | `sales.read` | — | — |
| `FinancialSummary` | HTTP | GET `/api/financials/summary` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `FinancialProcurement` | HTTP | GET `/api/financials/procurement` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `FinancialManufacturing` | HTTP | GET `/api/financials/manufacturing` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `GetCustomerStats` | HTTP | GET `/api/customer-stats` | Internal | `sales.read` | — | — |
| `GetCustomerCountryBreakdown` | HTTP | GET `/api/customer-country-breakdown` | Internal | `sales.read` | — | — |
| `GetCustomerRegionBreakdown` | HTTP | GET `/api/customer-region-breakdown` | Internal | `sales.read` | — | — |
| `GetCustomerMonthlyRevenue` | HTTP | GET `/api/customer-monthly-revenue` | Internal | `sales.read` | — | — |
| `GetTopSpenders` | HTTP | GET `/api/customers/top-spenders` | Internal | `sales.read` | — | — |

### Shopping simulator

Source files: `ShoppingSimulatorControlFunction.cs`, `ShoppingSimulatorTimerFunction.cs`, `SimulationOrderQueueTrigger.cs`. 8 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `ShoppingSimulator_Status` | HTTP | GET `/api/shopping-simulator/status` | Internal | `admin.read` | — | — |
| `ShoppingSimulator_Start` | HTTP | POST `/api/shopping-simulator/start` | Internal | `admin.write` | shopping-simulator:simulator-started | — |
| `ShoppingSimulator_Stop` | HTTP | POST `/api/shopping-simulator/stop` | Internal | `admin.write` | shopping-simulator:simulator-stopped | — |
| `ShoppingSimulator_Results` | HTTP | GET `/api/shopping-simulator/results` | Internal | `admin.read` | — | — |
| `ShoppingSimulator_ClearQueue` | HTTP | POST `/api/shopping-simulator/clear-queue` | Internal | `admin.write` | shopping-simulator:queue-cleared (svc) | — |
| `ShoppingSimulator_Timer` | Timer | `0 * * * * *` | — | — | shopping-simulator:state-changed (table) | — |
| `SimulationOrder_QueueTrigger` | Queue | `simulation-order-queue` | — | — | shopping-simulator:state-changed (table) | — |
| `SimulationOrder_HttpStart` | HTTP | POST `/api/simulation/orders/start` | Internal | `admin.write` | — | — |

### Manufacturing simulation and planning

Source files: `ManufacturingControlFunction.cs`, `ManufacturingPlanningFunction.cs`, `WorkOrderOperationProcessorFunction.cs`, `SimulationMaintenanceFunction.cs`. 23 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `ManufacturingBegin` | HTTP | POST `/api/manufacturing/begin` | Internal | `manufacturing.write` | — | Also called by api-mcp (MCP tool proxy) |
| `ManufacturingStop` | HTTP | POST `/api/manufacturing/stop` | Internal | `manufacturing.write` | manufacturing-ops:simulation-stopped | Also called by api-mcp (MCP tool proxy) |
| `ManufacturingStatus` | HTTP | GET `/api/manufacturing/status` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `GetScrapConfig` | HTTP | GET `/api/manufacturing/scrap-config` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PutScrapConfig` | HTTP | PUT `/api/manufacturing/scrap-config/{locationId:int}` | Internal | `manufacturing.write` | manufacturing-ops:config-changed | Also called by api-mcp (MCP tool proxy) |
| `GetLocationConfig` | HTTP | GET `/api/manufacturing/location-config` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PutLocationConfig` | HTTP | PUT `/api/manufacturing/location-config/{locationId:int}` | Internal | `manufacturing.write` | manufacturing-ops:config-changed | Also called by api-mcp (MCP tool proxy) |
| `ManufacturingWorkforce` | HTTP | GET `/api/manufacturing/workforce` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `ManufacturingWorkforceDetail` | HTTP | GET `/api/manufacturing/workforce/detail` | Internal | `manufacturing.read` | — | Read-only; seeded by `SimulationMaintenance_Timer` |
| `ManufacturingGetScrapEvents` | HTTP | GET `/api/manufacturing/scrap-events` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `ManufacturingGetVendorQuality` | HTTP | GET `/api/manufacturing/vendor-quality` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `ManufacturingGetVendorQualityById` | HTTP | GET `/api/manufacturing/vendor-quality/{vendorId:int}` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PlanFeasibility` | HTTP | GET `/api/plan/feasibility/{productId:int}` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PlanFeasibilityAll` | HTTP | GET `/api/plan/feasibility` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PlanCostAnalysis` | HTTP | GET `/api/plan/cost/{productId:int}` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PlanCurrentManufacturingCost` | HTTP | GET `/api/plan/cost/{productId:int}/current` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PlanCatalog` | HTTP | GET `/api/plan/catalog` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PlanOverstock` | HTTP | GET `/api/plan/overstock` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PlanThinMargin` | HTTP | GET `/api/plan/thin-margin` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PlanShortageForeceast` | HTTP | GET `/api/plan/shortage-forecast` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `PlanReorderRecommendations` | HTTP | GET `/api/plan/reorder-recommendations` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `WorkOrderOperationProcessor` | Queue | `production-wo-queue` | — | — | manufacturing-ops:shortage-updated; manufacturing-ops:routing-updated; manufacturing-ops:scrap-event; manufacturing-ops:wo-completed; warehouse:inventory-updated; manufacturing-ops:state-changed (table) | — |
| `SimulationMaintenance_Timer` | Timer | `0 * * * * *` (also on startup) | — | — | manufacturing-agent, manufacturing-ops, warehouse, supply-chain, finance (table writes) | Idempotently seeds bank, warehouse, workforce and supply-chain state; persists the agent auto-shutoff; rejects expired or over-cap proposals; prunes shortages for deleted work orders. Keeps those GET routes read-only |

### Manufacturing agent and proposals

Source files: `ManufacturingAgentConfigFunctions.cs`, `ManufacturingAgentRunFunctions.cs`, `ManufacturingAgentQueueTrigger.cs`, `ManufacturingProposalFunctions.cs`. 14 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `GetManufacturingAgentConfig` | HTTP | GET `/api/manufacturing/agent-config` | Internal | `manufacturing.read` | — | Read-only: reports Mode=Off once AutoShutoffAt has passed; `SimulationMaintenance_Timer` persists it |
| `PutManufacturingAgentConfig` | HTTP | PUT `/api/manufacturing/agent-config` | Internal | `manufacturing.write` | manufacturing-agent:config-changed; manufacturing-agent:state-changed (table) | — |
| `GetManufacturingAgentRuns` | HTTP | GET `/api/manufacturing/agent-runs` | Internal | `manufacturing.read` | — | — |
| `PostManufacturingAgentStep` | HTTP | POST `/api/manufacturing/agent-runs/{id}/step` | Internal | `manufacturing.write` | manufacturing-agent:step-updated; manufacturing-agent:state-changed (run table) | — |
| `GetManufacturingAgentQueueStatus` | HTTP | GET `/api/manufacturing/agent-queue-status` | Internal | `manufacturing.read` | — | — |
| `ClearManufacturingAgentQueue` | HTTP | DELETE `/api/manufacturing/agent-queue` | Internal | `manufacturing.write` | manufacturing-agent:queue-cleared | — |
| `ClearManufacturingAgentPoisonQueue` | HTTP | DELETE `/api/manufacturing/agent-queue/poison` | Internal | `manufacturing.write` | manufacturing-agent:poison-queue-cleared | — |
| `ManufacturingAgentQueue_QueueTrigger` | Queue | `manufacturing-agent-queue` | — | — | manufacturing-agent:run-started; manufacturing-agent:run-completed; manufacturing-agent:state-changed (run table) | — |
| `GetManufacturingProposals` | HTTP | GET `/api/manufacturing/proposals` | Internal | `manufacturing.read` | — | — |
| `RejectAllManufacturingProposals` | HTTP | POST `/api/manufacturing/proposals/reject-all` | Internal | `manufacturing.write` | manufacturing-agent:state-changed (proposal table) | — |
| `ApproveAllManufacturingProposals` | HTTP | POST `/api/manufacturing/proposals/approve-all` | Internal | `manufacturing.write` | manufacturing-agent:state-changed (proposal table) | — |
| `CreateManufacturingProposal` | HTTP | POST `/api/manufacturing/proposals` | Internal | `manufacturing.write` | manufacturing-agent:state-changed (proposal table) | Also called by api-mcp (MCP tool proxy) |
| `ApproveManufacturingProposal` | HTTP | POST `/api/manufacturing/proposals/{id}/approve` | Internal | `manufacturing.write` | manufacturing-agent:state-changed (proposal table) | — |
| `RejectManufacturingProposal` | HTTP | POST `/api/manufacturing/proposals/{id}/reject` | Internal | `manufacturing.write` | manufacturing-agent:state-changed (proposal table) | — |

### Manufacturing content

Source files: `GenerateManufacturingInstructions.cs`, `GenerateManufacturingDiagram.cs`, `GenerateManufacturingPartSheet.cs`, `GenerateManufacturingPartDiagram.cs`, `GetManufacturingPartDocuments.cs`, `ExportManufacturingIllustrations.cs`. 6 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `GenerateManufacturingInstructions` | HTTP | POST `/api/manufacturing/content/instructions/generate` | Internal | `manufacturing.write` | — | — |
| `GenerateManufacturingDiagram` | HTTP | POST `/api/manufacturing/content/diagrams/generate` | Internal | `manufacturing.write` | — | — |
| `GenerateManufacturingPartSheet` | HTTP | POST `/api/manufacturing/content/parts/instructions/generate` | Internal | `manufacturing.write` | — | — |
| `GenerateManufacturingPartDiagram` | HTTP | POST `/api/manufacturing/content/parts/diagrams/generate` | Internal | `manufacturing.write` | — | — |
| `GetManufacturingPartDocuments` | HTTP | GET `/api/manufacturing/parts/{productId:int}/documents` | Internal | `manufacturing.read` | — | — |
| `ExportManufacturingIllustrations` | HTTP | GET,POST `/api/manufacturing/illustrations/export` | Internal | `manufacturing.read` | — | — |

### Warehouse

Source files: `WarehouseFunction.cs`, `WarehouseOperationProcessorFunction.cs`. 14 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `WarehouseInitialize` | HTTP | POST `/api/warehouse/initialize` | Internal | `manufacturing.write` | — | — |
| `WarehouseStatus` | HTTP | GET `/api/warehouse/status` | Internal | `manufacturing.read` | — | Read-only; seeded by `SimulationMaintenance_Timer` |
| `WarehouseActiveOperations` | HTTP | GET `/api/warehouse/active` | Internal | `manufacturing.read` | — | — |
| `WarehouseWorkforce` | HTTP | GET `/api/warehouse/workforce` | Internal | `manufacturing.read` | — | Read-only; seeded by `SimulationMaintenance_Timer` |
| `WarehouseWorkforceDetail` | HTTP | GET `/api/warehouse/workforce/detail` | Internal | `manufacturing.read` | — | — |
| `WarehouseMetrics` | HTTP | GET `/api/warehouse/metrics` | Internal | `manufacturing.read` | — | — |
| `WarehouseDamageEvents` | HTTP | GET `/api/warehouse/damage-events` | Internal | `manufacturing.read` | — | — |
| `WarehouseGetSubcategoryConfig` | HTTP | GET `/api/warehouse/subcategory-config` | Internal | `manufacturing.read` | — | Read-only; seeded by `SimulationMaintenance_Timer` |
| `WarehouseUpdateSubcategoryConfig` | HTTP | PUT `/api/warehouse/subcategory-config/{id}` | Internal | `manufacturing.write` | warehouse:config-changed | — |
| `WarehouseGetSupplierReceiveConfig` | HTTP | GET `/api/warehouse/supplier-receive-config` | Internal | `manufacturing.read` | — | Read-only; seeded by `SimulationMaintenance_Timer` |
| `WarehouseUpdateSupplierReceiveConfig` | HTTP | PUT `/api/warehouse/supplier-receive-config/{id}` | Internal | `manufacturing.write` | — | — |
| `WarehouseGetDamageConfig` | HTTP | GET `/api/warehouse/damage-config` | Internal | `manufacturing.read` | — | Read-only; seeded by `SimulationMaintenance_Timer` |
| `WarehouseUpdateDamageConfig` | HTTP | PUT `/api/warehouse/damage-config/{operationType}` | Internal | `manufacturing.write` | — | — |
| `WarehouseOperationProcessor` | Queue | `warehouse-ops-queue` | — | — | warehouse:operation-completed; warehouse:state-changed (table) | — |

### Supply chain and purchase orders

Source files: `SupplyChainControlFunction.cs`, `PurchaseOrderProcessorFunction.cs`. 13 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `SupplyChainGetVendors` | HTTP | GET `/api/supply/vendors` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `SupplyChainGetVendor` | HTTP | GET `/api/supply/vendors/{vendorId}` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `SupplyChainGetCatalog` | HTTP | GET `/api/supply/catalog` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `SupplyChainGetCatalogByProduct` | HTTP | GET `/api/supply/catalog/{productId:int}` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `SupplyChainGetQuote` | HTTP | GET `/api/supply/quote` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `SupplyChainPlaceOrder` | HTTP | POST `/api/supply/order` | Internal | `manufacturing.write` | supply-chain:po-created | Also called by api-mcp (MCP tool proxy) |
| `SupplyChainCancelOrder` | HTTP | DELETE `/api/supply/order/{orderId}` | Internal | `manufacturing.write` | — | Also called by api-mcp (MCP tool proxy) |
| `SupplyChainInitialize` | HTTP | POST `/api/supply/initialize` | Internal | `manufacturing.write` | — | — |
| `SupplyChainRestock` | HTTP | POST `/api/supply/restock/{vendorId}` | Internal | `manufacturing.write` | — | Also called by api-mcp (MCP tool proxy) |
| `SupplyChainGetConfig` | HTTP | GET `/api/supply/config` | Internal | `manufacturing.read` | — | — |
| `SupplyChainPutConfig` | HTTP | PUT `/api/supply/config` | Internal | `manufacturing.write` | — | — |
| `SupplyChainReorderAll` | HTTP | POST `/api/supply/reorder-all` | Internal | `manufacturing.write` | supply-chain:po-created | — |
| `PurchaseOrderProcessor` | Queue | `supply-chain-orders-queue` | — | — | supply-chain:po-status-changed; supply-chain:state-changed (table); finance:transaction | — |

### Bank simulator, simulator reset and transaction archive

Source files: `BankControlFunction.cs`, `SimulatorControlFunction.cs`, `TransactionHistoryArchiveFunction.cs`. 11 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `BankGetStatus` | HTTP | GET `/api/bank/status` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `BankGetAccounts` | HTTP | GET `/api/bank/accounts` | Internal | `sales.read` | — | Read-only; seeded by `SimulationMaintenance_Timer` |
| `BankGetAccount` | HTTP | GET `/api/bank/accounts/{currencyCode}` | Internal | `sales.read` | — | Also called by api-mcp (MCP tool proxy) |
| `BankGetTransactions` | HTTP | GET `/api/bank/transactions` | Internal | `manufacturing.read` | — | Also called by api-mcp (MCP tool proxy) |
| `BankGetTransactionsByCurrency` | HTTP | GET `/api/bank/transactions/{currencyCode}` | Internal | `sales.read` | — | Also called by api-mcp (MCP tool proxy) |
| `BankDeposit` | HTTP | POST `/api/bank/deposit` | Internal | `admin.write` | finance:state-changed / transaction (service) | Also called by api-mcp (MCP tool proxy) |
| `BankWithdraw` | HTTP | POST `/api/bank/withdraw` | Internal | `admin.write` | finance:state-changed / transaction (service) | Also called by api-mcp (MCP tool proxy) |
| `BankGetCurrencies` | HTTP | GET `/api/bank/currencies` | Internal | `sales.read` | — | Also called by api-mcp (MCP tool proxy) |
| `SimulatorsReset` | HTTP | POST `/api/simulators/reset` | Internal | `admin.write` | supply-chain/finance/shopping-simulator:state-changed (svc resets) | Also called by api-mcp (MCP tool proxy) |
| `ArchiveTransactionHistoryTimer` | Timer | `0 0 2 * * 0` | — | — | — | — |
| `ArchiveTransactionHistoryHttp` | HTTP | POST `/api/archive/trigger` | Internal | `admin.write` | — | INSERTs TransactionHistory >1 yr into archive and DELETEs originals |

### Help Me Choose and AI chat

Source files: `HelpMeChooseFunctions.cs`, `AIAgentFunctions.cs`. 5 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `HelpMeChooseQuestions` | HTTP | POST `/api/helpme/questions` | Public | — | — | — |
| `HelpMeChooseRecommend` | HTTP | POST `/api/helpme/recommend` | Public | — | — | — |
| `HelpMeChooseCatalogMeta` | HTTP | GET `/api/helpme/catalog-meta` | Public | — | — | — |
| `AIAgentChat` | HTTP | POST `/api/agent/chat` | Public | — | — | — |
| `AIAgentStatus` | HTTP | GET `/api/agent/status` | Public | — | — | — |

### Platform: health, OpenAPI, sitemap, seed status and real-time

Source files: `HealthCheckFunction.cs`, `OpenApiFunction.cs`, `SitemapFunction.cs`, `SeedJobStatusFunction.cs`, `WebPubSubNegotiateFunction.cs`, `DatabaseChangeNotifications.cs`, `UtilityLifecycleNotifications.cs`. 11 functions.

| Function | Trigger | Method and route / source | Tier | Scope | Web PubSub push | Notes |
|---|---|---|---|---|---|---|
| `HealthCheck` | HTTP | GET `/api/health` | Public | — | — | — |
| `DependencyReadiness` | HTTP | GET `/api/health/readiness` | Public | — | — | — |
| `GetOpenApiSpec` | HTTP | GET `/api/openapi.json` | Public | — | — | — |
| `GetSwaggerUI` | HTTP | GET `/api/swagger/ui` | Public | — | — | — |
| `GetSitemap` | HTTP | GET `/api/sitemap.xml` | Public | — | — | — |
| `SeedJobStatus` | HTTP | GET `/api/seed/status` | Public | — | — | — |
| `NegotiateWebPubSub` | HTTP | GET `/api/webpubsub/negotiate` | Authenticated | `realtime.connect` | — | — |
| `DatabaseChanges` | SQL trigger | `[dbo].[RealtimeNotificationOutbox]` | — | — | mapped groups:database-changed (coalesced per entity) | — |
| `CleanupDatabaseNotifications` | Timer | `0 0 3 * * *` | — | — | — | — |
| `RegisterUtilityLifecycle` | Durable activity | — | — | — | utilities:utility-status-changed | — |
| `ObserveUtilityLifecycle` | Queue | `utility-status-queue` | — | — | utilities:utility-status-changed | — |
