# Manufacturing Simulation System

## Overview

The manufacturing simulation generates realistic production runs for AdventureWorks finished goods by:

1. Exploding the Bill of Materials (BOM) recursively for a root product
2. Creating `Production.WorkOrder` and `Production.WorkOrderRouting` rows for every manufactured component in the BOM tree
3. Driving those work orders through their routing operations using a **self-rescheduling Azure Storage Queue pattern** — no timer triggers, no sleeps, no polling
4. Enforcing location capacity constraints, purchased-component inventory consumption, and probabilistic scrap/failure at each station

The container hosting these functions has `minReplicas = 0`. Because all simulation work is queue-driven, the container **scales to zero** when the queue is empty and scales back up automatically (via KEDA) when a run begins.

---

## Architecture

```
POST /api/manufacturing/begin
        │
        ▼
  ValidateFinishedGood ──→ Explode BOM (recursive CTE)
        │
        ▼
  Create WorkOrders + WorkOrderRouting (bottom-up: leaves first)
        │
        ▼
  Save ManufacturingRunRecord → Azure Table Storage (partition: run)
        │
        ▼
  Enqueue leaf WorkOrders' first ops → production-wo-queue (visibilityTimeout=0)
        │
        ▼  ◄─────────────────────────────┐
  WorkOrderOperationProcessor            │
  (Queue trigger: production-wo-queue)   │
        │                                │
        ├─ Phase 1 (IsCompletionPhase=false)
        │     1. Consume purchased inventory (first op of WO only)
        │        → shortage? re-enqueue with MATERIALS_RETRY_DELAY_SECONDS
        │     2. Claim N-slot location capacity (ETag-guarded Table Storage)
        │        → conflict? re-enqueue with 5s backoff
        │        → slot in future? re-enqueue with (startDelay) visibility
        │     3. Set WorkOrderRouting.ActualStartDate
        │     4. Enqueue Phase 2 with visibilityTimeout = op duration
        │
        └─ Phase 2 (IsCompletionPhase=true)
              1. Self-reschedule if ScheduledCompletionUtc > now
              2. Set ActualEndDate / ActualResourceHrs / ActualCost
              3. Scrap roll: per-location probability from Table Storage
                 → partial: increment ScrappedQty, continue chain
                 → total: close WorkOrder (no inventory); chain stops
              4. Next routing op → enqueue new Phase 1 (visibility=0)
                 OR last op: CompleteWorkOrder → upsert finished goods
                             inventory → unblock parent assemblies ──┘
```

### Infrastructure

| Resource                         | Purpose                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `production-wo-queue`            | Azure Storage Queue; drives all simulation work             |
| `awManufacturing`                | Azure Table Storage table; 6 logical partitions (see below) |
| KEDA scale rule on Container App | Scales replicas 0→5 when `queueLength >= 5`                 |

### Table Storage Partitions (`awManufacturing`)

| PartitionKey     | RowKey                    | Purpose                                                            |
| ---------------- | ------------------------- | ------------------------------------------------------------------ |
| `locationconfig` | `{locationId}`            | Per-station capacity settings (N slots, shift hours, speed factor) |
| `locationslots`  | `{locationId}`            | Live slot array — each slot tracks `BusyUntilUtc`; ETag-guarded    |
| `scrapconfig`    | `{locationId}`            | Per-station failure rate and applicable `ScrapReasonID` list       |
| `shortage`       | `wo{woId}p{productId}`    | Active inventory shortages; cleared when materials arrive          |
| `scrapevent`     | `{MaxTicks-ticks}_{woId}` | Reverse-chrono scrap audit trail                                   |
| `run`            | `{runId}`                 | Run record: root product, all WorkOrderIDs, BOM parent map         |

---

## API Reference

### `POST /api/manufacturing/begin`

Starts a new production run. Validates the product, explodes the BOM, creates all work orders, seeds the queue, and returns immediately (`202 Accepted`) — actual execution is asynchronous.

**Only products with `MakeFlag = true` AND `FinishedGoodsFlag = true` are accepted.**

#### Request body

```json
{
  "productId": 749,
  "orderQty": 2,
  "dueDate": "2026-05-01T00:00:00Z"
}
```

| Field       | Type       | Required | Notes                                                               |
| ----------- | ---------- | -------- | ------------------------------------------------------------------- |
| `productId` | `int`      | ✅       | Must be a manufactured finished good (MakeFlag + FinishedGoodsFlag) |
| `orderQty`  | `int`      | ✅       | Number of root-product units to produce                             |
| `dueDate`   | `datetime` | ❌       | Defaults to `now + 7 days`                                          |

#### Response `202 Accepted`

```json
{
  "runId": "0a836645dcba432f99fa9e68d8b4ab14",
  "rootWorkOrderId": 72645,
  "totalWorkOrders": 27,
  "leafWorkOrders": 20,
  "warnings": [
    {
      "productId": 321,
      "name": "HL Road Frame - Red, 62",
      "required": 4,
      "available": 1,
      "shortfall": 3
    }
  ]
}
```

| Field             | Notes                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `runId`           | GUID correlating all WorkOrders in this BOM run. Keep this for status checks.                    |
| `rootWorkOrderId` | The top-level WorkOrderID for the finished good                                                  |
| `totalWorkOrders` | All work orders created (root + all manufactured BOM nodes)                                      |
| `leafWorkOrders`  | Work orders immediately queued (purchased-component nodes); number that started processing       |
| `warnings`        | Inventory shortfalls detected at run-start. Production schedules anyway and retries on shortage. |

> **Note:** Inventory warnings are informational. The simulation will retry a stalled work order every `MATERIALS_RETRY_DELAY_SECONDS` seconds (default 30) until stock is available.

---

### `POST /api/manufacturing/stop`

Clears all pending messages from `production-wo-queue`. In-flight operations (currently being processed by a running container instance) will complete, then the container scales to zero.

**No request body required.**

#### Response `200 OK`

```json
{
  "message": "Production queue cleared. Container will scale to zero once in-flight messages complete."
}
```

---

### `GET /api/manufacturing/status`

Returns a dashboard snapshot: queue depth, work order counts, active shortages, recent scrap events, and location capacity load.

#### Response `200 OK`

```json
{
  "isRunning": true,
  "queueDepth": 40,
  "pendingWorkOrders": 49,
  "inProgressWorkOrders": 5,
  "completedToday": 0,
  "stalledForMaterials": 0,
  "shortages": [],
  "recentScrapEvents": [],
  "locationLoad": [
    {
      "locationId": 10,
      "locationName": "Frame Forming",
      "earliestFreeSlotUtc": "2026-04-07T22:44:12Z",
      "availabilityHrs": 96.0,
      "capacityUnits": 2
    },
    {
      "locationId": 50,
      "locationName": "Subassembly",
      "earliestFreeSlotUtc": "2026-04-07T23:26:54Z",
      "availabilityHrs": 120.0,
      "capacityUnits": 3
    }
  ]
}
```

| Field                  | Notes                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `isRunning`            | `true` if `queueDepth > 0` or any work orders are in-progress                                 |
| `queueDepth`           | Approximate messages in `production-wo-queue` (Azure Storage eventual consistency)            |
| `pendingWorkOrders`    | WorkOrders with no routing ops started yet                                                    |
| `inProgressWorkOrders` | WorkOrders with at least one `ActualStartDate` set but no `EndDate`                           |
| `completedToday`       | WorkOrders with `EndDate` = today (UTC)                                                       |
| `stalledForMaterials`  | Count of active shortage records                                                              |
| `shortages`            | Full shortage list — see `ShortageData` below                                                 |
| `recentScrapEvents`    | Last 10 scrap events (most recent first)                                                      |
| `locationLoad`         | Per-station slot-array state — `earliestFreeSlotUtc` shows when the busiest slot becomes free |

**`ShortageData` object:**

```json
{
  "workOrderId": 72618,
  "productId": 321,
  "productName": "HL Road Frame - Red, 62",
  "needed": 4,
  "available": 1,
  "shortfall": 3,
  "lastRetryUtc": "2026-04-07T22:35:00Z"
}
```

**`ScrapEventData` object:**

```json
{
  "workOrderId": 72640,
  "productId": 811,
  "productName": "HL Mountain Frame - Silver, 38",
  "locationId": 10,
  "locationName": "Frame Forming",
  "scrapReasonId": 3,
  "scrapReasonName": "Gouge in metal",
  "isTotalFailure": false,
  "failedAtUtc": "2026-04-07T22:38:12Z",
  "supplierVendorId": 1650,
  "supplierVendorName": "American Bicycles and Wheels",
  "supplierComponentProductId": 316,
  "supplierComponentName": "Blade"
}
```

`supplierVendorId` and related fields are populated only when the scrap reason is a material-quality indicator (see [Supplier Attribution](#supplier-attribution) below). They are `null` for process-failure scrap reasons.

---

### `GET /api/manufacturing/active`

Returns all currently in-progress routing operations with elapsed time. Useful for a live operations view.

#### Response `200 OK` (array)

```json
[
  {
    "workOrderId": 72640,
    "productId": 811,
    "productName": "HL Mountain Frame - Silver, 38",
    "operationSequence": 1,
    "locationId": 10,
    "locationName": "Frame Forming",
    "actualStartDate": "2026-04-07T22:30:00Z",
    "elapsedMinutes": 8.5
  }
]
```

---

### `GET /api/manufacturing/scrap-config`

Returns the current scrap/failure configuration for all production stations.

#### Response `200 OK` (array)

```json
[
  {
    "locationId": 10,
    "locationName": "Frame Forming",
    "failureRatePct": 0.05,
    "scrapReasonIds": [3, 4, 5, 6, 12, 13, 14, 15],
    "note": "Seeded from default mapping"
  }
]
```

---

### `PUT /api/manufacturing/scrap-config/{locationId}`

Updates the scrap/failure configuration for a single station. Takes effect on the next message processed for that location — no restart required.

#### Request body

```json
{
  "failureRatePct": 0.15,
  "scrapReasonIds": [3, 5, 12],
  "note": "Chaos mode — stress testing Frame Forming"
}
```

| Field            | Type     | Validation                                                                                   |
| ---------------- | -------- | -------------------------------------------------------------------------------------------- |
| `failureRatePct` | `double` | Must be `0.0`–`1.0`. Use `0.0` to disable scrap entirely for this station.                   |
| `scrapReasonIds` | `int[]`  | IDs from `Production.ScrapReason`. If empty, scrap chance is rolled but no event is written. |
| `note`           | `string` | Optional label visible in the GET response.                                                  |

#### Response `200 OK` — returns the updated config object.

---

### `GET /api/manufacturing/location-config`

Returns the capacity/shift/speed configuration for all production stations.

#### Response `200 OK` (array)

```json
[
  {
    "locationId": 10,
    "locationName": "Frame Forming",
    "capacityUnits": 2,
    "dailyOperatingHours": 8.0,
    "speedFactor": 1.0,
    "overtimeMultiplier": 1.5,
    "shiftStartHour": 6,
    "note": null
  }
]
```

---

### `PUT /api/manufacturing/location-config/{locationId}`

Updates capacity settings for a station. Can be used to model adding a machine, starting overtime, or simulating shift changes. Takes effect immediately — the slot array is resized on write.

#### Request body

```json
{
  "capacityUnits": 4,
  "dailyOperatingHours": 12.0,
  "speedFactor": 1.5,
  "overtimeMultiplier": 1.5,
  "shiftStartHour": 6,
  "note": "Added second shift to clear backlog"
}
```

| Field                 | Type     | Default                       | Effect                                                                                                    |
| --------------------- | -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `capacityUnits`       | `int`    | from Location.Availability/40 | Number of parallel work slots at this station. Increasing unblocks queued work orders immediately.        |
| `dailyOperatingHours` | `double` | `8.0`                         | Affects how soon the next free slot opens                                                                 |
| `speedFactor`         | `double` | `1.0`                         | Multiplier on operation duration. `2.0` = ops complete in half the simulated time. `0.5` = twice as long. |
| `overtimeMultiplier`  | `double` | `1.5`                         | Placeholder for cost calculations — does not affect timing currently.                                     |
| `shiftStartHour`      | `int`    | `6`                           | UTC hour when the shift starts. Used to calculate slot opening times.                                     |
| `note`                | `string` | `null`                        | Free text, visible in GET response.                                                                       |

#### Response `200 OK` — returns the updated config object.

---

### `GET /api/manufacturing/scrap-events`

Returns the full scrap event history (all time), optionally filtered to a single supplier.

#### Query parameters

| Parameter  | Type  | Required | Description                                                                     |
| ---------- | ----- | -------- | ------------------------------------------------------------------------------- |
| `vendorId` | `int` | No       | Filter to events attributed to a specific `Purchasing.Vendor.BusinessEntityID`. |

#### Response `200 OK`

Returns an array of `ScrapEventData` objects. The array is empty when no events match the filter.

```json
[
  {
    "workOrderId": "run-20240115-abc123:wo-42",
    "productId": 316,
    "productName": "LL Crankarm",
    "locationId": 50,
    "locationName": "Subassembly",
    "scrapReasonId": 3,
    "scrapReasonName": "Gouge in metal",
    "scrappedQty": 1,
    "isTotalFailure": false,
    "failedAtUtc": "2024-01-15T10:23:45Z",
    "supplierVendorId": 1650,
    "supplierVendorName": "Advanced Bicycles",
    "supplierComponentProductId": 1,
    "supplierComponentName": "Adjustable Race"
  }
]
```

> `supplierVendorId` and related supplier fields are `null` for events caused by process-quality scrap reasons (IDs not in `{1, 3, 7, 10}`).

---

### `GET /api/manufacturing/vendor-quality`

Returns an aggregated quality report grouped by supplier. Only vendors with at least one attributed scrap event appear in the response.

#### Response `200 OK`

```json
[
  {
    "vendorId": 1650,
    "vendorName": "Advanced Bicycles",
    "totalScrapEvents": 7,
    "totalFailures": 2,
    "affectedWorkOrders": 6,
    "mostRecentEventUtc": "2024-01-15T10:23:45Z",
    "components": [
      {
        "componentProductId": 1,
        "componentName": "Adjustable Race",
        "scrapEvents": 4,
        "totalFailures": 1
      },
      {
        "componentProductId": 316,
        "componentName": "LL Crankarm",
        "scrapEvents": 3,
        "totalFailures": 1
      }
    ]
  }
]
```

---

### `GET /api/manufacturing/vendor-quality/{vendorId}`

Returns quality data for a single vendor. Returns `404` if no attributed scrap events exist for that vendor.

#### Path parameters

| Parameter  | Type  | Description                          |
| ---------- | ----- | ------------------------------------ |
| `vendorId` | `int` | `Purchasing.Vendor.BusinessEntityID` |

#### Response `200 OK` — same shape as a single element from the list endpoint above.

#### Response `404 Not Found` — vendor has no attributed scrap events.

---

## Configuration (Environment Variables)

| Variable                        | Default | Effect                                                                                                                       |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SIMULATION_TIME_SCALE_FACTOR`  | `60`    | 1 real second = N simulated minutes. Default: 1s real = 1 min simulated, so a 2-hour operation takes 2 minutes.              |
| `SIMULATION_SCRAP_RATE`         | `0.05`  | Global fallback failure rate for any station not in the `DefaultScrapMap`. Per-location Table Storage config overrides this. |
| `MATERIALS_RETRY_DELAY_SECONDS` | `30`    | How long to wait before retrying a stalled work order when inventory is insufficient.                                        |

### Simulation Time Explained

Operation duration is calculated as:

```
opDurationHrs = PlannedCost / CostRate      (both from WorkOrderRouting)
realSeconds   = (opDurationHrs * 3600) / SIMULATION_TIME_SCALE_FACTOR
```

With the default `SIMULATION_TIME_SCALE_FACTOR = 60`, a 1-hour simulated operation takes **60 seconds** of real time. To run the simulation faster (useful for demo/testing), increase this value:

| Scale Factor   | 1 sim-hour =    |
| -------------- | --------------- |
| `60` (default) | 60 real seconds |
| `600`          | 6 real seconds  |
| `3600`         | 1 real second   |

---

## Production Routing

When creating work orders, the simulation uses a two-pass lookup for routing operations:

1. **Historical routing** — queries `Production.WorkOrderRouting` for the most recent completed routing for this `ProductID`, ordered by `WorkOrderID DESC`. This gives authentic operation sequences and cost data from the existing AdventureWorks dataset.

2. **Default routing fallback** — if no historical routing exists, uses:
   - **Leaf nodes** (purchased-component sub-assemblies): 1 op at Location 50 (Subassembly), cost $50, rate $12.25/hr
   - **Assembly nodes** (products that are parents in the BOM): 2 ops — Location 50 (Subassembly, $100) then Location 60 (Final Assembly, $150)

---

## Location Capacity Model

Each production location has `N` independent capacity slots. The number of slots defaults to:

```
slots = ceil(Location.Availability / 40)
```

where `Location.Availability` is the weekly available hours in the AdventureWorks `Production.Location` table. For example, Frame Forming has 96 availability hours → 2 slots; Subassembly has 120 hours → 3 slots.

**Slot claiming** is managed via optimistic concurrency (ETag) in Table Storage:

1. Read the `locationslots` row
2. Find the slot with the earliest `BusyUntilUtc` (the most idle slot)
3. Calculate the start time: `max(now, slot.BusyUntilUtc)`
4. Write the updated slot's `BusyUntilUtc` back using the original ETag
5. On `412 Precondition Failed` (another replica claimed the slot simultaneously): retry up to 3 times, then re-enqueue with 5-second backoff

When a slot is not available until a future time, the queue message is re-enqueued with `visibilityTimeout = startDelay`, so the container is not blocked by a busy station — it can process other work orders instead.

---

## BOM Explosion

The BOM query uses a recursive CTE with `MAXRECURSION 20`:

```sql
WITH BomTree AS (
    SELECT p.ProductID, p.Name, CAST(p.MakeFlag AS BIT) AS MakeFlag,
           0 AS Depth, CAST(1.0 AS DECIMAL(18,4)) AS CumulativeQty, NULL AS ParentProductId
    FROM Production.Product p WHERE p.ProductID = @RootProductId
    UNION ALL
    SELECT pc.ProductID, pc.Name, CAST(pc.MakeFlag AS BIT),
           bt.Depth + 1,
           CAST(bt.CumulativeQty * bom.PerAssemblyQty AS DECIMAL(18,4)),
           bt.ProductID
    FROM BomTree bt
    INNER JOIN Production.BillOfMaterials bom
        ON bom.ProductAssemblyID = bt.ProductID AND bom.EndDate IS NULL
    INNER JOIN Production.Product pc ON bom.ComponentID = pc.ProductID
)
```

**Key behaviours:**

- Only `MakeFlag = true` nodes (manufactured components) get their own WorkOrder. `MakeFlag = false` nodes are purchased components — their inventory is consumed but no WorkOrder is created.
- Diamond dependencies (shared sub-assembly used by multiple parent assemblies) are deduplicated by aggregating `CumulativeQty` across all paths.
- Work orders are created **leaves-first** so the BOM chain can unblock from the bottom up.
- The `ManufacturingRunRecord` tracks the full BOM tree so the queue processor knows which parent assemblies to unblock when all children complete.

---

## Inventory Consumption

When the first routing operation of a leaf work order start, the processor:

1. Queries `Production.BillOfMaterials` for purchased components of this product
2. For each component, atomically deducts from `Production.ProductInventory` using `UPDLOCK` to prevent over-consumption across multiple concurrent replicas:

```sql
UPDATE TOP (@Qty) Production.ProductInventory WITH (UPDLOCK)
SET Quantity = Quantity - 1
WHERE ProductID = @ProductId AND Quantity > 0
```

3. If stock is insufficient, a `ShortageData` record is written to Table Storage and the message is re-enqueued with `MATERIALS_RETRY_DELAY_SECONDS` visibility. The status endpoint's `shortages` array reflects all active shortages.
4. When stock later becomes available (e.g., a sibling work order completed and replenished the inventory), the retry fires and clears the shortage record.

---

## Scrap / Failure Simulation

At the end of every routing operation (Phase 2), the processor rolls against the station's configured `failureRatePct`:

```
isScrapped = Random.NextDouble() < scrapConfig.FailureRatePct
             AND scrapConfig.ScrapReasonIds.Length > 0
```

If scrapped, a `ScrapReasonID` is chosen at random from the station's configured list and the following happens:

| Failure type                                       | Behaviour                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Partial failure** (`ScrappedQty + 1 < OrderQty`) | `WorkOrder.ScrappedQty` incremented. Production continues — the remaining good units proceed to the next routing op.                                                                  |
| **Total failure** (`ScrappedQty + 1 >= OrderQty`)  | `WorkOrder.EndDate` set (no finished goods added to inventory). Chain stops. Parent assemblies that depend on this component will stall on materials — visible in the shortage board. |

A `ScrapEventData` record is always written for both partial and total failures. The status endpoint returns the 10 most recent; `GET /api/manufacturing/scrap-events` returns the full history.

### Supplier Attribution

Some `ScrapReason` values indicate the defect originated in a purchased component rather than in the production process itself:

| ScrapReasonID | Name                          | Attribution                     |
| ------------- | ----------------------------- | ------------------------------- |
| 1             | Brake assembly not as ordered | Purchased component out-of-spec |
| 3             | Gouge in metal                | Incoming material damage        |
| 7             | Handling damage               | Transit/shipping damage         |
| 10            | Seat assembly not as ordered  | Purchased component out-of-spec |

When one of these reasons fires, the processor queries `Purchasing.ProductVendor` for the **most recently received supplier** of the purchased components consumed by the work order (ordered by `LastReceiptDate DESC`). This vendor is written into the scrap event as `supplierVendorId`, `supplierVendorName`, `supplierComponentProductId`, and `supplierComponentName`.

The `GET /api/manufacturing/vendor-quality` endpoint aggregates these attributed events into a per-vendor quality report, enabling a UI to surface supplier quality rankings and trending.

### Chaos Mode

To simulate a station "going bad", `PUT` a high failure rate:

```bash
curl -X PUT https://<base>/api/manufacturing/scrap-config/10 \
  -H "Content-Type: application/json" \
  -d '{"failureRatePct": 0.8, "scrapReasonIds": [3, 5, 12], "note": "Chaos mode"}'
```

To trigger supplier-attributed scrap specifically (to populate the vendor quality board), configure a station with material-quality reason IDs:

```bash
# Subassembly (50) — high rate of incoming-part failures
curl -X PUT https://<base>/api/manufacturing/scrap-config/50 \
  -H "Content-Type: application/json" \
  -d '{"failureRatePct": 0.4, "scrapReasonIds": [1, 3, 7, 10], "note": "Incoming quality stress test"}'
```

To disable scrap entirely for a station:

```json
{ "failureRatePct": 0.0, "scrapReasonIds": [] }
```

---

## BOM Parent-Child Unblocking

When a leaf work order completes, the queue processor checks whether any parent assemblies in the same run are now unblocked:

```
parentWoIds = RunRecord.WorkOrders
    .where ProductId is a parent-in-BOM of completedProductId
    .where ALL sibling WOs in that parent's BOM sub-tree have EndDate set
```

If all children are done, the parent assembly's first routing operation is immediately enqueued. This is how the BOM chain advances from leaves to root automatically, with no external orchestration.

---

## Scale-to-Zero Behaviour

The Container App is configured with:

```
minReplicas: 0
maxReplicas: 5
```

And a KEDA scale rule on `production-wo-queue`:

```yaml
queueLength: "5"
```

This means:

- With 0 messages: 0 replicas (fully scaled to zero)
- With 5+ messages: KEDA scales up to handle the backlog
- After `POST /stop` (queue cleared): any running instances finish their in-flight messages, then the container scales back to zero

**Cost:** When no simulation is running, the Container App costs nothing for compute.

---

## Common UI Scenarios

### Scenario: Start a production run and display progress

```javascript
// 1. Start a run
const run = await fetch("/api/manufacturing/begin", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ productId: 749, orderQty: 5 }),
}).then((r) => r.json());

// run.runId, run.totalWorkOrders, run.leafWorkOrders, run.warnings

// 2. Poll status every 5 seconds
setInterval(async () => {
  const status = await fetch("/api/manufacturing/status").then((r) => r.json());
  // status.isRunning
  // status.queueDepth
  // status.pendingWorkOrders / inProgressWorkOrders / completedToday
  // status.shortages[]
  // status.recentScrapEvents[]
  // status.locationLoad[]
}, 5000);
```

### Scenario: Show live operations board

```javascript
// Poll /active every 10 seconds for the live operations table
const active = await fetch("/api/manufacturing/active").then((r) => r.json());
// active[].productName, locationName, operationSequence, elapsedMinutes
```

### Scenario: Adjust location capacity (add a machine)

```javascript
// Double the slots at Frame Forming (LocationID 10)
await fetch("/api/manufacturing/location-config/10", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    capacityUnits: 4,
    dailyOperatingHours: 8.0,
    speedFactor: 1.0,
    overtimeMultiplier: 1.5,
    shiftStartHour: 6,
    note: "Added second machine",
  }),
});
```

### Scenario: Tune scrap rate per station

```javascript
// Raise failure rate at Paint (LocationID 40) — simulate a bad batch
await fetch("/api/manufacturing/scrap-config/40", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    failureRatePct: 0.25,
    scrapReasonIds: [2, 8, 9],
    note: "Bad batch of paint",
  }),
});
```

### Scenario: Supplier quality board

```javascript
// Load all vendors with attributed scrap events, sorted by total failures descending
const vendors = await fetch("/api/manufacturing/vendor-quality").then((r) =>
  r.json(),
);
// vendors[].vendorName, totalScrapEvents, totalFailures, mostRecentEventUtc
// vendors[].components[].componentName, scrapEvents, totalFailures

// Drill into a single vendor
const vendor = await fetch(
  `/api/manufacturing/vendor-quality/${vendorId}`,
).then((r) => r.json());
```

### Scenario: Filter scrap history by supplier

```javascript
// Show all scrap events attributed to a specific vendor (e.g., vendor 1650)
const events = await fetch(
  "/api/manufacturing/scrap-events?vendorId=1650",
).then((r) => r.json());
// events[].productName, locationName, scrapReasonName, isTotalFailure, failedAtUtc
// events[].supplierComponentName, supplierVendorName
```

### Scenario: Emergency stop

```javascript
await fetch("/api/manufacturing/stop", { method: "POST" });
// Container scales to zero within ~2 minutes
```

---

## Finished Goods with Large BOMs (Useful Product IDs)

The following finished goods (`MakeFlag=true`, `FinishedGoodsFlag=true`) have deep BOMs suitable for stress testing:

| ProductID | Name                      | BOM Depth |
| --------- | ------------------------- | --------- |
| 749       | Mountain-100 Black, 38    | 3         |
| 750       | Mountain-100 Black, 42    | 3         |
| 751       | Mountain-100 Black, 44    | 3         |
| 775       | Mountain-100 Silver, 38   | 3         |
| 680       | HL Road Frame - Black, 58 | 2         |
| 707       | Sport-100 Helmet, Red     | 2         |

Query all eligible products:

```sql
SELECT ProductID, Name
FROM Production.Product
WHERE MakeFlag = 1 AND FinishedGoodsFlag = 1
ORDER BY ProductID
```

---

---

## Supply Chain Procurement Simulation

A companion simulation to the manufacturing engine. Models a full purchasing workflow where operators source raw materials from the **63 active vendors** in the AdventureWorks `Purchasing` schema, each carrying real pricing, lead times, and ship method data from the database. Delivered stock is written directly back into `Production.ProductInventory`, closing the loop with the manufacturing engine — a delivery can unblock a stalled work order.

Purchase order state is stored directly in SQL using `Purchasing.PurchaseOrderHeader` and `Purchasing.PurchaseOrderDetail` as the sole persistent records. No simulation-specific SQL tables are required — `PurchaseOrderHeader.Status` is the single source of truth for order state.

Vendor stock levels (`awSupplyChain` Table Storage, `stock` partition) remain in Table Storage for fast optimistic-concurrency deduction on order placement. All order reads, state transitions, and status queries go directly to SQL.

---

### How It Works

#### Vendors

Vendor data is loaded on demand from `Purchasing.Vendor`, `Purchasing.ProductVendor`, and `Purchasing.ShipMethod`. Only active vendors (`ActiveFlag = 1`) that supply at least one BOM purchased component are included — **63 vendors** in total.

Each vendor's simulation behaviour is derived from its `CreditRating` (1–5, where 1 is best):

| CreditRating | Reliability | Restock delay (sim-hrs) | Character               |
| ------------ | ----------- | ----------------------- | ----------------------- |
| 1            | 97%         | 4                       | Preferred, low-risk     |
| 2            | 90%         | 8                       | Reliable                |
| 3            | 83%         | 16                      | Average                 |
| 4            | 73%         | 30                      | Below average           |
| 5            | 65%         | 48                      | High-risk, slow restock |

Each vendor's preferred `ShipMethod` is determined from their most-used method in historical `Purchasing.PurchaseOrderHeader` records:

| ShipMethodID | Name               | ShipBase | ShipRate (per unit) |
| ------------ | ------------------ | -------- | ------------------- |
| 1            | XRQ - TRUCK GROUND | $3.95    | $0.99               |
| 2            | ZY - EXPRESS       | $9.95    | $1.99               |
| 3            | OVERSEAS - DELUXE  | $29.95   | $2.99               |
| 4            | OVERNIGHT J-FAST   | $21.95   | $1.29               |
| 5            | CARGO TRANSPORT 5  | $8.99    | $1.49               |

**Price formula** (per unit, per vendor):

```
unitCost     = Purchasing.ProductVendor.StandardPrice   (vendor-specific, per-component)
shippingCost = vendor.ShipBase + (product.WeightKg × vendor.ShipRate × qty)
totalCost    = (unitCost × qty) + shippingCost
```

Minimum and maximum order quantities are enforced from `ProductVendor.MinOrderQty` / `MaxOrderQty`. Lead times are sourced from `ProductVendor.AverageLeadTime` (per-component days).

#### Product Catalog

The catalog is derived from `Production.BillOfMaterials` joined to `Purchasing.ProductVendor` — only purchased components (`MakeFlag = 0`) that have at least one active vendor are included. Each vendor maintains independent stock for every component it supplies.

#### Order State Machine

When an order is placed the stock is deducted immediately (to prevent oversell), and a queue message drives the order through the following two-step state machine automatically:

```
pending(1) → approved(2) → complete(4)
                         ↓ (reliability roll fails)
                       rejected(3)
```

Delivery times use the same `SIMULATION_TIME_SCALE_FACTOR` as manufacturing:

| Transition                     | Sim time                 | Real time at scale=60 |
| ------------------------------ | ------------------------ | --------------------- |
| pending → approved             | 5 min                    | 5 sec                 |
| approved → complete / rejected | `leadDays × 24 × 60` min | `leadDays × 24` min   |

The reliability roll happens at the delivery step (`approved → complete`/`rejected`). A random value is compared against the vendor's `CreditRating`-derived `reliabilityPct`; failure transitions the order directly to `rejected` (Status=3) rather than `complete`.

#### Initialization and Seed Data

On the **first call** to any `/supply/*` endpoint the simulator runs `InitializeAsync` which:

1. **Processes AdventureWorks Status=2 (Approved) POs** — The original dataset contains purchase orders already in Approved state. These are resolved synchronously with a reliability roll (idempotent — POs already at Status=3/4 are skipped). They do _not_ re-appear in the active-orders list.

2. **Seeds vendor stock in Table Storage** — For every active vendor × BOM purchased-component pair, an initial `CurrentStock` level is written. The seeding formula:
   - Uses the **average `StockedQty`** from `Purchasing.PurchaseOrderDetail` completed (Status=4) POs for that vendor + product pair (±20 % random spread), falling back to a credit-rating fill ratio for pairs with no purchase history.
   - **Deducts the total `OrderQty`** of any Status=1 (Pending) BOM POs for that pair from the seeded stock. This ensures `stockAvailable` accurately reflects what is still orderable — quantities already committed by seed orders are not double-counted.

3. **Injects Status=1 (Pending) BOM POs into the approval queue** — The AdventureWorks dataset contains ~236 purchase orders in Pending state. These are injected into the `supply-chain-orders-queue` and proceed through the normal `pending → approved → complete/rejected` flow:
   - Messages are staggered **1 second apart** (base delay 5 s, then 5+1 s, 5+2 s, …) to avoid a thundering-herd on SQL writes.
   - The same BOM filter applies as for new simulator orders: `p.MakeFlag = 0` + `Production.BillOfMaterials` join + `v.ActiveFlag = 1`.

> **Lazy initialization:** Vendor and stock data is seeded automatically on the first call to any `/supply/*` endpoint. There is no separate initialization step required. Call `DELETE /api/supply/reset` to clear all simulation state and trigger a fresh initialization.

#### SQL Persistence

Every order placed by the simulator creates a row in `Purchasing.PurchaseOrderHeader` (Status=1 Pending) and `Purchasing.PurchaseOrderDetail`. `PurchaseOrderHeader.Status` is the **sole** status field — there is no separate simulation-specific status column:

| API status | `PurchaseOrderHeader.Status` | Notes                                          |
| ---------- | ---------------------------- | ---------------------------------------------- |
| `pending`  | `1` — Pending                | Header created when order is placed            |
| `approved` | `2` — Approved               | Vendor order confirmed; delivery clock running |
| `complete` | `4` — Complete               | `ReceivedQty` updated in detail row            |
| `rejected` | `3` — Rejected               | Reliability check failed or operator cancelled |

The `orderId` in every API response **is** the SQL `PurchaseOrderID` (integer rendered as a string). Use it directly to cross-reference with the `Purchasing` schema via the GraphQL API.

On completion, `Purchasing.ProductVendor.LastReceiptCost` / `LastReceiptDate` are updated and a new `Production.ProductCostHistory` record is written.

#### Delivery → Manufacturing Inventory

On **complete**, the backend writes to SQL:

```sql
UPDATE Production.ProductInventory
SET Quantity = Quantity + @Qty, ModifiedDate = GETDATE()
WHERE ProductID = @ProductId AND LocationID = 7
```

LocationID 7 is Finished Goods Storage. This increment is picked up by the manufacturing engine's shortage-retry loop — a delivered purchase order can directly unblock a stalled work order.

#### Vendor Restock

After each delivery, a deferred restock message is automatically enqueued. The delay (in real seconds) is:

```
restockDelaySec = vendor.RestockDelaySimHrs × 3600 / SIMULATION_TIME_SCALE_FACTOR
```

At `scale=60`: a CreditRating-1 vendor restocks in ~4 real minutes, a CreditRating-5 vendor in ~48 real minutes. The UI can surface this as "next restock in X minutes".

Manual restock is also available via `POST /api/supply/restock/{vendorId}` for demo purposes.

---

### API Reference

Base: `{API_FUNCTIONS_URL}/api/supply`

#### `GET /supply/vendors`

Returns all active vendors with live statistics. `vendorId` is the `Purchasing.Vendor.BusinessEntityID` as a string.

```json
[
  {
    "vendor": {
      "vendorId": "1650",
      "accountNumber": "AMERICANBE0001",
      "name": "American Bicycles and Wheels",
      "description": "Preferred supplier with excellent credit rating and reliable delivery history.",
      "creditRating": 1,
      "preferredVendorStatus": true,
      "defaultLeadTimeDays": 17,
      "reliabilityPct": 0.97,
      "shipMethodId": 5,
      "shipMethodName": "CARGO TRANSPORT 5",
      "shipBase": 8.99,
      "shipRate": 1.49,
      "restockDelaySimHrs": 4,
      "strengths": [
        "Preferred vendor",
        "Excellent credit (Rating 1)",
        "High reliability"
      ],
      "weaknesses": []
    },
    "totalComponents": 3,
    "inStockComponents": 3,
    "activeOrders": 0,
    "deliveredToday": 1
  }
]
```

| Field                   | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `vendorId`              | `Purchasing.Vendor.BusinessEntityID` as a string                     |
| `creditRating`          | 1–5 from `Purchasing.Vendor.CreditRating` (1 = best)                 |
| `preferredVendorStatus` | `Purchasing.Vendor.PreferredVendorStatus`                            |
| `defaultLeadTimeDays`   | Average across all `ProductVendor.AverageLeadTime` for this vendor   |
| `reliabilityPct`        | Derived from `creditRating` (1→0.97, 2→0.90, 3→0.83, 4→0.73, 5→0.65) |
| `shipMethodName`        | Most-used `Purchasing.ShipMethod` from historical purchase orders    |
| `totalComponents`       | Number of catalog SKUs this vendor carries                           |
| `inStockComponents`     | SKUs with `currentStock > 0`                                         |
| `activeOrders`          | Orders in `pending` or `approved` state                              |
| `deliveredToday`        | Orders delivered today (UTC)                                         |

---

#### `GET /supply/vendors/{vendorId}`

Returns a single vendor summary plus their component stock list. `vendorId` is the numeric `BusinessEntityID`.

```json
{
  "vendor": { ... },
  "stock": [
    {
      "vendorId": "1650",
      "productId": 316,
      "productName": "Blade",
      "standardPrice": 28.17,
      "averageLeadTime": 14,
      "minOrderQty": 1,
      "maxOrderQty": 500,
      "currentStock": 80,
      "maxStock": 100,
      "weightKg": 1.2
    }
  ]
}
```

`standardPrice` is `Purchasing.ProductVendor.StandardPrice` — the actual negotiated price for this vendor/component pair. `stock` covers only the components this vendor supplies.

---

#### `GET /supply/catalog`

Returns all vendor offers for all purchasable BOM components. Each row is one vendor's offer for one component, with pricing pre-calculated for qty=1.

```json
[
  {
    "vendorId": "1650",
    "vendorName": "American Bicycles and Wheels",
    "productId": 316,
    "productName": "Blade",
    "qtyRequested": 1,
    "stockAvailable": 70,
    "unitCost": 28.17,
    "shippingCost": 10.48,
    "totalCost": 38.65,
    "leadTimeDays": 14,
    "minOrderQty": 1,
    "maxOrderQty": 500,
    "reliabilityPct": 0.97,
    "estimatedDeliverySimHrs": 336.0,
    "estimatedDeliveryRealMins": 336.0,
    "inStock": true,
    "incomingQty": 10
  }
]
```

Results are sorted by `productId` then `totalCost` ascending — cheapest option first per component.

**`stockAvailable`** is what remains at the vendor **after** deducting all in-flight orders — it is the quantity you can still order right now. **`incomingQty`** is the total units across all open orders (`pending`/`approved`) that have already left the vendor's shelf and will be delivered to your warehouse. Display both together so the UI can show e.g. `"70 available · 10 incoming"`.

**Use this for:** a comparison grid showing all vendors side-by-side for a given component.

---

#### `GET /supply/catalog/{productId}`

Same as above but filtered to one component. Returns rows for all vendors that supply this product, sorted by `totalCost`.

---

#### `GET /supply/quote?vendorId=&productId=&qty=`

Returns a price quote for a specific vendor/product/quantity combination. Validates against `minOrderQty` / `maxOrderQty`. Shipping scales with qty (weight × `shipRate`).

```
GET /api/supply/quote?vendorId=1650&productId=316&qty=50
```

Response shape is the same as a catalog row, with `qtyRequested` set and `totalCost` reflecting the full order value.

---

#### `POST /supply/order`

Places a purchase order. Stock is deducted immediately. Returns `201 Created` with the full order on success, `422` if stock is insufficient or qty violates vendor min/max.

**Request body:**

```json
{
  "vendorId": "1650",
  "productId": 316,
  "qty": 10
}
```

**Response `201 Created`:**

```json
{
  "orderId": "4215",
  "vendorId": "1650",
  "vendorName": "American Bicycles and Wheels",
  "productId": 316,
  "productName": "Blade",
  "qty": 10,
  "unitCost": 28.17,
  "shippingCost": 23.89,
  "totalCost": 305.59,
  "status": "pending",
  "placedAtUtc": "2026-04-08T14:55:47Z",
  "estimatedDeliveryUtc": "2026-04-22T14:55:47Z"
}
```

**Error `422 Unprocessable Entity`:**

```json
{ "error": "Insufficient stock. Available: 3, requested: 10." }
```

```json
{ "error": "Quantity 500 exceeds vendor maximum order quantity of 150." }
```

#### Order Status Values

| Status     | `PurchaseOrderHeader.Status` | Meaning                                              |
| ---------- | ---------------------------- | ---------------------------------------------------- |
| `pending`  | `1`                          | Order received, stock reserved, awaiting approval    |
| `approved` | `2`                          | Confirmed; delivery clock running (vendor lead time) |
| `complete` | `4`                          | Delivered; SQL inventory updated                     |
| `rejected` | `3`                          | Reliability failure or cancelled by operator         |

---

#### `GET /supply/orders`

Returns all **active** orders (`pending` and `approved` only — excludes `complete` and `rejected`). Poll this every few seconds for a live orders board.

Response is an array of order objects (same shape as POST response).

---

#### `GET /supply/orders/history`

Returns all orders including completed and cancelled. Sorted newest first.

---

#### `GET /supply/order/{orderId}`

Returns a single order by its ID (the SQL `PurchaseOrderID` as a string). Includes the full `trackingEvents` array, which grows as the order progresses.

`orderId` is case-insensitive.

---

#### `DELETE /supply/order/{orderId}`

Cancels an order. Only works when `status` is `pending`. Stock is returned to the vendor immediately.

**Optional request body:**

```json
{ "reason": "Wrong product selected" }
```

**Response `200 OK`:**

```json
{
  "message": "Order 4215 cancelled.",
  "reason": "Wrong product selected"
}
```

**Error `422`** if the order is not in `pending` status or does not exist.

---

#### `POST /supply/restock/{vendorId}`

Immediately restocks a vendor's inventory to maximum levels. Optionally scope to one product:

```json
{ "productId": 316 }
```

Omit the body (or set `productId: 0`) to restock all components for this vendor.

**Response `200 OK`:**

```json
{ "message": "Restocked all components for 1650." }
```

**Use this in the UI** as a "Restock Now" button on the vendor detail view for demo resets.

---

#### `DELETE /supply/reset`

Wipes all orders, tracking events, and stock, then re-seeds stock at randomised initial levels from `ProductVendor` data. Vendor definitions are reloaded from SQL.

```json
{ "message": "Supply chain simulation reset. Vendor stock re-seeded." }
```

---

### UI Scenarios

#### Scenario: Vendor comparison — sourcing a component

```javascript
// Show all vendor offers for a component, sorted cheapest first
const offers = await fetch(`/api/supply/catalog/${productId}`).then((r) =>
  r.json(),
);
// offers[].vendorName, unitCost, shippingCost, totalCost, stockAvailable,
// leadTimeDays, reliabilityPct, minOrderQty, maxOrderQty, inStock
```

#### Scenario: Get a quote before ordering

```javascript
const quote = await fetch(
  `/api/supply/quote?vendorId=1650&productId=${productId}&qty=${qty}`,
).then((r) => r.json());
// quote.totalCost, quote.inStock, quote.estimatedDeliveryRealMins
```

#### Scenario: Place an order and track it

```javascript
// 1. Place order (vendorId is the numeric BusinessEntityID as a string)
const order = await fetch("/api/supply/order", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ vendorId: "1650", productId: 316, qty: 10 }),
}).then((r) => r.json());

// order.orderId, order.status, order.estimatedDeliveryUtc

// 2. Poll for status updates
setInterval(async () => {
  const updated = await fetch(`/api/supply/order/${order.orderId}`).then((r) =>
    r.json(),
  );
  // updated.status ("pending" | "approved" | "complete" | "rejected")
}, 5000);
```

#### Scenario: Live active orders board

```javascript
// Poll every 3 seconds for orders board
setInterval(async () => {
  const active = await fetch("/api/supply/orders").then((r) => r.json());
  // active[].orderId, vendorName, productName, qty, status, estimatedDeliveryUtc
  // active[].orderId — IS the SQL PurchaseOrderID; use directly to link to Purchasing.PurchaseOrderHeader via GraphQL
}, 3000);
```

#### Scenario: Show stock availability including in-transit units

```javascript
// Catalog rows include both what you can still order AND what is already coming
const offers = await fetch(`/api/supply/catalog/${productId}`).then((r) =>
  r.json(),
);
offers.forEach((offer) => {
  const label =
    offer.stockAvailable > 0
      ? `${offer.stockAvailable} available`
      : "Out of stock";
  const incoming =
    offer.incomingQty > 0 ? ` · ${offer.incomingQty} incoming` : "";
  console.log(`${offer.vendorName}: ${label}${incoming}`);
  // e.g. "American Bicycles and Wheels: 70 available · 10 incoming"
});
```

#### Scenario: Link a simulator order to the GraphQL PO record

```javascript
// orderId IS the SQL PurchaseOrderID — use it directly to query via DAB
const order = await fetch("/api/supply/order", { method: "POST", ... }).then(r => r.json());
const poRecord = await fetch(
  `/graphql`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query {
        purchaseOrderHeader_by_pk(PurchaseOrderID: ${order.orderId}) {
          PurchaseOrderID Status VendorID OrderDate ShipDate SubTotal TaxAmt Freight TotalDue
        }
      }`
    })
  }
).then(r => r.json());
// poRecord.data.purchaseOrderHeader_by_pk.Status: 1=Pending 2=Approved 3=Rejected 4=Complete
```

#### Scenario: Dashboard — vendor health at a glance

```javascript
const vendors = await fetch("/api/supply/vendors").then((r) => r.json());
// vendors[].vendor.name, vendor.creditRating, vendor.reliabilityPct,
// inStockComponents, activeOrders, deliveredToday
```

#### Scenario: Cancel an in-flight order

```javascript
const result = await fetch(`/api/supply/order/${orderId}`, {
  method: "DELETE",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ reason: "Found cheaper alternative" }),
}).then((r) => r.json());
// result.message or result.error (if past confirmed)
```

#### Scenario: Reset simulation for a fresh demo

```javascript
await fetch("/api/supply/reset", { method: "DELETE" });
// All orders cleared, stock re-seeded from Purchasing.ProductVendor
```

---

### Data Shape Reference

#### `VendorSummary` (from `GET /supply/vendors`)

```typescript
interface VendorSummary {
  vendor: {
    vendorId: string; // Purchasing.Vendor.BusinessEntityID as string
    accountNumber: string; // e.g. "AMERICANBE0001"
    name: string; // Purchasing.Vendor.Name
    description: string; // derived from CreditRating
    creditRating: number; // 1–5 (1 = best)
    preferredVendorStatus: boolean;
    defaultLeadTimeDays: number; // avg across ProductVendor.AverageLeadTime
    reliabilityPct: number; // 0–1 derived from creditRating
    shipMethodId: number;
    shipMethodName: string; // e.g. "CARGO TRANSPORT 5"
    shipBase: number; // Purchasing.ShipMethod.ShipBase
    shipRate: number; // Purchasing.ShipMethod.ShipRate (per unit × weight)
    restockDelaySimHrs: number; // derived from creditRating
    strengths: string[];
    weaknesses: string[];
  };
  totalComponents: number;
  inStockComponents: number;
  activeOrders: number;
  deliveredToday: number;
}
```

#### `SupplyQuote` (from `GET /supply/catalog` and `GET /supply/quote`)

```typescript
interface SupplyQuote {
  vendorId: string;
  vendorName: string;
  productId: number;
  productName: string;
  qtyRequested: number;
  stockAvailable: number; // remaining vendor stock AFTER deducting all in-flight orders
  unitCost: number; // Purchasing.ProductVendor.StandardPrice
  shippingCost: number; // shipBase + (weightKg × shipRate × qty)
  totalCost: number;
  leadTimeDays: number; // ProductVendor.AverageLeadTime for this item
  minOrderQty: number; // ProductVendor.MinOrderQty
  maxOrderQty: number; // ProductVendor.MaxOrderQty
  reliabilityPct: number;
  estimatedDeliverySimHrs: number; // simulated hours until delivery
  estimatedDeliveryRealMins: number; // real wall-clock minutes at current SIMULATION_TIME_SCALE_FACTOR
  inStock: boolean;
  incomingQty: number; // units on open orders in transit to our warehouse (pending/approved)
}
```

#### `PurchaseOrder` (from all order endpoints)

```typescript
interface PurchaseOrder {
  orderId: string; // SQL PurchaseOrderHeader.PurchaseOrderID as string — use directly for GraphQL lookups
  vendorId: string;
  vendorName: string;
  productId: number;
  productName: string;
  qty: number;
  unitCost: number;
  shippingCost: number;
  totalCost: number;
  status: "pending" | "approved" | "complete" | "rejected";
  placedAtUtc: string; // ISO 8601
  estimatedDeliveryUtc: string; // ISO 8601; sourced from PurchaseOrderDetail.DueDate
}
```

> **Transition audit trail:** State transitions are emitted as Application Insights custom events (`SupplyChainOrder`) with properties `PurchaseOrderId`, `EventType`, and `Description`. Use the App Insights Logs blade or `az monitor app-insights query` to retrieve them.

```

---

## Workforce Simulation

The manufacturing simulation integrates with `HumanResources` tables to populate production locations with real AdventureWorks employees. This adds operator-level detail to work order processing: labor cost calculations, tenure-based quality risk, and shift-aware availability.

---

### How It Works

#### Employee Loading

On first access, the service queries all currently-active employees in Manufacturing-group departments (`GroupName = 'Manufacturing'`) from:

- `HumanResources.Employee` — job title, hire date, vacation/sick leave hours
- `Person.Person` — full name
- `HumanResources.EmployeeDepartmentHistory` (current, `EndDate IS NULL`) — department and shift assignment
- `HumanResources.Department` — department name and group
- `HumanResources.Shift` — shift name, start time, end time
- `HumanResources.EmployeePayHistory` (most recent rate) — current hourly rate

Manufacturing departments include **Production** (DeptID 7) and **Production Control** (DeptID 8), covering approximately **185 employees** across three shifts.

#### Location Assignment

Workers are distributed deterministically across the 7 simulation locations using round-robin by employee order:

| LocationID | Name              |
| ---------- | ----------------- |
| 10         | Frame Forming     |
| 20         | Frame Welding     |
| 30         | Debur and Polish  |
| 40         | Paint             |
| 45         | Specialized Paint |
| 50         | Subassembly       |
| 60         | Final Assembly    |

Each location typically receives ~26–27 workers.

#### Scrap Rate Multiplier

Worker tenure affects the local scrap/failure probability. The multiplier is applied to a station's base `failureRatePct` when that worker is the assigned operator:

```

scrapRateMultiplier = max(0.5, 1.0 - tenureYears / 20.0)

````

| Tenure    | Multiplier | Effect on base 5% scrap rate |
| --------- | ---------- | ---------------------------- |
| 0 years   | ×1.0       | 5.0% (no reduction)          |
| 10 years  | ×0.5       | 2.5% (50% reduction, cap)    |
| 20+ years | ×0.5       | 2.5% (capped)                |

#### Shift-Aware Availability

Workers are only considered `available` during their assigned shift window. Workers outside their shift window show as `off-shift` and cannot be assigned to operations. Workers with zero vacation hours accrued show as `unavailable`.

| Status        | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `available`   | On shift, not assigned to a work order                                                  |
| `working`     | Currently assigned to an active routing operation                                       |
| `off-shift`   | Outside their shift window (Day: 07:00–15:00, Evening: 15:00–23:00, Night: 23:00–07:00) |
| `unavailable` | VacationHours ≤ 0 (over-rostered)                                                       |

---

### API Reference

Base: `{API_FUNCTIONS_URL}/api/manufacturing`

#### `GET /manufacturing/workforce`

Returns a headcount summary across all manufacturing locations.

**Response `200 OK`:**

```json
{
  "totalActiveWorkers": 185,
  "currentlyWorking": 12,
  "availableNow": 48,
  "offShift": 124,
  "unavailable": 1,
  "byLocation": [
    {
      "locationId": 10,
      "locationName": "Frame Forming",
      "headcount": 27,
      "available": 7,
      "working": 2,
      "offShift": 18
    }
  ]
}
````

---

#### `GET /manufacturing/workforce/detail`

Returns all workers with individual status, current assignment, pay rate, and tenure. Results are sorted by location, then shift, then tenure descending (most experienced first).

**Response `200 OK` (array):**

```json
[
  {
    "employeeId": 5,
    "name": "Thierry D'Hers",
    "jobTitle": "Production Supervisor - WC60",
    "locationId": 60,
    "locationName": "Final Assembly",
    "shiftId": 1,
    "shiftName": "Day",
    "status": "available",
    "currentWorkOrderId": null,
    "currentOperation": null,
    "hourlyRate": 25.0,
    "tenureYears": 17.3,
    "scrapRateMultiplier": 0.5
  }
]
```

| Field                 | Source                                                           |
| --------------------- | ---------------------------------------------------------------- |
| `employeeId`          | `HumanResources.Employee.BusinessEntityID`                       |
| `jobTitle`            | `HumanResources.Employee.JobTitle`                               |
| `hourlyRate`          | `HumanResources.EmployeePayHistory.Rate` (most recent)           |
| `tenureYears`         | Calculated from `HireDate` to today                              |
| `scrapRateMultiplier` | `max(0.5, 1.0 - tenureYears/20.0)`                               |
| `status`              | Derived at query time — respects shift window and vacation hours |

---

### Data Shape Reference

#### `WorkforceSnapshot` (from `GET /manufacturing/workforce`)

```typescript
interface WorkforceSnapshot {
  totalActiveWorkers: number;
  currentlyWorking: number;
  availableNow: number;
  offShift: number;
  unavailable: number;
  byLocation: LocationWorkforce[];
}

interface LocationWorkforce {
  locationId: number;
  locationName: string;
  headcount: number;
  available: number;
  working: number;
  offShift: number;
}
```

#### `WorkerStatus` (from `GET /manufacturing/workforce/detail`)

```typescript
interface WorkerStatus {
  employeeId: number;
  name: string;
  jobTitle: string;
  locationId: number;
  locationName: string;
  shiftId: number;
  shiftName: string;
  status: "available" | "working" | "off-shift" | "unavailable";
  currentWorkOrderId: number | null;
  currentOperation: string | null;
  hourlyRate: number;
  tenureYears: number;
  scrapRateMultiplier: number;
}
```

#### `VendorQualityData` (from `GET /manufacturing/vendor-quality` and `GET /manufacturing/vendor-quality/{vendorId}`)

```typescript
interface VendorQualityData {
  vendorId: number; // Purchasing.Vendor.BusinessEntityID
  vendorName: string;
  totalScrapEvents: number;
  totalFailures: number; // events where isTotalFailure = true
  affectedWorkOrders: number; // distinct work order count
  mostRecentEventUtc: string; // ISO 8601
  components: VendorQualityComponentData[];
}

interface VendorQualityComponentData {
  componentProductId: number;
  componentName: string;
  scrapEvents: number;
  totalFailures: number;
}
```

#### `ScrapEventData` (from `GET /manufacturing/scrap-events` and `GET /manufacturing/status`)

```typescript
interface ScrapEventData {
  workOrderId: number | string;
  productId: number;
  productName: string;
  locationId: number;
  locationName: string;
  scrapReasonId: number;
  scrapReasonName: string;
  scrappedQty: number;
  isTotalFailure: boolean;
  failedAtUtc: string; // ISO 8601
  supplierVendorId: number | null; // null for process-quality scrap reasons
  supplierVendorName: string | null;
  supplierComponentProductId: number | null;
  supplierComponentName: string | null;
}
```

---

## Manufacturing Planning & Intelligence APIs

A set of read-only analytical endpoints that turn the live AdventureWorks data into actionable planning insights. These APIs are designed to power a planning dashboard in the admin UI, answering questions like:

- **How many more Mountain Bikes could we make right now?** (component feasibility)
- **Which products are gathering dust in the warehouse?** (overstock / sale candidates)
- **Which products are cheapest to make but priced too low?** (margin / price increase analysis)
- **Which components will we run out of first as sales continue?** (shortage forecast)
- **What should we buy, from whom, and how much will it cost?** (reorder recommendations)

All endpoints are under `/api/plan/`. They are read-only — no writes to the database.

Base URL: `{API_FUNCTIONS_URL}/api/plan`

---

### API Overview

| Method | Route                                   | Purpose                                                          |
| ------ | --------------------------------------- | ---------------------------------------------------------------- |
| `GET`  | `plan/feasibility/{productId}?qty={n}`  | How many units can be built right now?                           |
| `GET`  | `plan/feasibility?qty={n}`              | Feasibility snapshot for all finished goods                      |
| `GET`  | `plan/cost/{productId}`                 | Full BOM + routing cost breakdown and margin                     |
| `GET`  | `plan/cost/{productId}/current`         | **Accurate current manufacturing cost using ProductCostHistory** |
| `GET`  | `plan/catalog`                          | All finished goods with cost, margin, stock, sales signals       |
| `GET`  | `plan/overstock?minWeeks={n}`           | High-stock products → sale candidates                            |
| `GET`  | `plan/thin-margin?maxMarginPct={n}`     | Low-margin products → price increase candidates                  |
| `GET`  | `plan/shortage-forecast?days={n}`       | Which components run out first?                                  |
| `GET`  | `plan/reorder-recommendations?days={n}` | What to buy, from whom, at what cost                             |

---

### `GET /plan/feasibility/{productId}?qty={n}`

For a given manufactured finished good, calculates the **maximum number of units producible** from current component inventory. Also shows the bottleneck component and — if `withProcurement=true` (default) — factors in in-flight supply orders.

**Query parameters:**

| Parameter         | Default | Description                                                    |
| ----------------- | ------- | -------------------------------------------------------------- |
| `qty`             | `1`     | Target production quantity to check                            |
| `withProcurement` | `true`  | Include pending supply orders in the "with procurement" figure |

**Response:**

```json
{
  "productId": 749,
  "name": "Mountain-100 Black, 38",
  "requestedQty": 5,
  "maxProducibleNow": 7,
  "maxProducibleWithProcurement": 12,
  "procurementCostToMeetRequest": 0.0,
  "bottleneckComponentName": "Bearing Ball",
  "components": [
    {
      "productId": 2,
      "name": "Bearing Ball",
      "requiredPerUnit": 100.0,
      "requiredForQty": 500,
      "currentStock": 709,
      "canSupportUnits": 7,
      "shortfallForQty": 0,
      "isBottleneck": true
    }
  ]
}
```

| Field                          | Description                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `maxProducibleNow`             | Units achievable from current `Production.ProductInventory` only             |
| `maxProducibleWithProcurement` | Units achievable including stock in pending/approved supply orders           |
| `procurementCostToMeetRequest` | Estimated cheapest-vendor cost to cover any shortfall to meet `requestedQty` |
| `bottleneckComponentName`      | The component limiting production — lowest `canSupportUnits`                 |
| `components[].canSupportUnits` | `floor(currentStock / requiredPerUnit)`                                      |
| `components[].isBottleneck`    | `true` for the single constraining component                                 |

Returns `404` for non-existent products or products where `MakeFlag=0` or `FinishedGoodsFlag=0`.

---

### `GET /plan/feasibility?qty={n}`

Returns the feasibility summary for **every** manufactured finished good in a single call. Designed for a product grid view. Each row includes `maxProducibleNow` and a `canMeetRequest` flag against the requested qty.

```json
[
  {
    "productId": 749,
    "name": "Mountain-100 Black, 38",
    "productNumber": "BK-M82B-38",
    "listPrice": 3399.99,
    "currentStockQty": 4,
    "maxProducibleNow": 7,
    "canMeetRequest": true,
    "inventorySignal": "healthy",
    "pricingSignal": "healthy",
    "salesLast30Days": 3,
    "weeksOfSupply": 2.5
  }
]
```

---

### `GET /plan/cost/{productId}`

Full cost breakdown for a single product: every BOM component with its `requiredPerUnit × standardCost`, plus average routing labour from historical work orders.

```json
{
  "productId": 749,
  "productName": "Mountain-100 Black, 38",
  "listPrice": 3399.99,
  "materialCost": 2048.83,
  "routingCost": 49.0,
  "estimatedCogs": 2097.83,
  "grossMarginPct": 0.3832,
  "pricingSignal": "healthy",
  "bomLines": [
    {
      "productId": 316,
      "name": "Blade",
      "requiredPerUnit": 1.0,
      "standardCost": 63.5,
      "costContribution": 63.5,
      "isPurchased": true
    },
    {
      "productId": 517,
      "name": "HL Mountain Frame - Black, 38",
      "requiredPerUnit": 1.0,
      "standardCost": 1059.31,
      "costContribution": 1059.31,
      "isPurchased": false
    }
  ]
}
```

| `pricingSignal` | Meaning                          |
| --------------- | -------------------------------- |
| `healthy`       | Gross margin ≥ 15%               |
| `thin-margin`   | Gross margin 0–15%               |
| `loss-making`   | Estimated COGS > list price      |
| `no-price`      | `ListPrice = 0` (not yet priced) |

> **Note on gross margin:** `materialCost` uses `Production.Product.StandardCost` for each BOM component. `routingCost` is the average total actual cost from the last 10 completed work orders for this product (falls back to 0 if none exist).

---

### `GET /plan/cost/{productId}/current`

**Returns the accurate current manufacturing cost** using real-time component costs from the supply chain simulation. This endpoint provides the most accurate costing by using:

1. **`Production.ProductCostHistory`** - Latest cost entries recorded when components are purchased from vendors
2. **`Purchasing.ProductVendor.LastReceiptCost`** - Fallback to most recent vendor receipt cost
3. **`Production.Product.StandardCost`** - Final fallback for components without cost history

This endpoint is ideal for **real-time costing dashboards** and shows exactly which cost source was used for each component.

**Example Response:**

```json
{
  "productId": 749,
  "productName": "Mountain-100 Black, 38",
  "listPrice": 3399.99,
  "currentMaterialCost": 2153.47,
  "estimatedRoutingCost": 49.0,
  "totalManufacturingCost": 2202.47,
  "grossMarginPct": 0.3521,
  "pricingSignal": "healthy",
  "costAsOf": "2026-04-09T18:30:00Z",
  "bomBreakdown": [
    {
      "productId": 316,
      "name": "Blade",
      "requiredPerUnit": 1.0,
      "currentCost": 67.85,
      "costDate": "2026-04-09T14:22:00Z",
      "costContribution": 67.85,
      "isPurchased": true,
      "costSource": "ProductCostHistory"
    },
    {
      "productId": 2,
      "name": "Bearing Ball",
      "requiredPerUnit": 100.0,
      "currentCost": 0.21,
      "costDate": "2026-04-08T09:15:00Z",
      "costContribution": 21.0,
      "isPurchased": true,
      "costSource": "ProductVendor.LastReceiptCost"
    },
    {
      "productId": 517,
      "name": "HL Mountain Frame - Black, 38",
      "requiredPerUnit": 1.0,
      "currentCost": 1059.31,
      "costDate": null,
      "costContribution": 1059.31,
      "isPurchased": false,
      "costSource": "Product.StandardCost"
    }
  ]
}
```

**Response Fields:**

| Field                       | Description                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `currentMaterialCost`       | Sum of all BOM component costs using latest available cost data                                                 |
| `estimatedRoutingCost`      | Average routing cost from last 10 completed work orders                                                         |
| `totalManufacturingCost`    | `currentMaterialCost + estimatedRoutingCost`                                                                    |
| `costAsOf`                  | Timestamp when the cost calculation was performed                                                               |
| `bomBreakdown[].costDate`   | When this cost was recorded (null for Product.StandardCost fallback)                                            |
| `bomBreakdown[].costSource` | Which table provided the cost: `ProductCostHistory`, `ProductVendor.LastReceiptCost`, or `Product.StandardCost` |

**Key Differences from `/plan/cost/{productId}`:**

- `/plan/cost/{productId}` uses static `Product.StandardCost` for all components
- `/plan/cost/{productId}/current` uses **live cost history** from vendor purchases recorded by the supply chain simulation
- This endpoint reflects **actual market prices** as components are purchased from vendors
- Cost attribution shows exactly where each price came from for full transparency

**Use Cases:**

- Real-time manufacturing cost monitoring dashboards
- Detecting when component price changes affect product profitability
- Validating that supply chain purchases are being recorded correctly
- Comparing planned vs. actual manufacturing costs

Returns `404` for non-existent products or products where `MakeFlag=0` or `FinishedGoodsFlag=0`.

---

### `GET /plan/catalog`

Returns all manufactured finished goods with their full planning snapshot. Supports optional filtering.

**Query parameters:**

| Parameter         | Values                                                    | Description                  |
| ----------------- | --------------------------------------------------------- | ---------------------------- |
| `inventorySignal` | `overstock` \| `healthy` \| `low-stock` \| `out-of-stock` | Filter by stock level signal |
| `pricingSignal`   | `healthy` \| `thin-margin` \| `loss-making` \| `no-price` | Filter by margin signal      |

```json
[
  {
    "productId": 749,
    "name": "Mountain-100 Black, 38",
    "productNumber": "BK-M82B-38",
    "listPrice": 3399.99,
    "estimatedCogs": 868.63,
    "grossMarginPct": 0.3932,
    "pricingSignal": "healthy",
    "currentStockQty": 4,
    "salesLast30Days": 3.0,
    "weeksOfSupply": 2.5,
    "inventorySignal": "healthy",
    "maxProducibleNow": 7
  }
]
```

| `inventorySignal` | Meaning               |
| ----------------- | --------------------- |
| `out-of-stock`    | `currentStockQty = 0` |
| `low-stock`       | Weeks of supply < 2   |
| `healthy`         | 2–12 weeks of supply  |
| `overstock`       | Weeks of supply > 12  |

`weeksOfSupply = -1` means zero sales in the last 30 days (cannot calculate a finite figure).

---

### `GET /plan/overstock?minWeeks={n}`

Returns finished goods with finished goods inventory above the weeks-of-supply threshold. These are **candidates for promotion or discount in the eShop**.

**Default threshold:** 12 weeks.

```json
{
  "thresholdWeeksOfSupply": 12,
  "count": 69,
  "signal": "These products have high inventory relative to sales velocity. Consider discounting in the eShop.",
  "items": [ ... ]
}
```

Each item has the same shape as a catalog row (see above). Sort by `weeksOfSupply` descending to find the most overstocked items first.

---

### `GET /plan/thin-margin?maxMarginPct={n}`

Returns finished goods where estimated gross margin is below the threshold. These are **candidates for a list price increase in the eShop**.

**Default threshold:** 20% (`maxMarginPct=0.20`).

```json
{
  "thresholdMarginPct": 0.20,
  "count": 12,
  "signal": "These products have thin or negative margins. Consider increasing the eShop list price.",
  "items": [ ... ]
}
```

Items are sorted by `grossMarginPct` ascending (worst margin first).

---

### `GET /plan/shortage-forecast?days={n}`

Forecasts which **purchased components** (raw materials) will run out first, given current 30-day sales velocity applied to BOM requirements.

**Default window:** 90 days.

```json
{
  "forecastDays": 90,
  "critical": 2,
  "warning": 5,
  "watch": 11,
  "items": [
    {
      "componentProductId": 316,
      "componentName": "Blade",
      "currentStock": 423,
      "dailyConsumptionRate": 8.23,
      "daysUntilStockout": 51.4,
      "weeksUntilStockout": 7.3,
      "urgencyLevel": "warning",
      "affectedProducts": [
        {
          "productId": 749,
          "name": "Mountain-100 Black, 38",
          "requiredPerUnit": 1.0,
          "dailySalesRate": 0.1
        }
      ]
    }
  ]
}
```

| `urgencyLevel` | Days until stockout                                       |
| -------------- | --------------------------------------------------------- |
| `critical`     | < 7 days                                                  |
| `warning`      | 7–30 days                                                 |
| `watch`        | 30–60 days                                                |
| `ok`           | ≥ 60 days (only returned when inside forecastDays window) |

`dailyConsumptionRate` is the aggregate across all finished goods that use this component:

```
sum over all finished goods( productDailySalesRate × componentRequiredPerUnit )
```

`affectedProducts` lists the finished goods that consume this component, sorted by highest daily impact first.

> **Note on AdventureWorks data:** The included AdventureWorks dataset has historical sales data that may not reflect high-velocity recent sales. If `items` is empty, there are no components forecast to run out within the window (all components have adequate stock vs the current 30-day rolling sales rate). To test this feature with the simulation, run the manufacturing simulation to deplete component inventory, then re-query.

---

### `GET /plan/reorder-recommendations?days={n}`

For every component with a forecast stockout within `days` days, generates a reorder recommendation that cross-references the supply chain vendor catalog — showing the **best vendor** to buy from and all alternatives with full pricing.

**Default window:** 60 days.

```json
{
  "forecastDays": 60,
  "totalRecommendations": 8,
  "estimatedTotalProcurementCost": 4821.50,
  "items": [
    {
      "componentProductId": 316,
      "componentName": "Blade",
      "currentStock": 423,
      "daysUntilStockout": 51.4,
      "urgencyLevel": "watch",
      "suggestedOrderQty": 247,
      "bestVendor": {
        "vendorId": "oceanship",
        "vendorName": "OceanShip International",
        "stockAvailable": 800,
        "canFulfillOrder": true,
        "unitCost": 45.72,
        "totalCost": 11293.84,
        "estimatedDeliveryRealMins": 96.0,
        "reliabilityPct": 0.75,
        "leadTimeDays": 4
      },
      "allVendors": [
        {
          "vendorId": "oceanship",
          "vendorName": "OceanShip International",
          ...
        },
        {
          "vendorId": "budgetbolt",
          "vendorName": "BudgetBolt Co",
          ...
        }
      ]
    }
  ]
}
```

| Field               | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `suggestedOrderQty` | 30-day supply: `ceil(dailyConsumptionRate × 30)`                                                              |
| `bestVendor`        | Cheapest vendor that can fulfil the full `suggestedOrderQty`; falls back to cheapest if none can fully fulfil |
| `allVendors`        | All 5 vendors sorted by `totalCost` ascending                                                                 |
| `canFulfillOrder`   | `stockAvailable >= suggestedOrderQty`                                                                         |
| `totalCost`         | `unitCost × suggestedOrderQty + shippingCost` (shippingCost is per-order flat rate + weight)                  |

> Use `bestVendor.estimatedDeliveryRealMins` to show "arrives in X minutes" in the UI (at current `SIMULATION_TIME_SCALE_FACTOR`). Multiply by the vendor's `reliabilityPct` to surface risk.

---

### TypeScript Interfaces

```typescript
// GET /plan/feasibility/{productId}
interface FeasibilityResult {
  productId: number;
  name: string;
  requestedQty: number;
  maxProducibleNow: number; // -1 = no purchased components (unlimited)
  maxProducibleWithProcurement: number;
  procurementCostToMeetRequest: number;
  bottleneckComponentName: string | null;
  components: FeasibilityComponent[];
}

interface FeasibilityComponent {
  productId: number;
  name: string;
  requiredPerUnit: number;
  requiredForQty: number;
  currentStock: number;
  canSupportUnits: number;
  shortfallForQty: number;
  isBottleneck: boolean;
}

// GET /plan/catalog, /plan/overstock, /plan/thin-margin, /plan/feasibility (all)
interface FinishedGoodSnapshot {
  productId: number;
  name: string;
  productNumber: string | null;
  listPrice: number;
  estimatedCogs: number;
  grossMarginPct: number; // 0–1; negative = loss-making
  pricingSignal: "healthy" | "thin-margin" | "loss-making" | "no-price";
  currentStockQty: number;
  salesLast30Days: number;
  weeksOfSupply: number; // -1 = no recent sales
  inventorySignal: "healthy" | "overstock" | "low-stock" | "out-of-stock";
  maxProducibleNow: number; // -1 = not inventory-constrained
}

// GET /plan/cost/{productId}
interface CostAnalysis {
  productId: number;
  productName: string;
  listPrice: number;
  materialCost: number;
  routingCost: number;
  estimatedCogs: number;
  grossMarginPct: number;
  pricingSignal: string;
  bomLines: BomCostLine[];
}

interface BomCostLine {
  productId: number;
  name: string;
  requiredPerUnit: number;
  standardCost: number;
  costContribution: number; // requiredPerUnit × standardCost
  isPurchased: boolean; // false = sub-assembled in-house
}

// GET /plan/cost/{productId}/current
interface CurrentManufacturingCost {
  productId: number;
  productName: string;
  listPrice: number;
  currentMaterialCost: number; // sum using ProductCostHistory
  estimatedRoutingCost: number;
  totalManufacturingCost: number; // currentMaterialCost + estimatedRoutingCost
  grossMarginPct: number;
  pricingSignal: "healthy" | "thin-margin" | "loss-making" | "no-price";
  costAsOf: string; // ISO 8601 timestamp
  bomBreakdown: CurrentCostBomLine[];
}

interface CurrentCostBomLine {
  productId: number;
  name: string;
  requiredPerUnit: number;
  currentCost: number; // from ProductCostHistory, ProductVendor, or Product.StandardCost
  costDate: string | null; // ISO 8601 timestamp or null for StandardCost fallback
  costContribution: number; // requiredPerUnit × currentCost
  isPurchased: boolean;
  costSource:
    | "ProductCostHistory"
    | "ProductVendor.LastReceiptCost"
    | "Product.StandardCost";
}

// GET /plan/shortage-forecast
interface ShortageforecastResponse {
  forecastDays: number;
  critical: number;
  warning: number;
  watch: number;
  items: ComponentShortage[];
}

interface ComponentShortage {
  componentProductId: number;
  componentName: string;
  currentStock: number;
  dailyConsumptionRate: number;
  daysUntilStockout: number;
  weeksUntilStockout: number;
  urgencyLevel: "critical" | "warning" | "watch" | "ok";
  affectedProducts: AffectedFinishedGood[];
}

interface AffectedFinishedGood {
  productId: number;
  name: string;
  requiredPerUnit: number;
  dailySalesRate: number;
}

// GET /plan/reorder-recommendations
interface ReorderRecommendationsResponse {
  forecastDays: number;
  totalRecommendations: number;
  estimatedTotalProcurementCost: number;
  items: ReorderRecommendation[];
}

interface ReorderRecommendation {
  componentProductId: number;
  componentName: string;
  currentStock: number;
  daysUntilStockout: number;
  urgencyLevel: string;
  suggestedOrderQty: number;
  bestVendor: ReorderVendorOption | null;
  allVendors: ReorderVendorOption[];
}

interface ReorderVendorOption {
  vendorId: string;
  vendorName: string;
  stockAvailable: number;
  canFulfillOrder: boolean;
  unitCost: number;
  totalCost: number;
  estimatedDeliveryRealMins: number;
  reliabilityPct: number;
  leadTimeDays: number;
}
```

---

### UI Scenarios

#### Scenario: "How many more bikes can we make?" — production planning grid

```javascript
// All products with feasibility in one call, check against target qty
const feasibility = await fetch("/api/plan/feasibility?qty=10").then((r) =>
  r.json(),
);
// feasibility[].name, maxProducibleNow, canMeetRequest, inventorySignal, weeksOfSupply
// Highlight canMeetRequest=false in red; show bottleneck via /plan/feasibility/{id}?qty=10
```

#### Scenario: Drill into a specific product's production constraint

```javascript
const result = await fetch(`/api/plan/feasibility/${productId}?qty=20`).then(
  (r) => r.json(),
);
// result.bottleneckComponentName — show prominently
// result.components sorted by canSupportUnits ascending — show as stacked bar
// result.procurementCostToMeetRequest — "order missing stock for $X"
```

#### Scenario: Sale candidates dashboard

```javascript
const overstock = await fetch("/api/plan/overstock?minWeeks=8").then((r) =>
  r.json(),
);
// overstock.items sorted by weeksOfSupply descending
// For each: name, currentStockQty, salesLast30Days, weeksOfSupply → "X weeks of stock, only Y sold last month"
// Action button: "Put on Sale" → use eShop discount API
```

#### Scenario: Price increase recommendations

```javascript
const thinMargin = await fetch("/api/plan/thin-margin?maxMarginPct=0.25").then(
  (r) => r.json(),
);
// thinMargin.items sorted by grossMarginPct ascending (worst first)
// For each: name, listPrice, estimatedCogs, grossMarginPct → "costs $X to make, selling for $Y (Z% margin)"
// Drill into: GET /plan/cost/{productId} for the full BOM breakdown
```

#### Scenario: Component shortage alert bar

```javascript
// Poll every 5 minutes for urgency indicators
const forecast = await fetch("/api/plan/shortage-forecast?days=30").then((r) =>
  r.json(),
);
// forecast.critical — show red badge if > 0
// forecast.warning — show amber badge
// forecast.items[0] — "CRITICAL: Blade runs out in 6 days"
```

#### Scenario: One-click reorder workflow

```javascript
// Get recommendations
const recs = await fetch("/api/plan/reorder-recommendations?days=60").then(
  (r) => r.json(),
);
// recs.estimatedTotalProcurementCost — "Restock 8 components for $4,821"

// For each recommendation, place a supply order:
for (const rec of recs.items) {
  if (rec.bestVendor?.canFulfillOrder) {
    await fetch("/api/supply/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendorId: rec.bestVendor.vendorId,
        productId: rec.componentProductId,
        qty: rec.suggestedOrderQty,
      }),
    });
  }
}
```

#### Scenario: Full cost breakdown drill-down

```javascript
const cost = await fetch(`/api/plan/cost/${productId}`).then((r) => r.json());
// cost.materialCost, routingCost, estimatedCogs, grossMarginPct, pricingSignal
// cost.bomLines — waterfall chart: each component's costContribution
// cost.bomLines.filter(b => b.isPurchased) — "purchased material costs"
// cost.bomLines.filter(b => !b.isPurchased) — "in-house sub-assembly costs"
```

#### Scenario: Real-time accurate manufacturing cost monitoring

```javascript
// Get current manufacturing cost using live vendor purchase prices
const currentCost = await fetch(`/api/plan/cost/${productId}/current`).then(
  (r) => r.json(),
);
// currentCost.totalManufacturingCost — accurate cost using ProductCostHistory
// currentCost.costAsOf — timestamp of calculation
// currentCost.bomBreakdown — detailed breakdown with cost source attribution

// Show cost change alert if price increased significantly
const historicalCost = 2097.83; // from /plan/cost/{productId}
const currentTotal = currentCost.totalManufacturingCost;
const percentChange = ((currentTotal - historicalCost) / historicalCost) * 100;

if (percentChange > 5) {
  console.log(
    `⚠️ Manufacturing cost increased ${percentChange.toFixed(1)}% from vendor price changes`,
  );

  // Identify which components drove the increase
  const priceIncreases = currentCost.bomBreakdown
    .filter((b) => b.costSource === "ProductCostHistory")
    .map((b) => ({
      component: b.name,
      currentCost: b.currentCost,
      costDate: b.costDate,
      contribution: b.costContribution,
    }));

  console.table(priceIncreases);
}

// Monitor profit margin with real-time costs
if (currentCost.pricingSignal === "thin-margin") {
  alert(
    `Product margin dropped to ${(currentCost.grossMarginPct * 100).toFixed(1)}% - consider price increase`,
  );
}
```
