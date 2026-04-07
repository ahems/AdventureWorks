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
  "scrapReasonId": 5,
  "scrapReasonName": "Trim length too long",
  "isTotalFailure": false,
  "failedAtUtc": "2026-04-07T22:38:12Z"
}
```

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

A `ScrapEventData` record is always written for both partial and total failures. The status endpoint returns the 10 most recent.

### Chaos Mode

To simulate a station "going bad", `PUT` a high failure rate:

```bash
curl -X PUT https://<base>/api/manufacturing/scrap-config/10 \
  -H "Content-Type: application/json" \
  -d '{"failureRatePct": 0.8, "scrapReasonIds": [3, 5, 12], "note": "Chaos mode"}'
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

## Files

| File                                               | Purpose                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Models/WorkOrderOperationMessage.cs`              | Queue message `record` — all fields are serialized into/out of the queue                 |
| `Services/WorkOrderSimulationService.cs`           | All SQL + Table Storage logic — BOM explosion, routing, inventory, scrap, capacity slots |
| `Functions/ManufacturingControlFunction.cs`        | 8 HTTP control + monitoring endpoints                                                    |
| `Functions/WorkOrderOperationProcessorFunction.cs` | Queue trigger; two-phase message processing                                              |

### Infrastructure files modified

| File                                    | Change                                        |
| --------------------------------------- | --------------------------------------------- |
| `api-functions/api-functions.csproj`    | Added `Azure.Data.Tables 12.9.1`              |
| `api-functions/Program.cs`              | Registered `WorkOrderSimulationService` in DI |
| `infra/modules/storage.bicep`           | Added `production-wo-queue`                   |
| `infra/modules/aca-api-functions.bicep` | Added KEDA scale rule + 3 env var params      |
| `infra/main.bicep`                      | Raised `maxReplicas` from 3 to 5              |
