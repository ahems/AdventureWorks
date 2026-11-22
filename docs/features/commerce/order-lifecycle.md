---
title: Order lifecycle and pipeline
summary: How a sales order moves from Pending through Approved, Backordered, Shipped and Delivered, which Azure Functions drive each step, and how admins tune and promote orders in the order pipeline.
audience: [developer, operator, demo-presenter]
components: [app, app-admin, api-functions, api]
related:
  - cart-and-checkout.md
  - receipts.md
  - ../email/email-notifications.md
  - ../warehouse/warehouse-operations.md
  - ../finance/bank-simulator.md
  - ../simulators/shopping-simulator.md
  - ../../reference/storage-resources.md
---

# Order lifecycle and pipeline

Every new sales order, whether from the storefront, a B2B store order or the [shopping simulator](../simulators/shopping-simulator.md), is advanced automatically by Azure Functions. The pipeline simulates approval, warehouse picking, backorders, shipping and delivery, and pushes each change to the apps in real time.

## What it does

| Status | Name | Meaning |
|---|---|---|
| 1 | Pending (In Process) | Order placed |
| 2 | Approved | Passed approval; waiting for warehouse pick |
| 3 | Backordered | Waiting for stock |
| 4 | Rejected | Terminal |
| 5 | Shipped | Picked and shipped; delivery pending |
| 6 | Cancelled | Terminal |
| 7 | Delivered | Terminal |

- Orders advance on their own with randomized, configurable delays.
- Admins can view the pipeline, tune delays, push orders forward, ship or cancel orders, and run delivery on demand from **Order pipeline** (`/order-pipeline`) and **Orders** (`/orders`).
- Admins can place B2B store orders from **Stores** (`/stores`) and generate AI orders.
- Customers follow their order on the storefront account and order-tracking pages.

## Try it

- **UI:** in the admin app open **Order pipeline**, then place a storefront order and watch it move.
- **API** (read-only):

  ```bash
  python3 scripts/utilities/azure-auth.py request \
    --identity admin --resource functions --path /api/orders/pipeline/status

  python3 scripts/utilities/azure-auth.py request \
    --identity admin --resource functions --path /api/orders/pipeline/config
  ```

## How it works

```mermaid
stateDiagram-v2
  [*] --> Pending: order inserted (Status 1)
  Pending --> Rejected: 5%
  Pending --> Approved: 95% after 5-60 min
  Approved --> WarehousePick: after 1-12 h
  WarehousePick --> Shipped: all items picked
  Approved --> Backordered: 10% (no warehouse)
  Approved --> Shipped: 90% (no warehouse)
  Backordered --> Shipped: after 2-4 days
  Shipped --> Delivered: hourly timer within the min-max delivery window
  Pending --> Cancelled: admin cancel
  Approved --> Cancelled: admin cancel
  Backordered --> Cancelled: admin cancel
  Rejected --> [*]
  Cancelled --> [*]
  Delivered --> [*]
```

When a row is inserted into `Sales.SalesOrderHeader`, the `OrderPlacedSqlTrigger` SQL trigger fans out work:

```mermaid
flowchart TD
  Insert["INSERT Sales.SalesOrderHeader"] --> Trigger["OrderPlacedSqlTrigger"]
  Trigger --> Push["Web PubSub orders: database-changed"]
  Trigger --> Receipt["Queue order-receipt-generation (receipt + email)"]
  Trigger --> Status["Queue sales-order-status (Status 1, delayed)"]
  Trigger --> Agent{"Manufacturing agent mode Off?"}
  Agent -- "No" --> Run["Agent run + manufacturing-agent-queue"]
  Trigger --> Promo{"Auto-promotion threshold reached?"}
  Promo -- "Yes" --> PromoQ["Queue auto-promotion-queue"]
  Status --> Proc["ProcessSalesOrderStatus"]
  Proc -->|"Approved + pick delay"| WH["Warehouse retrieve operations"]
  WH -->|"Status 5 message"| Proc
  Proc -->|"Shipped"| Ship["Shipped email (if enabled) + bank credit"]
  Timer["OrderDelivery_Timer (hourly)"] -->|"5 to 7"| Deliv["Delivered email (if enabled)"]
```

1. **`OrderPlacedSqlTrigger`** enqueues the receipt job, enqueues a Status 1 message on `sales-order-status` with a random visibility delay, creates a manufacturing-agent run unless the agent mode is Off, and updates the auto-promotion counter (see [Promotions](../promotions/promotions.md)).
2. **`ProcessSalesOrderStatus`** (queue `sales-order-status`):
   - Status 1 becomes 4 (5%) or 2 (95%). Each status update is conditional on the status the message expects, so a message never overwrites an order that an admin has cancelled or that has already moved on.
   - An approved order is re-queued after the approved-to-shipped delay and handed to the warehouse, which creates pick operations and enqueues Status 5 when every item is picked. See [Warehouse operations](../warehouse/warehouse-operations.md).
   - Without the warehouse service, Status 2 becomes 3 (10%) or 5 (90%); a backorder ships after 2–4 days.
   - On Shipped, it sends the shipped email (when enabled) and records the sale in the [bank simulator](../finance/bank-simulator.md).
3. **`OrderDelivery_Timer`** (`0 0 * * * *`) promotes Shipped orders to Delivered, then sends the delivered email (when enabled). Each order gets a deterministic delivery threshold inside the configured window for its type: `min + (SalesOrderID mod (max − min + 1))` days after `ShipDate` (or `ModifiedDate`). Deliveries are therefore spread across the window, and no order waits longer than the maximum. If the stored maximum is below the minimum, the minimum is used for both.

### Pipeline control routes

| Route | Purpose |
|---|---|
| `GET` / `PUT /api/orders/pipeline/config` | Read or change pipeline delays |
| `GET /api/orders/pipeline/status` | Counts and timing by status |
| `POST /api/orders/pipeline/promote-pending` | Approve Pending orders now. Each order is queued on `sales-order-status` with a force-approve flag, so it skips the 5% rejection and goes straight to the normal warehouse pick path. |
| `POST /api/orders/pipeline/promote-approved` | Move Approved orders forward now |
| `POST /api/orders/delivery/trigger` | Run the delivery check now |
| `POST /api/orders/{id}/ship` | Ship one order |
| `POST /api/orders/begin-processing-order` | Start pipeline processing for an order |
| `POST /api/orders/{id}/cancel` | Cancel one order |

Admin cancel calls `POST /api/orders/{id}/cancel`. The function sets `Status = 6` only when the order is still Pending (1), Approved (2) or Backordered (3), as one conditional update. It returns HTTP 409 for Rejected, Shipped, Cancelled or Delivered orders and HTTP 404 for unknown ids. On success it sends a generic `order-status-changed` signal to the `orders` group. The admin app no longer writes order status through DAB.

### B2B store orders and AI orders

| Route | Purpose |
|---|---|
| `GET /api/stores`, `/api/stores/{id}`, `/api/stores/{id}/orders` | Store list, details and order history |
| `GET /api/store-territories`, `/api/store-products`, `/api/product-catalog` | Lookups for the store-order form |
| `GET /api/orders/{orderId}/lines` | Order lines |
| `POST /api/store-orders` | Place a B2B order |
| `POST /api/GenerateOrderWithAI`, `/api/GenerateOrdersBulk` | Generate realistic orders with the order agent |

`POST /api/store-orders` accepts only product ids and quantities (1–999) per line; any `unitPrice` or `discountPct` a client sends is ignored. Each line is priced by the same rules as [storefront checkout](cart-and-checkout.md): `UnitPrice = ListPrice`, `UnitPriceDiscount` and `SpecialOfferID` from the best active `Reseller` special offer (or 1, No Discount). A product that is missing or has no positive list price returns HTTP 400. B2B orders keep their own 8.75% tax, tiered freight and immediate Finished Goods stock decrement. The admin dialog's totals are an estimate.

## Data & storage

| Data | Store |
|---|---|
| Orders and lines | `Sales.SalesOrderHeader`, `Sales.SalesOrderDetail` |
| Pipeline config | Table `awOrderPipelineConfig`, row `config` / `order-pipeline` |
| Status messages | Queue `sales-order-status` |
| Receipt jobs | Queue `order-receipt-generation` |
| Auto-promotion jobs | Queue `auto-promotion-queue` |

Default delays: Pending→Approved 5–60 minutes; Approved→Shipped 1–12 hours; delivery 3–7 days for consumer (B2C) orders and 5–10 days for store (B2B) orders. `PUT` accepts 1–1440 minutes, 0–168 hours and 1–30 days. See [storage resources](../../reference/storage-resources.md).

## Events (Web PubSub)

All events go to the `orders` group:

| Event | Sent by |
|---|---|
| `database-changed` | `OrderPlacedSqlTrigger` and the database outbox |
| `order-placed` | Order trigger (every inserted order, regardless of manufacturing agent mode) and `POST /api/store-orders` |
| `order-status-changed` | `ProcessSalesOrderStatus` and `POST /api/orders/{id}/cancel` |
| `orders-delivered` | `OrderDelivery_Timer` |
| `state-changed` | Pipeline config saves |

`orders` payloads are reduced to a generic `orders-changed` invalidation signal with no identifiers or business values. Shipping also triggers a `finance` signal from the bank simulator. See [Web PubSub events](../../reference/webpubsub-events.md) and [real-time eventing](../../architecture/realtime-eventing.md).

## Security

| Route group | Scope |
|---|---|
| Pipeline config/status reads | `orders.read` (internal) |
| Pipeline changes, promote, delivery trigger, ship, begin-processing, cancel | `orders.write` (internal; `executive-admin` only) |
| Store reads | `admin.read` |
| Store orders and AI order generation | `admin.write` |

Customers see only their own orders through DAB ownership policies. See [Functions route scopes](../functions-oauth/ROUTE_SCOPE_MATRIX.md).

## Configuration

| Setting | Purpose |
|---|---|
| `ORDER_NOTIFICATIONS_EMAIL_ENABLED` | Sends shipped/delivered emails when `true` (default off); see [email notifications](../email/email-notifications.md) |
| `AI_AGENT_ORDER_ID` | Foundry agent for AI order generation |
| `SQL_CONNECTION_STRING` | SQL trigger and order updates |

`OrderPlacedSqlTrigger` runs in its own always-ready Flex Consumption scale group.

## Limits

- Outcomes are randomized for demo purposes; they do not reflect real stock or credit checks.
- The delivery day within the window is derived from the order id rather than chosen at random, so it is stable across timer runs.
- The storefront tracking page shows an "out for delivery" step that has no status code of its own.

## Related code & docs

- `api-functions/Functions/OrderPlacedSqlTrigger.cs`, `ProcessSalesOrderStatus.cs`, `OrderDeliveryTimerFunction.cs`, `OrderPipelineControlFunction.cs`, `OrderStatusFunctions.cs`, `OrderCancelFunctions.cs`, `StoreOrderFunctions.cs`
- `app-admin/src/pages/` order, order-pipeline and store pages; `app/src/pages/OrderTrackingPage.tsx`
- [Receipts](receipts.md) · [Email notifications](../email/email-notifications.md) · [Shopping simulator](../simulators/shopping-simulator.md) · [Admin portal](../../apps/admin-portal.md)
