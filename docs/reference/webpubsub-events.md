---
title: Web PubSub real-time events reference (groups, events, producers, consumers)
summary: Every Azure Web PubSub group and event that api-functions pushes to the storefront, admin and manufacturing apps, with the producing function, payload fields, required scopes and the SQL outbox entity-to-group map.
audience: [developer, security-reviewer, ai-agent]
components: [api-functions, app, app-admin, app-manufacturing, seed-job]
related:
  - docs/architecture/realtime-eventing.md
  - docs/reference/functions-routes.md
  - docs/reference/storage-resources.md
  - docs/services/functions.md
---

# Web PubSub real-time events reference: groups, events, producers and consumers

All real-time push in AdventureWorks goes through one Azure Web PubSub hub, `adventureworks`. Only Azure Functions publishes; the three frontends subscribe and refresh their data when an event arrives. For the design and the no-polling rules, see [Real-time eventing](../architecture/realtime-eventing.md).

**How this page was derived.** From the source tree:

- Groups and their required scopes: `GroupPolicies` in `api-functions/Services/WebPubSubService.cs`.
- Events and payloads: every `SendToGroupAsync` and `SendCoalescedAsync` call in `api-functions/Functions/` and `api-functions/Services/`, plus the `NotifyingTableClient` users in `api-functions/Services/`.
- Outbox map: the entity map in `api-functions/Functions/DatabaseChangeNotifications.cs`.
- Consumers: `GROUPS` and the query-key maps in `app/src/hooks/useRealTimeUpdates.ts`, `app-admin/src/hooks/useRealTimeUpdates.ts` and `app-manufacturing/src/hooks/useRealTimeUpdates.ts`.

## How events are sent

| Mechanism | Event name | Notes |
|---|---|---|
| `WebPubSubService.SendToGroupAsync(group, payload)` | Domain events below | Fire-and-forget: a failure is logged as a warning and never fails the caller. |
| `WebPubSubService.SendCoalescedAsync(group, key, payload)` | Events marked *coalesced* | The first event is sent at once; later events with the same key within 5 seconds collapse into one trailing send with the latest payload. |
| `NotifyingTableClient` | `state-changed` `{entity, changeType}` | Wraps Table Storage writes (upsert, update, add, delete, transaction) and sends a coalesced event after each successful write. `entity` is the table name. |
| `DatabaseChanges` SQL trigger | `database-changed` `{entity, changeTypes[]}` | SQL triggers on 22 tables write to `dbo.RealtimeNotificationOutbox`, so direct DAB writes also produce push events. See [the outbox map](#sql-outbox-entity-to-group-map). |
| Durable `push-v1` utility jobs | `utility-status-changed` | `RegisterUtilityLifecycle` and the `ObserveUtilityLifecycle` queue trigger report job status. |

**Sanitized groups.** Every message in the `orders` group is replaced with `{"event":"orders-changed"}` and every message in the `finance` group with `{"event":"finance-changed"}` before sending (`SanitizePayloadForGroup`). These groups carry cache-invalidation signals only, never record IDs or amounts. The tables below still show the original event names so you can trace the producer.

## Groups and who can join them

A client calls `GET /api/webpubsub/negotiate` with a Functions-audience token. The caller must be signed in, have category Consumer, Employee or Manufacturing, and hold `realtime.connect`. The server then grants each group where the caller holds **any** of the listed scopes and, for internal groups, is not a consumer. The browser cannot choose its groups. The client access URL is valid for 1 hour.

| Group | Required scope (any of) | Internal only | Subscribed by |
|---|---|---|---|
| `orders` | `orders.read`, `manufacturing.read` | No | Storefront, admin, manufacturing |
| `manufacturing-agent` | `manufacturing.read` | Yes | Manufacturing |
| `manufacturing-ops` | `manufacturing.read` | Yes | Manufacturing |
| `warehouse` | `inventory.read` | Yes | Admin, manufacturing |
| `supply-chain` | `inventory.read`, `manufacturing.read` | Yes | Manufacturing |
| `shopping-simulator` | `admin.read`, `manufacturing.read` | Yes | Admin, manufacturing |
| `reviews` | `admin.read` | Yes | Admin |
| `finance` | `sales.read`, `manufacturing.read` | Yes | Manufacturing |
| `promotions` | `admin.read` | Yes | Admin |
| `utilities` | `admin.read` | Yes | Admin |

## How the frontends react

| App | Groups | Reaction |
|---|---|---|
| Storefront (`app/`) | `orders` | Invalidates the `shoppingCart` query (250 ms batch). |
| Admin (`app-admin/`) | `orders`, `warehouse`, `shopping-simulator`, `reviews`, `promotions`, `utilities` | Invalidates the React Query keys mapped to the group and dispatches a `webpubsub` DOM event. Status pages re-read through `useLiveUpdates` (250 ms batch, one read in flight, follow-up read if a change arrives during a read). The utilities panel filters by `instanceId`. |
| Manufacturing (`app-manufacturing/`) | `manufacturing-agent`, `manufacturing-ops`, `warehouse`, `supply-chain`, `orders`, `shopping-simulator`, `finance` | Invalidates the query keys mapped to the group in a fixed 2-second batch window; a query already fetching gets a follow-up refetch. |

All three apps invalidate their caches when the connection opens or reconnects and show a live-updates-unavailable notice if negotiation fails. Clients react per group; apart from `instanceId` in the admin utilities panel, they do not read event names or payload fields.

## Event catalog

| Group | Event | Producer | Payload fields |
|---|---|---|---|
| `orders` | `order-placed` | `OrderPlacedSqlTrigger` (new `Sales.SalesOrderHeader` row); `PlaceStoreOrder` (`POST /api/store-orders`) | salesOrderId, customerId (sanitized) |
| `orders` | `order-status-changed` | `ProcessSalesOrderStatus_QueueTrigger` (`sales-order-status` queue) | salesOrderId, newStatus (sanitized) |
| `orders` | `orders-delivered` | `OrderDelivery_Timer` (hourly) and `OrderDelivery_HttpTrigger` | count (sanitized) |
| `orders` | `database-changed` | `OrderPlacedSqlTrigger` (every `SalesOrderHeader` change); `DatabaseChanges` (`ShoppingCartItem`, `SalesOrderDetail`) | entity, changeTypes (sanitized) |
| `orders` | `state-changed` | `NotifyingTableClient` on `awOrderPipelineConfig` | entity, changeType (sanitized) |
| `manufacturing-agent` | `run-created` | `OrderPlacedSqlTrigger` | runId, salesOrderId |
| `manufacturing-agent` | `run-started` | `ManufacturingAgentQueue_QueueTrigger` | runId, salesOrderId |
| `manufacturing-agent` | `run-completed` | `ManufacturingAgentQueue_QueueTrigger` | runId, salesOrderId, status |
| `manufacturing-agent` | `step-updated` | `POST /api/manufacturing/agent-runs/{id}/step` | runId, key, status |
| `manufacturing-agent` | `queue-cleared` | `DELETE /api/manufacturing/agent-queue` | — |
| `manufacturing-agent` | `poison-queue-cleared` | `DELETE /api/manufacturing/agent-queue/poison` | — |
| `manufacturing-agent` | `config-changed` | `PUT /api/manufacturing/agent-config` | mode, modeLabel |
| `manufacturing-agent` | `state-changed` | `NotifyingTableClient` on `awManufacturingAgentConfig`, `awManufacturingAgentRuns`, `awManufacturingProposals` | entity, changeType |
| `manufacturing-ops` | `shortage-updated` (coalesced) | `WorkOrderOperationProcessor` (`production-wo-queue`) | productId, workOrderId |
| `manufacturing-ops` | `routing-updated` (coalesced) | `WorkOrderOperationProcessor` | workOrderId, operationSequence |
| `manufacturing-ops` | `scrap-event` (coalesced) | `WorkOrderOperationProcessor` | workOrderId, productId, locationId, scrappedQty |
| `manufacturing-ops` | `wo-completed` (coalesced) | `WorkOrderOperationProcessor` | workOrderId, productId |
| `manufacturing-ops` | `simulation-stopped` | `POST /api/manufacturing/stop` | — |
| `manufacturing-ops` | `config-changed` | `PUT /api/manufacturing/scrap-config/{id}`, `PUT /api/manufacturing/location-config/{id}` | configType (`scrap` or `location`), locationId |
| `manufacturing-ops` | `state-changed` | `NotifyingTableClient` on `awManufacturing` | entity, changeType |
| `manufacturing-ops` | `database-changed` | `DatabaseChanges` | entity, changeTypes |
| `warehouse` | `config-changed` | `PUT /api/warehouse/subcategory-config/{id}` | configType `subcategory`, subcategoryId |
| `warehouse` | `operation-completed` (coalesced) | `WarehouseOperationProcessor` (`warehouse-ops-queue`) | operationType, productId |
| `warehouse` | `inventory-updated` | `WorkOrderOperationProcessor` | productId |
| `warehouse` | `state-changed` | `NotifyingTableClient` on `awWarehouse` | entity, changeType |
| `warehouse` | `database-changed` | `DatabaseChanges` | entity, changeTypes |
| `supply-chain` | `po-status-changed` (coalesced) | `PurchaseOrderProcessor` (`supply-chain-orders-queue`) | purchaseOrderId, newStatus |
| `supply-chain` | `po-created` | `POST /api/supply/order`, `POST /api/supply/reorder-all` | productId, vendorId, qty (single order) or productId, batchCount (reorder-all) |
| `supply-chain` | `state-changed` | `NotifyingTableClient` on `awSupplyChain` | entity, changeType |
| `supply-chain` | `database-changed` | `DatabaseChanges` | entity, changeTypes |
| `shopping-simulator` | `simulator-started` | `POST /api/shopping-simulator/start` | — |
| `shopping-simulator` | `simulator-stopped` | `POST /api/shopping-simulator/stop` | — |
| `shopping-simulator` | `queue-cleared` | `POST /api/shopping-simulator/clear-queue` (through `ShoppingSimulatorService`) | — |
| `shopping-simulator` | `state-changed` | `NotifyingTableClient` on `shoppingSimulator` | entity, changeType |
| `reviews` | `moderation-progress` | `ReviewModeration_QueueTrigger` (`review-moderation-queue`) | jobId |
| `reviews` | `generation-progress` | `GenerateVerifiedReviews` | processed, total |
| `reviews` | `generation-state-changed` | `ReviewService` | productId, changeType (`started`, `progress`, `terminal`) |
| `reviews` | `moderation-state-changed` | `ReviewService` | jobId, changeType |
| `reviews` | `database-changed` | `DatabaseChanges` (`ProductReview`, `ProductReviewReply`) | entity, changeTypes |
| `finance` | `transaction` (coalesced) | `BankService` (every recorded bank transaction) | currencyCode, amount, transactionType, referenceId (sanitized) |
| `finance` | `state-changed` | `NotifyingTableClient` on `awBankAccounts`, `awBankTransactions` | entity, changeType (sanitized) |
| `finance` | `database-changed` | `DatabaseChanges` | entity, changeTypes (sanitized) |
| `promotions` | `auto-promotion-created` | `AutoPromotion_QueueTrigger` (`auto-promotion-queue`) | specialOfferId, promotionType, offerCategory, description, discountPct, productCount, expiredPromotionIds |
| `promotions` | `state-changed` | `NotifyingTableClient` on `awAutoPromotionConfig` | entity, changeType |
| `promotions` | `database-changed` | `DatabaseChanges` (`SpecialOffer`, `SpecialOfferProduct`) | entity, changeTypes |
| `utilities` | `utility-status-changed` | `RegisterUtilityLifecycle` activity (`Started`) and `ObserveUtilityLifecycle` queue trigger (runtime status) | instanceId, jobType, changeType |

The `reviews` job tables (`verifiedReviewsJob`, `reviewModerationJob`) use a plain `TableClient`; `ReviewService` publishes the explicit review events instead of `state-changed`.

## SQL outbox entity-to-group map

The seed job creates `RealtimeNotify_<Table>` AFTER INSERT, UPDATE and DELETE triggers on these 22 tables. Each trigger writes a row to `dbo.RealtimeNotificationOutbox`. The `DatabaseChanges` function reads the outbox through a SQL trigger, groups rows by entity and sends one coalesced `database-changed` event per mapped group. An entity missing from the map is treated as an error. `CleanupDatabaseNotifications` (daily at 03:00 UTC) deletes up to 10,000 outbox rows older than 7 days.

| Source table | Groups |
|---|---|
| `Sales.ShoppingCartItem` | `orders` |
| `Sales.SalesOrderDetail` | `orders` |
| `Production.WorkOrder` | `manufacturing-ops` |
| `Production.WorkOrderRouting` | `manufacturing-ops` |
| `Production.ProductInventory` | `manufacturing-ops`, `warehouse`, `supply-chain` |
| `Production.Location` | `manufacturing-ops`, `warehouse` |
| `Production.BillOfMaterials` | `manufacturing-ops` |
| `Production.Product` | `manufacturing-ops`, `warehouse`, `supply-chain` |
| `Production.ProductCostHistory` | `manufacturing-ops`, `finance` |
| `Production.ProductListPriceHistory` | `manufacturing-ops`, `finance` |
| `Production.ProductModel` | `manufacturing-ops` |
| `Production.TransactionHistory` | `manufacturing-ops`, `warehouse`, `finance` |
| `Production.TransactionHistoryArchive` | `manufacturing-ops`, `warehouse`, `finance` |
| `Purchasing.Vendor` | `supply-chain`, `warehouse` |
| `Purchasing.ProductVendor` | `supply-chain`, `manufacturing-ops` |
| `Purchasing.PurchaseOrderHeader` | `supply-chain`, `warehouse`, `finance` |
| `Purchasing.PurchaseOrderDetail` | `supply-chain`, `warehouse` |
| `Production.ProductReview` | `reviews` |
| `Production.ProductReviewReply` | `reviews` |
| `Sales.SpecialOffer` | `promotions` |
| `Sales.CurrencyRate` | `finance` |
| `Sales.SpecialOfferProduct` | `promotions` |

`Sales.SalesOrderHeader` is not in the outbox: `OrderPlacedSqlTrigger` watches it directly with Change Tracking and publishes to `orders`.

## Adding a new live-data event

1. Publish from the server after the change succeeds: call `SendToGroupAsync` or `SendCoalescedAsync`, write through `NotifyingTableClient`, or add the table to the outbox map in `DatabaseChangeNotifications.cs` and the matching trigger in the seed job.
2. Register the group's query keys in the consuming app's `useRealTimeUpdates.ts` (admin status pages also listen for the `webpubsub` DOM event).
3. Keep payloads free of private records, tokens and Durable management URLs. Do not add `refetchInterval` or polling.
4. Update this page and run `node --experimental-vm-modules --test tests/scripts/test-live-updates.mjs`.

Azure Web PubSub runs on the Free tier: 20 concurrent connections and 20,000 messages per day across all apps. Coalescing reduces traffic, but long, busy simulator runs can still reach the daily limit.
