using System.Text.Json;
using Azure.Data.Tables;
using Azure.Identity;
using Azure.Storage.Queues;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;
using api_functions.Models;

namespace api_functions.Services;

// ── Data transfer types ──────────────────────────────────────────────────────

public record WarehouseWorkerStatus(
    int     EmployeeId,
    string  Name,
    string  JobTitle,
    int     ShiftId,
    string  ShiftName,
    string  Status,             // "available" | "working" | "off-shift" | "unavailable"
    string? CurrentOperationId,
    string? CurrentOperation,
    double  HourlyRate,
    double  TenureYears);

public record WarehouseWorkerSnapshot(
    int TotalWorkers,
    int CurrentlyWorking,
    int AvailableNow,
    int OffShift,
    int Unavailable,
    List<WarehouseShiftHeadcount> ByShift);

public record WarehouseShiftHeadcount(
    int ShiftId, string ShiftName,
    int Headcount, int Available, int Working, int OffShift);

public record SubcategoryHandlingConfig(
    int    SubcategoryId,
    string SubcategoryName,
    int    StoreMinMinutes,
    int    StoreMaxMinutes,
    int    RetrieveMinMinutes,
    int    RetrieveMaxMinutes,
    double BaseWeightKgThreshold,
    string? Note);

public record SupplierReceiveConfig(
    int    SubcategoryId,
    string SubcategoryName,
    int    ReceiveMinMinutes,
    int    ReceiveMaxMinutes,
    int    InspectionMinMinutes,
    int    InspectionMaxMinutes,
    double AdditionalMinutesPerUnit,
    string? Note);

public record WarehouseDamageConfig(
    string OperationType,      // "store" | "retrieve" | "receive"
    double DamageRatePct,
    int[]  DamageReasonIds,
    string? Note);

public record WarehouseDamageEvent(
    string OperationId,
    string OperationType,
    int    ProductId,
    string ProductName,
    int    Quantity,
    int    DamagedUnits,
    int    DamageReasonId,
    string DamageReasonName,
    bool   IsTotalLoss,
    double WriteOffValue,
    DateTime OccurredAtUtc);

public record WarehouseActiveOperation(
    string OperationId,
    string OperationType,
    int    ProductId,
    string ProductName,
    int    Quantity,
    int?   AssignedEmployeeId,
    string? AssignedWorkerName,
    DateTime ScheduledStartUtc,
    DateTime ScheduledCompletionUtc,
    double ElapsedMinutes,
    int?   SourceReferenceId);

public record WarehouseMetricsData(
    long   QueueDepth,
    int    ActiveOperations,
    int    StoredToday,
    int    RetrievedToday,
    int    ReceivedToday,
    int    DamageEventsToday,
    int    TotalUnitsHandledToday,
    double WorkerUtilisationPct,
    List<WarehouseShiftHeadcount> WorkersByShift);

// ── Service ──────────────────────────────────────────────────────────────────

/// <summary>
/// Core service for the Warehouse Simulation.
///
/// The warehouse is always-on and event-driven — no explicit start/stop.
/// Operations arrive via the warehouse-ops-queue from:
///   - Manufacturing sim (Store: finished goods after work order completion)
///   - Order pipeline  (Retrieve: pick items for approved customer orders)
///   - Supply chain    (ReceiveSupplier: put-away goods from PO deliveries)
///
/// Table Storage layout (awWarehouse table):
///   subcategoryconfig  | {subcategoryId}   — store/retrieve min/max minutes per subcategory
///   supplierreceiveconfig | {subcategoryId} — receive/inspection durations for supplier goods
///   damageconfig       | {operationType}   — damage rate and reasons per operation type
///   workforce          | {employeeId}      — worker pool (seeded from HumanResources tables)
///   activeop           | {operationId}     — currently in-flight operations
///   damageevent        | {reverseChronKey} — damage audit trail (newest first)
///   metrics            | {dateKey}         — daily throughput counters
/// </summary>
public class WarehouseService
{
    private const string TABLE_NAME              = "awWarehouse";
    private const string QUEUE_NAME              = "warehouse-ops-queue";
    private const string PART_SUBCAT_CONFIG      = "subcategoryconfig";
    private const string PART_SUPPLIER_CONFIG    = "supplierreceiveconfig";
    private const string PART_DAMAGE_CONFIG      = "damageconfig";
    private const string PART_WORKFORCE          = "workforce";
    private const string PART_ACTIVE_OP          = "activeop";
    private const string PART_DAMAGE_EVENT       = "damageevent";
    private const string PART_METRICS            = "metrics";
    private const string PART_ORDER_TRACKING     = "ordertracking";

    private const string ORDER_STATUS_QUEUE_NAME = "sales-order-status";

    private const int    WAREHOUSE_LOCATION_ID   = 7;
    private const double WEIGHT_THRESHOLD_KG     = 5.0; // Items heavier than this scale handling time

    // Warehouse department — "Shipping and Receiving" (DeptID 5)
    private const int WAREHOUSE_DEPT_ID = 5;

    // ── Default subcategory handling times (StoreMin, StoreMax, RetrieveMin, RetrieveMax) in minutes
    // Organized by subcategory name → ID mapping (IDs from standard AdventureWorks seed data)
    private static readonly Dictionary<int, (string Name, int StoreMin, int StoreMax, int RetrieveMin, int RetrieveMax)> DefaultSubcategoryConfig = new()
    {
        // Category: Bikes
        [1]  = ("Mountain Bikes",   18, 40, 12, 30),
        [2]  = ("Road Bikes",       16, 35, 10, 28),
        [3]  = ("Touring Bikes",    18, 40, 12, 30),
        // Category: Components
        [4]  = ("Handlebars",        3,  8,  2,  6),
        [5]  = ("Bottom Brackets",   4, 10,  3,  8),
        [6]  = ("Brakes",            3,  8,  2,  6),
        [7]  = ("Chains",            2,  5,  1,  4),
        [8]  = ("Cranksets",         5, 12,  3,  9),
        [9]  = ("Derailleurs",       3,  8,  2,  6),
        [10] = ("Forks",             6, 14,  4, 11),
        [11] = ("Headsets",          3,  7,  2,  5),
        [12] = ("Mountain Frames",  15, 35, 10, 28),
        [13] = ("Pedals",            3,  7,  2,  5),
        [14] = ("Road Frames",      14, 32, 10, 26),
        [15] = ("Saddles",           4,  9,  3,  7),
        [16] = ("Touring Frames",   15, 35, 10, 28),
        [17] = ("Wheels",           10, 22,  7, 17),
        // Category: Clothing
        [18] = ("Bib-Shorts",        2,  5,  1,  3),
        [19] = ("Caps",              1,  3,  1,  2),
        [20] = ("Gloves",            2,  4,  1,  3),
        [21] = ("Jerseys",           2,  5,  1,  3),
        [22] = ("Shorts",            2,  5,  1,  3),
        [23] = ("Socks",             1,  3,  1,  2),
        [24] = ("Tights",            2,  5,  1,  3),
        [25] = ("Vests",             2,  5,  1,  3),
        // Category: Accessories
        [26] = ("Bike Racks",        8, 18,  5, 14),
        [27] = ("Bike Stands",       8, 18,  5, 14),
        [28] = ("Bottles and Cages", 2,  5,  1,  3),
        [29] = ("Cleaners",          2,  5,  1,  3),
        [30] = ("Fenders",           4,  9,  3,  7),
        [31] = ("Helmets",           3,  8,  2,  6),
        [32] = ("Hydration Packs",   3,  7,  2,  5),
        [33] = ("Lights",            2,  5,  1,  4),
        [34] = ("Locks",             2,  7,  2,  5),
        [35] = ("Panniers",          5, 12,  3,  9),
        [36] = ("Pumps",             3,  7,  2,  5),
        [37] = ("Tires and Tubes",   3,  8,  2,  6),
    };

    // ── Default supplier receive durations per subcategory (ReceiveMin, ReceiveMax, InspMin, InspMax, PerUnit)
    private static readonly Dictionary<int, (int ReceiveMin, int ReceiveMax, int InspMin, int InspMax, double PerUnit)> DefaultSupplierReceiveConfig = new()
    {
        [1]  = (20, 45, 5, 15, 3.0),   // Mountain Bikes — large, heavy; careful unpack
        [2]  = (18, 42, 5, 14, 2.8),
        [3]  = (20, 45, 5, 15, 3.0),
        [4]  = (6, 14,  2,  5, 0.5),   // Handlebars
        [5]  = (5, 12,  2,  4, 0.4),
        [6]  = (5, 12,  2,  4, 0.5),
        [7]  = (3,  8,  1,  3, 0.3),   // Chains — small, bulk bags
        [8]  = (8, 18,  3,  7, 0.8),
        [9]  = (5, 12,  2,  4, 0.5),
        [10] = (10, 22, 3,  8, 1.0),   // Forks
        [11] = (4,  9,  2,  4, 0.4),
        [12] = (18, 40, 5, 14, 2.5),   // Frames — large
        [13] = (5, 10,  2,  4, 0.4),
        [14] = (18, 40, 5, 14, 2.5),
        [15] = (5, 12,  2,  4, 0.5),
        [16] = (18, 40, 5, 14, 2.5),
        [17] = (12, 25, 3,  8, 1.2),   // Wheels — bulky
        [18] = (3,  7,  1,  3, 0.2),   // Clothing — bulk box
        [19] = (2,  5,  1,  2, 0.1),
        [20] = (3,  6,  1,  3, 0.2),
        [21] = (3,  7,  1,  3, 0.2),
        [22] = (3,  7,  1,  3, 0.2),
        [23] = (2,  4,  1,  2, 0.1),
        [24] = (3,  7,  1,  3, 0.2),
        [25] = (3,  6,  1,  3, 0.2),
        [26] = (10, 20, 3,  7, 1.0),   // Bike Racks
        [27] = (10, 22, 3,  7, 1.2),
        [28] = (2,  5,  1,  2, 0.1),
        [29] = (2,  5,  1,  2, 0.1),
        [30] = (5, 11,  2,  4, 0.5),
        [31] = (4, 10,  2,  4, 0.5),   // Helmets
        [32] = (4,  9,  2,  4, 0.5),
        [33] = (3,  7,  1,  3, 0.3),
        [34] = (3,  7,  1,  3, 0.3),   // Locks
        [35] = (6, 14,  2,  5, 0.8),
        [36] = (3,  7,  1,  3, 0.3),
        [37] = (4,  9,  2,  4, 0.4),
    };

    // ── Default damage configurations per operation type
    private static readonly Dictionary<string, (double Rate, int[] ReasonIds)> DefaultDamageConfig = new()
    {
        ["store"]    = (0.020, new[] { 1, 2, 3, 6 }),      // 2.0%
        ["retrieve"] = (0.015, new[] { 1, 3, 4, 6 }),      // 1.5%
        ["receive"]  = (0.040, new[] { 3, 4, 5, 6, 7, 8 }), // 4.0%
    };

    // Warehouse damage reason IDs (seeded to a separate lookup; stored in damageconfig metadata)
    // 1=Dropped during handling, 2=Forklift impact, 3=Crushed by stacking, 4=Caught on racking
    // 5=Packaging failure in transit, 6=Water/moisture damage, 7=Temperature damage, 8=Label damaged
    public static readonly Dictionary<int, string> DamageReasonNames = new()
    {
        [1] = "Dropped during handling",
        [2] = "Forklift impact",
        [3] = "Crushed by stacking",
        [4] = "Caught on racking",
        [5] = "Packaging failure in transit",
        [6] = "Water/moisture damage",
        [7] = "Temperature damage",
        [8] = "Label/barcode damaged",
    };

    private readonly string _connectionString;
    private readonly TableClient _tableClient;
    private readonly QueueClient _queueClient;
    private readonly QueueClient _orderStatusQueueClient;
    private readonly BankService? _bank;
    private readonly ILogger<WarehouseService> _logger;

    private static readonly SemaphoreSlim _initLock = new(1, 1);
    private static volatile bool _initComplete = false;

    private static readonly JsonSerializerOptions _jsonOpts = new() { PropertyNameCaseInsensitive = true };

    public WarehouseService(
        string connectionString,
        string tableServiceUri,
        string queueServiceUri,
        BankService? bank,
        ILogger<WarehouseService> logger)
    {
        _connectionString = connectionString;
        _bank             = bank;
        _logger           = logger;

        var tableSvc  = new TableServiceClient(new Uri(tableServiceUri), new DefaultAzureCredential());
        _tableClient  = tableSvc.GetTableClient(TABLE_NAME);

        var queueSvc  = new QueueServiceClient(new Uri(queueServiceUri), new DefaultAzureCredential());
        _queueClient              = queueSvc.GetQueueClient(QUEUE_NAME);
        _orderStatusQueueClient   = queueSvc.GetQueueClient(ORDER_STATUS_QUEUE_NAME);
    }

    // ── Initialisation (lazy, idempotent) ─────────────────────────────────────

    /// <summary>
    /// Idempotent initialisation. Seeds Table Storage with warehouse worker pool,
    /// subcategory handling configs, supplier receive configs, and damage configs.
    /// Called automatically on first operation arrival.
    /// </summary>
    public async Task InitializeAsync()
    {
        if (_initComplete) return;
        await _initLock.WaitAsync();
        try
        {
            if (_initComplete) return;

            await _tableClient.CreateIfNotExistsAsync();
            await _queueClient.CreateIfNotExistsAsync();

            await Task.WhenAll(
                InitializeSubcategoryConfigAsync(),
                InitializeSupplierReceiveConfigAsync(),
                InitializeDamageConfigAsync(),
                InitializeWarehouseWorkforceAsync()
            );

            _initComplete = true;
            _logger.LogInformation("Warehouse simulation initialized.");
        }
        finally
        {
            _initLock.Release();
        }
    }

    // ── Enqueue operations (called by upstream simulators) ───────────────────

    /// <summary>
    /// Enqueues a Store operation. Called when a manufacturing work order completes
    /// instead of the previous direct inventory upsert.
    /// </summary>
    public async Task EnqueueStoreOperationAsync(int workOrderId, int productId, int quantity)
    {
        await InitializeAsync();

        var (productName, subcatId, subcatName, weightKg, standardCost) = await GetProductInfoAsync(productId);

        var msg = new WarehouseOperationMessage
        {
            OperationId        = Guid.NewGuid().ToString("N"),
            OperationType      = WarehouseOperationType.Store,
            ProductId          = productId,
            ProductName        = productName,
            SubcategoryId      = subcatId,
            SubcategoryName    = subcatName,
            Quantity           = quantity,
            WeightKg           = weightKg,
            SourceReferenceId  = workOrderId,
            IsCompletionPhase  = false,
            ProductStandardCost = standardCost,
        };

        await EnqueueMessageAsync(msg, visibilityDelay: TimeSpan.Zero);
        _logger.LogInformation("Warehouse Store op enqueued for WO-{WorkOrderId}, Product {ProductId} ({Qty} units)",
            workOrderId, productId, quantity);
    }

    /// <summary>
    /// Enqueues Retrieve operations for each line item in a sales order.
    /// Called by the order pipeline when an order reaches the WarehousePick stage.
    /// </summary>
    public async Task EnqueueRetrieveOperationsAsync(int salesOrderId, IEnumerable<(int ProductId, int Quantity)> lineItems)
    {
        await InitializeAsync();

        var items = lineItems.ToList(); // materialize once

        // Write tracking record before enqueuing so Phase-2 completion can find it
        if (items.Count > 0)
        {
            var trackEntity = new TableEntity(PART_ORDER_TRACKING, salesOrderId.ToString())
            {
                ["TotalItems"]  = items.Count,
                ["PickedItems"] = 0,
                ["EnqueuedAt"]  = DateTimeOffset.UtcNow,
            };
            await _tableClient.UpsertEntityAsync(trackEntity, TableUpdateMode.Replace);
        }

        foreach (var (productId, qty) in items)
        {
            var (productName, subcatId, subcatName, weightKg, standardCost) = await GetProductInfoAsync(productId);

            var msg = new WarehouseOperationMessage
            {
                OperationId        = Guid.NewGuid().ToString("N"),
                OperationType      = WarehouseOperationType.Retrieve,
                ProductId          = productId,
                ProductName        = productName,
                SubcategoryId      = subcatId,
                SubcategoryName    = subcatName,
                Quantity           = qty,
                WeightKg           = weightKg,
                SourceReferenceId  = salesOrderId,
                IsCompletionPhase  = false,
                ProductStandardCost = standardCost,
            };

            await EnqueueMessageAsync(msg, visibilityDelay: TimeSpan.Zero);
        }

        _logger.LogInformation("Warehouse Retrieve ops enqueued for SalesOrder-{SalesOrderId} ({Count} line(s))",
            salesOrderId, items.Count);
    }

    /// <summary>
    /// Convenience overload: fetches line items from SQL then calls EnqueueRetrieveOperationsAsync.
    /// Called by the order pipeline when an approved order is ready for warehouse pick.
    /// </summary>
    public async Task EnqueueRetrieveOperationsForOrderAsync(int salesOrderId)
    {
        await InitializeAsync();

        var lineItems = new List<(int ProductId, int Quantity)>();
        using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();
        var rows = await conn.QueryAsync<(int ProductId, int OrderQty)>(
            @"SELECT ProductID, OrderQty
              FROM   Sales.SalesOrderDetail
              WHERE  SalesOrderID = @SalesOrderId",
            new { SalesOrderId = salesOrderId });

        lineItems.AddRange(rows.Select(r => (r.ProductId, r.OrderQty)));

        if (lineItems.Count == 0)
        {
            // No lines — just ship immediately
            await ShipOrderAsync(salesOrderId);
            return;
        }

        await EnqueueRetrieveOperationsAsync(salesOrderId, lineItems);
    }

    /// <summary>
    /// Enqueues a ReceiveSupplier operation. Called when a purchase order is received
    /// instead of the previous direct inventory insert.
    /// </summary>
    public async Task EnqueueReceiveSupplierOperationAsync(int purchaseOrderId, int productId, int quantity)
    {
        await InitializeAsync();

        var (productName, subcatId, subcatName, weightKg, standardCost) = await GetProductInfoAsync(productId);

        var msg = new WarehouseOperationMessage
        {
            OperationId        = Guid.NewGuid().ToString("N"),
            OperationType      = WarehouseOperationType.ReceiveSupplier,
            ProductId          = productId,
            ProductName        = productName,
            SubcategoryId      = subcatId,
            SubcategoryName    = subcatName,
            Quantity           = quantity,
            WeightKg           = weightKg,
            SourceReferenceId  = purchaseOrderId,
            IsCompletionPhase  = false,
            ProductStandardCost = standardCost,
        };

        await EnqueueMessageAsync(msg, visibilityDelay: TimeSpan.Zero);
        _logger.LogInformation("Warehouse ReceiveSupplier op enqueued for PO-{PurchaseOrderId}, Product {ProductId} ({Qty} units)",
            purchaseOrderId, productId, quantity);
    }

    // ── Phase 1 processing (assign worker, calculate duration) ───────────────

    /// <summary>
    /// Processes the start phase of a warehouse operation.
    /// Assigns a worker, calculates duration, records active op, re-queues as Phase 2
    /// with visibility timeout equal to the operation duration.
    /// </summary>
    public async Task<WarehouseOperationMessage> ProcessStartPhaseAsync(WarehouseOperationMessage msg)
    {
        await InitializeAsync();

        // Assign a warehouse worker (if available)
        var worker = await AssignWorkerAsync(msg.OperationId, msg.OperationType.ToString().ToLower());
        if (worker.HasValue)
        {
            msg = msg with
            {
                AssignedEmployeeId  = worker.Value.EmployeeId,
                AssignedWorkerName  = worker.Value.Name,
                AssignedHourlyRate  = worker.Value.HourlyRate,
            };
        }

        // Calculate operation duration
        double durationMinutes = await CalculateDurationAsync(msg);
        var now = DateTime.UtcNow;
        msg = msg with
        {
            ScheduledStartUtc      = now,
            ScheduledCompletionUtc = now.AddMinutes(durationMinutes),
            IsCompletionPhase      = true,
        };

        // Record active operation
        await UpsertActiveOpAsync(msg);

        // Re-queue as Phase 2 with visibility = duration
        var visibility = TimeSpan.FromMinutes(Math.Max(0, durationMinutes));
        await EnqueueMessageAsync(msg, visibilityDelay: visibility);

        return msg;
    }

    // ── Phase 2 processing (damage roll, inventory update, bank) ─────────────

    /// <summary>
    /// Processes the completion phase of a warehouse operation.
    /// Applies damage roll, updates inventory in SQL, releases worker, posts bank transaction.
    /// </summary>
    public async Task ProcessCompletionPhaseAsync(WarehouseOperationMessage msg)
    {
        // Self-reschedule if not yet due
        if (msg.ScheduledCompletionUtc > DateTime.UtcNow.AddSeconds(2))
        {
            var delay = msg.ScheduledCompletionUtc - DateTime.UtcNow;
            await EnqueueMessageAsync(msg, visibilityDelay: delay);
            return;
        }

        // Roll for damage
        var (isDamaged, damagedUnits, reasonId, reasonName) = await RollDamageAsync(msg);
        int effectiveQty = Math.Max(0, msg.Quantity - damagedUnits);
        bool isTotalLoss = effectiveQty == 0;

        // Update inventory in SQL
        if (effectiveQty > 0)
        {
            await UpdateInventoryAsync(msg, effectiveQty);
        }

        // Record damage event and debit bank if damage occurred
        if (isDamaged)
        {
            double writeOffValue = damagedUnits * msg.ProductStandardCost;
            await RecordDamageEventAsync(msg, damagedUnits, reasonId, reasonName, isTotalLoss, writeOffValue);

            if (_bank != null && writeOffValue > 0)
            {
                try
                {
                    await _bank.InitializeAsync();
                    await _bank.PostTransactionAsync(new BankTransactionRequest(
                        CurrencyCode:    "USD",
                        Amount:          -(decimal)writeOffValue,
                        Description:     $"Warehouse damage ({msg.OperationType}): {msg.ProductName} " +
                                         $"({damagedUnits} unit(s)) — {reasonName}",
                        ReferenceId:     $"WH-DMG-{msg.OperationId}",
                        TransactionType: "purchase"));
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to post damage write-off to bank for op {OperationId}", msg.OperationId);
                }
            }
        }

        // Release worker
        if (msg.AssignedEmployeeId.HasValue)
        {
            await ReleaseWorkerAsync(msg.AssignedEmployeeId.Value);

            // Payroll bank debit
            if (_bank != null && msg.AssignedHourlyRate > 0)
            {
                try
                {
                    double durationHours = (msg.ScheduledCompletionUtc - msg.ScheduledStartUtc).TotalHours;
                    double payroll = durationHours * msg.AssignedHourlyRate;
                    if (payroll > 0)
                    {
                        await _bank.InitializeAsync();
                        await _bank.PostTransactionAsync(new BankTransactionRequest(
                            CurrencyCode:    "USD",
                            Amount:          -(decimal)payroll,
                            Description:     $"Warehouse payroll ({msg.OperationType}): {msg.AssignedWorkerName} " +
                                             $"— {msg.ProductName}",
                            ReferenceId:     $"WH-{msg.OperationId}",
                            TransactionType: "payroll"));
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to post warehouse payroll for op {OperationId}", msg.OperationId);
                }
            }
        }

        // Remove from active ops and increment daily metrics
        await RemoveActiveOpAsync(msg.OperationId);
        await IncrementMetricsAsync(msg.OperationType, isDamaged);

        // For Retrieve ops: track per-order pick completions and gate order shipping
        if (msg.OperationType == WarehouseOperationType.Retrieve && msg.SourceReferenceId.HasValue)
        {
            await TrackPickCompletionAsync(msg.SourceReferenceId.Value);
        }

        _logger.LogInformation(
            "Warehouse op {OperationId} ({Type}) completed: Product {ProductId}, Qty={Qty}, Effective={Effective}, Damaged={Damaged}",
            msg.OperationId, msg.OperationType, msg.ProductId, msg.Quantity, effectiveQty, damagedUnits);
    }

    // ── Order-pick gate: notify order pipeline when all picks are done ─────────

    /// <summary>
    /// Increments the picked-item counter for a sales order.
    /// When all line items have been picked, enqueues Status=5 (Shipped) to the
    /// sales-order-status queue so the order pipeline completes shipment.
    /// </summary>
    private async Task TrackPickCompletionAsync(int salesOrderId)
    {
        try
        {
            var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
                PART_ORDER_TRACKING, salesOrderId.ToString());
            if (!resp.HasValue) return; // No tracking record — order was shipped directly

            var entity = resp.Value!;
            int total  = entity.GetInt32("TotalItems")  ?? 1;
            int picked = entity.GetInt32("PickedItems")  ?? 0;
            picked++;

            entity["PickedItems"] = picked;
            await _tableClient.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);

            if (picked >= total)
            {
                // All items picked — delete tracking record and ship
                try { await _tableClient.DeleteEntityAsync(PART_ORDER_TRACKING, salesOrderId.ToString()); }
                catch { /* best-effort cleanup */ }
                await ShipOrderAsync(salesOrderId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "TrackPickCompletion failed for SalesOrder-{SalesOrderId} — falling back to direct ship", salesOrderId);
            try { await ShipOrderAsync(salesOrderId); } catch { /* swallow */ }
        }
    }

    /// <summary>
    /// Enqueues a Status=5 (Shipped) message onto the sales-order-status queue.
    /// </summary>
    private async Task ShipOrderAsync(int salesOrderId)
    {
        var payload = System.Text.Json.JsonSerializer.Serialize(new { SalesOrderID = salesOrderId, Status = 5 });
        var bytes   = System.Text.Encoding.UTF8.GetBytes(payload);
        await _orderStatusQueueClient.CreateIfNotExistsAsync();
        await _orderStatusQueueClient.SendMessageAsync(Convert.ToBase64String(bytes));
        _logger.LogInformation("Warehouse: all picks complete for SalesOrder-{SalesOrderId} — enqueued Status=5", salesOrderId);
    }

    // ── Configuration CRUD ────────────────────────────────────────────────────

    public async Task<List<SubcategoryHandlingConfig>> GetSubcategoryConfigsAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var result = new List<SubcategoryHandlingConfig>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_SUBCAT_CONFIG}'"))
        {
            result.Add(EntityToSubcategoryConfig(e));
        }
        return result.OrderBy(c => c.SubcategoryId).ToList();
    }

    public async Task<SubcategoryHandlingConfig?> GetSubcategoryConfigAsync(int subcategoryId)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_SUBCAT_CONFIG, subcategoryId.ToString());
        return resp.HasValue ? EntityToSubcategoryConfig(resp.Value!) : null;
    }

    public async Task<SubcategoryHandlingConfig> UpdateSubcategoryConfigAsync(
        int subcategoryId, int storeMin, int storeMax, int retrieveMin, int retrieveMax,
        double weightThreshold, string? note)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_SUBCAT_CONFIG, subcategoryId.ToString());
        if (!resp.HasValue) throw new ArgumentException($"Subcategory {subcategoryId} not found.");

        var entity = resp.Value!;
        entity["StoreMinMinutes"]        = storeMin;
        entity["StoreMaxMinutes"]        = storeMax;
        entity["RetrieveMinMinutes"]     = retrieveMin;
        entity["RetrieveMaxMinutes"]     = retrieveMax;
        entity["BaseWeightKgThreshold"]  = weightThreshold;
        entity["Note"]                   = note;
        await _tableClient.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);

        return EntityToSubcategoryConfig(entity);
    }

    public async Task<List<SupplierReceiveConfig>> GetSupplierReceiveConfigsAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var result = new List<SupplierReceiveConfig>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_SUPPLIER_CONFIG}'"))
        {
            result.Add(EntityToSupplierReceiveConfig(e));
        }
        return result.OrderBy(c => c.SubcategoryId).ToList();
    }

    public async Task<SupplierReceiveConfig> UpdateSupplierReceiveConfigAsync(
        int subcategoryId, int receiveMin, int receiveMax, int inspMin, int inspMax,
        double perUnit, string? note)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_SUPPLIER_CONFIG, subcategoryId.ToString());
        if (!resp.HasValue) throw new ArgumentException($"Supplier receive config for subcategory {subcategoryId} not found.");

        var entity = resp.Value!;
        entity["ReceiveMinMinutes"]           = receiveMin;
        entity["ReceiveMaxMinutes"]           = receiveMax;
        entity["InspectionMinMinutes"]        = inspMin;
        entity["InspectionMaxMinutes"]        = inspMax;
        entity["AdditionalMinutesPerUnit"]    = perUnit;
        entity["Note"]                        = note;
        await _tableClient.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);

        return EntityToSupplierReceiveConfig(entity);
    }

    public async Task<List<WarehouseDamageConfig>> GetDamageConfigsAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var result = new List<WarehouseDamageConfig>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_DAMAGE_CONFIG}'"))
        {
            result.Add(EntityToDamageConfig(e));
        }
        return result;
    }

    public async Task<WarehouseDamageConfig> UpdateDamageConfigAsync(
        string operationType, double damageRatePct, int[] damageReasonIds, string? note)
    {
        operationType = operationType.ToLowerInvariant();
        if (damageRatePct < 0 || damageRatePct > 1)
            throw new ArgumentOutOfRangeException(nameof(damageRatePct), "Must be between 0.0 and 1.0");

        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_DAMAGE_CONFIG, operationType);
        if (!resp.HasValue) throw new ArgumentException($"Damage config for operation type '{operationType}' not found.");

        var entity = resp.Value!;
        entity["DamageRatePct"]    = damageRatePct;
        entity["DamageReasonIds"]  = JsonSerializer.Serialize(damageReasonIds);
        entity["Note"]             = note;
        await _tableClient.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);

        return EntityToDamageConfig(entity);
    }

    // ── Status & metrics ──────────────────────────────────────────────────────

    public async Task<WarehouseMetricsData> GetStatusAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();

        // Queue depth
        var props = await _queueClient.GetPropertiesAsync();
        long queueDepth = props.Value?.ApproximateMessagesCount ?? 0;

        // Active operations count
        int activeOps = 0;
        await foreach (var _ in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_ACTIVE_OP}'"))
            activeOps++;

        // Today's metrics
        string todayKey = DateTime.UtcNow.ToString("yyyyMMdd");
        var metricsResp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_METRICS, todayKey);
        int storedToday    = metricsResp.HasValue ? (metricsResp.Value!.GetInt32("Stored")    ?? 0) : 0;
        int retrievedToday = metricsResp.HasValue ? (metricsResp.Value!.GetInt32("Retrieved") ?? 0) : 0;
        int receivedToday  = metricsResp.HasValue ? (metricsResp.Value!.GetInt32("Received")  ?? 0) : 0;
        int damageToday    = metricsResp.HasValue ? (metricsResp.Value!.GetInt32("Damage")    ?? 0) : 0;

        var snapshot = await GetWorkerSnapshotAsync();
        double utilisation = snapshot.TotalWorkers > 0
            ? (double)snapshot.CurrentlyWorking / snapshot.TotalWorkers * 100.0 : 0;

        return new WarehouseMetricsData(
            QueueDepth:           queueDepth,
            ActiveOperations:     activeOps,
            StoredToday:          storedToday,
            RetrievedToday:       retrievedToday,
            ReceivedToday:        receivedToday,
            DamageEventsToday:    damageToday,
            TotalUnitsHandledToday: storedToday + retrievedToday + receivedToday,
            WorkerUtilisationPct: Math.Round(utilisation, 1),
            WorkersByShift:       snapshot.ByShift);
    }

    public async Task<List<WarehouseActiveOperation>> GetActiveOperationsAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var result = new List<WarehouseActiveOperation>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_ACTIVE_OP}'"))
        {
            var startUtc = e.GetDateTime("ScheduledStartUtc") ?? DateTime.UtcNow;
            var endUtc   = e.GetDateTime("ScheduledCompletionUtc") ?? DateTime.UtcNow;
            var opType   = e.GetString("OperationType") ?? "Unknown";

            result.Add(new WarehouseActiveOperation(
                OperationId:            e.RowKey,
                OperationType:          opType,
                ProductId:              e.GetInt32("ProductId") ?? 0,
                ProductName:            e.GetString("ProductName") ?? "",
                Quantity:               e.GetInt32("Quantity") ?? 0,
                AssignedEmployeeId:     e.GetInt32("AssignedEmployeeId"),
                AssignedWorkerName:     e.GetString("AssignedWorkerName"),
                ScheduledStartUtc:      startUtc,
                ScheduledCompletionUtc: endUtc,
                ElapsedMinutes:         Math.Round((DateTime.UtcNow - startUtc).TotalMinutes, 1),
                SourceReferenceId:      e.GetInt32("SourceReferenceId")));
        }
        return result.OrderBy(o => o.ScheduledStartUtc).ToList();
    }

    public async Task<List<WarehouseDamageEvent>> GetDamageEventsAsync(string? operationType = null, int maxCount = 50)
    {
        await _tableClient.CreateIfNotExistsAsync();
        var result = new List<WarehouseDamageEvent>();
        string filter = $"PartitionKey eq '{PART_DAMAGE_EVENT}'";
        if (!string.IsNullOrEmpty(operationType))
            filter += $" and OperationType eq '{operationType.ToLowerInvariant()}'";

        int count = 0;
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(filter: filter))
        {
            if (count++ >= maxCount) break;
            result.Add(new WarehouseDamageEvent(
                OperationId:    e.GetString("OperationId") ?? "",
                OperationType:  e.GetString("OperationType") ?? "",
                ProductId:      e.GetInt32("ProductId") ?? 0,
                ProductName:    e.GetString("ProductName") ?? "",
                Quantity:       e.GetInt32("Quantity") ?? 0,
                DamagedUnits:   e.GetInt32("DamagedUnits") ?? 0,
                DamageReasonId: e.GetInt32("DamageReasonId") ?? 0,
                DamageReasonName: e.GetString("DamageReasonName") ?? "",
                IsTotalLoss:    e.GetBoolean("IsTotalLoss") ?? false,
                WriteOffValue:  e.GetDouble("WriteOffValue") ?? 0,
                OccurredAtUtc:  e.GetDateTime("OccurredAtUtc") ?? DateTime.UtcNow));
        }
        return result;
    }

    public async Task<WarehouseWorkerSnapshot> GetWorkerSnapshotAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var byShift = new Dictionary<int, (string name, int total, int avail, int working, int offShift)>();
        int total = 0, working = 0, available = 0, offShift = 0, unavailable = 0;

        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_WORKFORCE}'"))
        {
            total++;
            int shiftId    = e.GetInt32("ShiftId") ?? 1;
            string shiftName = e.GetString("ShiftName") ?? "Day";
            string status  = GetEffectiveWorkerStatus(e);

            if (!byShift.ContainsKey(shiftId))
                byShift[shiftId] = (shiftName, 0, 0, 0, 0);
            var (sn, t, a, w, o) = byShift[shiftId];

            switch (status)
            {
                case "working":   working++;   w++; break;
                case "available": available++;  a++; break;
                case "off-shift": offShift++;   o++; break;
                default:          unavailable++; break;
            }
            byShift[shiftId] = (sn, t + 1, a, w, o);
        }

        var shiftList = byShift
            .OrderBy(kv => kv.Key)
            .Select(kv => new WarehouseShiftHeadcount(
                kv.Key, kv.Value.name, kv.Value.total,
                kv.Value.avail, kv.Value.working, kv.Value.offShift))
            .ToList();

        return new WarehouseWorkerSnapshot(total, working, available, offShift, unavailable, shiftList);
    }

    public async Task<List<WarehouseWorkerStatus>> GetWorkersDetailAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var result = new List<WarehouseWorkerStatus>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_WORKFORCE}'"))
        {
            string status = GetEffectiveWorkerStatus(e);
            result.Add(new WarehouseWorkerStatus(
                EmployeeId:         int.TryParse(e.RowKey, out int eid) ? eid : 0,
                Name:               e.GetString("FullName") ?? "",
                JobTitle:           e.GetString("JobTitle") ?? "",
                ShiftId:            e.GetInt32("ShiftId") ?? 1,
                ShiftName:          e.GetString("ShiftName") ?? "Day",
                Status:             status,
                CurrentOperationId: status == "working" ? e.GetString("CurrentOperationId") : null,
                CurrentOperation:   status == "working" ? e.GetString("CurrentOperation") : null,
                HourlyRate:         e.GetDouble("HourlyRate") ?? 18.0,
                TenureYears:        e.GetDouble("TenureYears") ?? 0));
        }
        return result.OrderBy(w => w.ShiftId).ThenBy(w => w.Name).ToList();
    }

    // ── Private: worker assignment/release ────────────────────────────────────

    private async Task<(int EmployeeId, string Name, double HourlyRate)?> AssignWorkerAsync(
        string operationId, string operationType)
    {
        var workers = new List<TableEntity>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_WORKFORCE}'"))
        {
            if (GetEffectiveWorkerStatus(e) == "available")
                workers.Add(e);
        }

        if (!workers.Any()) return null;

        // Pick worker with most vacation hours remaining (most rested / tenured)
        var chosen = workers.OrderByDescending(w => w.GetInt32("VacationHours") ?? 0).First();
        chosen["Status"]             = "working";
        chosen["CurrentOperationId"] = operationId;
        chosen["CurrentOperation"]   = $"{operationType} operation";
        chosen["BusyUntilUtc"]       = (DateTimeOffset)DateTimeOffset.UtcNow.AddHours(4);

        try { await _tableClient.UpdateEntityAsync(chosen, chosen.ETag); }
        catch { /* concurrent assignment — proceed without worker tracking */ }

        return (
            int.Parse(chosen.RowKey),
            chosen.GetString("FullName") ?? "Unknown",
            chosen.GetDouble("HourlyRate") ?? 18.0);
    }

    private async Task ReleaseWorkerAsync(int employeeId)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_WORKFORCE, employeeId.ToString());
        if (!resp.HasValue) return;

        var worker = resp.Value!;
        worker["Status"]             = "available";
        worker["CurrentOperationId"] = (string?)null;
        worker["CurrentOperation"]   = (string?)null;
        worker["BusyUntilUtc"]       = (DateTimeOffset?)null;

        try { await _tableClient.UpdateEntityAsync(worker, worker.ETag); }
        catch { /* ignore */ }
    }

    // ── Private: duration calculation ─────────────────────────────────────────

    private async Task<double> CalculateDurationAsync(WarehouseOperationMessage msg)
    {
        double baseMin, baseMax;

        if (msg.OperationType == WarehouseOperationType.ReceiveSupplier)
        {
            // Supplier receive uses its own config
            if (msg.SubcategoryId.HasValue)
            {
                var config = await GetSupplierReceiveConfigEntityAsync(msg.SubcategoryId.Value);
                int receiveMin  = config?.GetInt32("ReceiveMinMinutes")     ?? 5;
                int receiveMax  = config?.GetInt32("ReceiveMaxMinutes")     ?? 15;
                int inspMin     = config?.GetInt32("InspectionMinMinutes")  ?? 1;
                int inspMax     = config?.GetInt32("InspectionMaxMinutes")  ?? 4;
                double perUnit  = config?.GetDouble("AdditionalMinutesPerUnit") ?? 0.3;

                baseMin = receiveMin + inspMin + (perUnit * Math.Max(0, msg.Quantity - 1) * 0.5);
                baseMax = receiveMax + inspMax + (perUnit * Math.Max(0, msg.Quantity - 1));
            }
            else
            {
                baseMin = 5;
                baseMax = 20;
            }
        }
        else
        {
            // Store or Retrieve uses subcategory handling config
            if (msg.SubcategoryId.HasValue)
            {
                var config = await GetSubcategoryConfigEntityAsync(msg.SubcategoryId.Value);
                baseMin = (msg.OperationType == WarehouseOperationType.Store)
                    ? (config?.GetInt32("StoreMinMinutes")    ?? 3)
                    : (config?.GetInt32("RetrieveMinMinutes") ?? 2);
                baseMax = (msg.OperationType == WarehouseOperationType.Store)
                    ? (config?.GetInt32("StoreMaxMinutes")    ?? 10)
                    : (config?.GetInt32("RetrieveMaxMinutes") ?? 8);

                // Apply weight multiplier
                if (msg.WeightKg.HasValue && msg.WeightKg.Value > 0)
                {
                    double weightThreshold = config?.GetDouble("BaseWeightKgThreshold") ?? WEIGHT_THRESHOLD_KG;
                    if (msg.WeightKg.Value > weightThreshold)
                    {
                        double multiplier = 1.0 + (msg.WeightKg.Value - weightThreshold) / weightThreshold * 0.5;
                        baseMin *= multiplier;
                        baseMax *= multiplier;
                    }
                }
            }
            else
            {
                baseMin = 2;
                baseMax = 8;
            }
        }

        // Random pick between min and max
        return baseMin + Random.Shared.NextDouble() * (baseMax - baseMin);
    }

    // ── Private: damage roll ──────────────────────────────────────────────────

    private async Task<(bool IsDamaged, int DamagedUnits, int ReasonId, string ReasonName)> RollDamageAsync(
        WarehouseOperationMessage msg)
    {
        string opType = msg.OperationType.ToString().ToLower();
        var configResp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_DAMAGE_CONFIG, opType);
        if (!configResp.HasValue) return (false, 0, 0, "");

        var config = configResp.Value!;
        double rate = config.GetDouble("DamageRatePct") ?? 0.02;
        int[]  ids  = JsonSerializer.Deserialize<int[]>(config.GetString("DamageReasonIds") ?? "[]") ?? Array.Empty<int>();

        if (ids.Length == 0 || Random.Shared.NextDouble() >= rate)
            return (false, 0, 0, "");

        int damagedUnits = Math.Max(1, (int)Math.Ceiling(msg.Quantity * 0.1)); // damage at most 10% of qty
        damagedUnits = Math.Min(damagedUnits, msg.Quantity);
        int reasonId   = ids[Random.Shared.Next(ids.Length)];
        string reasonName = DamageReasonNames.GetValueOrDefault(reasonId, "Unknown damage");

        return (true, damagedUnits, reasonId, reasonName);
    }

    // ── Private: inventory updates ────────────────────────────────────────────

    private async Task UpdateInventoryAsync(WarehouseOperationMessage msg, int effectiveQty)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        if (msg.OperationType == WarehouseOperationType.Store ||
            msg.OperationType == WarehouseOperationType.ReceiveSupplier)
        {
            // Add to inventory at LocationID 7 (Finished Goods Storage) for store/receive.
            // Quantity column is smallint (max 32,767) — clamp to prevent arithmetic overflow.
            await conn.ExecuteAsync(@"
                IF EXISTS (SELECT 1 FROM Production.ProductInventory WHERE ProductID = @ProductId AND LocationID = 7)
                    UPDATE Production.ProductInventory
                    SET Quantity = CONVERT(smallint, CASE WHEN CONVERT(int, Quantity) + @Qty > 32767 THEN 32767
                                                         WHEN CONVERT(int, Quantity) + @Qty < 0      THEN 0
                                                         ELSE CONVERT(int, Quantity) + @Qty END),
                        ModifiedDate = GETDATE()
                    WHERE ProductID = @ProductId AND LocationID = 7
                ELSE
                    INSERT INTO Production.ProductInventory
                        (ProductID, LocationID, Shelf, Bin, Quantity, rowguid, ModifiedDate)
                    VALUES (@ProductId, 7, 'A', 1, CONVERT(smallint, CASE WHEN @Qty > 32767 THEN 32767
                                                                          WHEN @Qty < 0      THEN 0
                                                                          ELSE @Qty END), NEWID(), GETDATE())",
                new { ProductId = msg.ProductId, Qty = effectiveQty });
        }
        else if (msg.OperationType == WarehouseOperationType.Retrieve)
        {
            // Deduct from inventory at LocationID 7
            await conn.ExecuteAsync(@"
                UPDATE Production.ProductInventory
                SET Quantity = CASE WHEN Quantity >= @Qty THEN Quantity - @Qty ELSE 0 END,
                    ModifiedDate = GETDATE()
                WHERE ProductID = @ProductId AND LocationID = 7",
                new { ProductId = msg.ProductId, Qty = effectiveQty });
        }
    }

    // ── Private: recording / metrics ──────────────────────────────────────────

    private async Task UpsertActiveOpAsync(WarehouseOperationMessage msg)
    {
        var entity = new TableEntity(PART_ACTIVE_OP, msg.OperationId)
        {
            ["OperationType"]          = msg.OperationType.ToString(),
            ["ProductId"]              = msg.ProductId,
            ["ProductName"]            = msg.ProductName,
            ["Quantity"]               = msg.Quantity,
            ["AssignedEmployeeId"]     = msg.AssignedEmployeeId,
            ["AssignedWorkerName"]     = msg.AssignedWorkerName,
            ["ScheduledStartUtc"]      = (DateTime)msg.ScheduledStartUtc,
            ["ScheduledCompletionUtc"] = (DateTime)msg.ScheduledCompletionUtc,
            ["SourceReferenceId"]      = msg.SourceReferenceId,
        };
        await _tableClient.UpsertEntityAsync(entity);
    }

    private async Task RemoveActiveOpAsync(string operationId)
    {
        try { await _tableClient.DeleteEntityAsync(PART_ACTIVE_OP, operationId); }
        catch { /* already removed */ }
    }

    private async Task RecordDamageEventAsync(
        WarehouseOperationMessage msg, int damagedUnits,
        int reasonId, string reasonName, bool isTotalLoss, double writeOffValue)
    {
        string rowKey = $"{long.MaxValue - DateTimeOffset.UtcNow.Ticks:D19}_{msg.OperationId[..8]}";
        var entity = new TableEntity(PART_DAMAGE_EVENT, rowKey)
        {
            ["OperationId"]    = msg.OperationId,
            ["OperationType"]  = msg.OperationType.ToString().ToLower(),
            ["ProductId"]      = msg.ProductId,
            ["ProductName"]    = msg.ProductName,
            ["Quantity"]       = msg.Quantity,
            ["DamagedUnits"]   = damagedUnits,
            ["DamageReasonId"] = reasonId,
            ["DamageReasonName"] = reasonName,
            ["IsTotalLoss"]    = isTotalLoss,
            ["WriteOffValue"]  = writeOffValue,
            ["OccurredAtUtc"]  = DateTime.UtcNow,
        };
        await _tableClient.UpsertEntityAsync(entity);
    }

    private async Task IncrementMetricsAsync(WarehouseOperationType opType, bool damageOccurred)
    {
        string today = DateTime.UtcNow.ToString("yyyyMMdd");
        string col = opType switch
        {
            WarehouseOperationType.Store           => "Stored",
            WarehouseOperationType.Retrieve        => "Retrieved",
            WarehouseOperationType.ReceiveSupplier => "Received",
            _                                      => "Stored",
        };

        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_METRICS, today);
                if (resp.HasValue)
                {
                    var e = resp.Value!;
                    e[col]     = (e.GetInt32(col)     ?? 0) + 1;
                    e["Damage"] = (e.GetInt32("Damage") ?? 0) + (damageOccurred ? 1 : 0);
                    await _tableClient.UpdateEntityAsync(e, e.ETag, TableUpdateMode.Replace);
                }
                else
                {
                    var e = new TableEntity(PART_METRICS, today)
                    {
                        ["Stored"] = 0, ["Retrieved"] = 0, ["Received"] = 0, ["Damage"] = 0,
                    };
                    e[col]      = 1;
                    e["Damage"] = damageOccurred ? 1 : 0;
                    await _tableClient.AddEntityAsync(e);
                }
                return;
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 412 || ex.Status == 409)
            {
                await Task.Delay(50 * (attempt + 1));
            }
        }
    }

    // ── Private: initialisation helpers ──────────────────────────────────────

    private async Task InitializeSubcategoryConfigAsync()
    {
        foreach (var (subcatId, (name, storeMin, storeMax, retrieveMin, retrieveMax)) in DefaultSubcategoryConfig)
        {
            var existing = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
                PART_SUBCAT_CONFIG, subcatId.ToString());
            if (existing.HasValue) continue;

            await _tableClient.AddEntityAsync(new TableEntity(PART_SUBCAT_CONFIG, subcatId.ToString())
            {
                ["SubcategoryId"]          = subcatId,
                ["SubcategoryName"]        = name,
                ["StoreMinMinutes"]        = storeMin,
                ["StoreMaxMinutes"]        = storeMax,
                ["RetrieveMinMinutes"]     = retrieveMin,
                ["RetrieveMaxMinutes"]     = retrieveMax,
                ["BaseWeightKgThreshold"]  = WEIGHT_THRESHOLD_KG,
                ["Note"]                   = (string?)null,
            });
        }
    }

    private async Task InitializeSupplierReceiveConfigAsync()
    {
        foreach (var (subcatId, (rMin, rMax, iMin, iMax, perUnit)) in DefaultSupplierReceiveConfig)
        {
            var existing = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
                PART_SUPPLIER_CONFIG, subcatId.ToString());
            if (existing.HasValue) continue;

            string name = DefaultSubcategoryConfig.TryGetValue(subcatId, out var sc) ? sc.Name : subcatId.ToString();

            await _tableClient.AddEntityAsync(new TableEntity(PART_SUPPLIER_CONFIG, subcatId.ToString())
            {
                ["SubcategoryId"]              = subcatId,
                ["SubcategoryName"]            = name,
                ["ReceiveMinMinutes"]           = rMin,
                ["ReceiveMaxMinutes"]           = rMax,
                ["InspectionMinMinutes"]        = iMin,
                ["InspectionMaxMinutes"]        = iMax,
                ["AdditionalMinutesPerUnit"]    = perUnit,
                ["Note"]                        = (string?)null,
            });
        }
    }

    private async Task InitializeDamageConfigAsync()
    {
        foreach (var (opType, (rate, ids)) in DefaultDamageConfig)
        {
            var existing = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_DAMAGE_CONFIG, opType);
            if (existing.HasValue) continue;

            await _tableClient.AddEntityAsync(new TableEntity(PART_DAMAGE_CONFIG, opType)
            {
                ["OperationType"]  = opType,
                ["DamageRatePct"]  = rate,
                ["DamageReasonIds"] = JsonSerializer.Serialize(ids),
                ["Note"]           = (string?)null,
            });
        }
    }

    private async Task InitializeWarehouseWorkforceAsync()
    {
        var employees = await LoadWarehouseEmployeesAsync();
        if (!employees.Any())
        {
            _logger.LogWarning("No warehouse employees found in HumanResources tables. " +
                "Run the seed job to load warehouse employee data.");
            return;
        }

        foreach (var emp in employees)
        {
            var existing = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
                PART_WORKFORCE, emp.BusinessEntityId.ToString());
            if (existing.HasValue) continue;

            double tenure = (DateTime.UtcNow - emp.HireDate).TotalDays / 365.25;

            await _tableClient.AddEntityAsync(new TableEntity(PART_WORKFORCE, emp.BusinessEntityId.ToString())
            {
                ["FullName"]       = emp.FullName,
                ["JobTitle"]       = emp.JobTitle,
                ["DepartmentId"]   = emp.DepartmentId,
                ["DepartmentName"] = emp.DepartmentName,
                ["ShiftId"]        = emp.ShiftId,
                ["ShiftName"]      = emp.ShiftName,
                ["ShiftStartHour"] = emp.ShiftStart.Hours,
                ["ShiftEndHour"]   = emp.ShiftEnd.Hours,
                ["HourlyRate"]     = emp.HourlyRate,
                ["TenureYears"]    = Math.Round(tenure, 1),
                ["VacationHours"]  = emp.VacationHours,
                ["Status"]         = "available",
                ["CurrentOperationId"] = (string?)null,
                ["CurrentOperation"]   = (string?)null,
                ["BusyUntilUtc"]       = (DateTimeOffset?)null,
            });
        }

        _logger.LogInformation("Warehouse workforce initialized: {Count} employees seeded", employees.Count);
    }

    // ── Private: SQL helpers ──────────────────────────────────────────────────

    private async Task<List<EmployeeRecord>> LoadWarehouseEmployeesAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var rows = await conn.QueryAsync(@"
            SELECT
                e.BusinessEntityID,
                p.FirstName + ' ' + p.LastName AS FullName,
                e.JobTitle,
                e.HireDate,
                e.VacationHours,
                e.SickLeaveHours,
                edh.DepartmentID,
                d.Name                                     AS DepartmentName,
                edh.ShiftID,
                s.Name                                     AS ShiftName,
                s.StartTime,
                s.EndTime,
                ISNULL(eph.Rate, 18.00)                    AS HourlyRate
            FROM HumanResources.Employee e
            INNER JOIN Person.Person p
                ON e.BusinessEntityID = p.BusinessEntityID
            INNER JOIN HumanResources.EmployeeDepartmentHistory edh
                ON e.BusinessEntityID = edh.BusinessEntityID
               AND edh.EndDate IS NULL
            INNER JOIN HumanResources.Department d
                ON edh.DepartmentID = d.DepartmentID
            INNER JOIN HumanResources.Shift s
                ON edh.ShiftID = s.ShiftID
            OUTER APPLY (
                SELECT TOP 1 Rate
                FROM HumanResources.EmployeePayHistory
                WHERE BusinessEntityID = e.BusinessEntityID
                ORDER BY RateChangeDate DESC
            ) eph
            WHERE e.CurrentFlag = 1
              AND edh.DepartmentID = @DeptId
            ORDER BY edh.ShiftID, e.BusinessEntityID",
            new { DeptId = WAREHOUSE_DEPT_ID });

        return rows.Select(r => new EmployeeRecord(
            BusinessEntityId: (int)r.BusinessEntityID,
            FullName:         (string)r.FullName,
            JobTitle:         (string)r.JobTitle,
            DepartmentId:     Convert.ToInt32(r.DepartmentID),
            DepartmentName:   (string)r.DepartmentName,
            ShiftId:          Convert.ToInt32(r.ShiftID),
            ShiftName:        (string)r.ShiftName,
            ShiftStart:       (TimeSpan)r.StartTime,
            ShiftEnd:         (TimeSpan)r.EndTime,
            HourlyRate:       (double)(decimal)r.HourlyRate,
            HireDate:         (DateTime)r.HireDate,
            VacationHours:    (int)r.VacationHours,
            SickLeaveHours:   (int)r.SickLeaveHours)).ToList();
    }

    private async Task<(string Name, int? SubcatId, string? SubcatName, double? WeightKg, double StandardCost)>
        GetProductInfoAsync(int productId)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var row = await conn.QueryFirstOrDefaultAsync(@"
            SELECT
                p.Name,
                p.ProductSubcategoryID,
                ps.Name AS SubcategoryName,
                p.Weight,
                p.StandardCost,
                p.WeightUnitMeasureCode
            FROM Production.Product p
            LEFT JOIN Production.ProductSubcategory ps
                ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            WHERE p.ProductID = @ProductId
            ORDER BY ps.ProductSubcategoryID",
            new { ProductId = productId });

        if (row == null) return ("Unknown", null, null, null, 0);

        double? weightKg = null;
        if (row.Weight != null && row.WeightUnitMeasureCode != null)
        {
            double w = (double)(decimal)row.Weight;
            weightKg = (string)row.WeightUnitMeasureCode == "LB" ? w * 0.453592 : w;
        }

        return (
            (string)row.Name,
            row.ProductSubcategoryID != null ? (int?)row.ProductSubcategoryID : null,
            row.SubcategoryName != null ? (string)row.SubcategoryName : null,
            weightKg,
            row.StandardCost != null ? (double)(decimal)row.StandardCost : 0.0);
    }

    private async Task<TableEntity?> GetSubcategoryConfigEntityAsync(int subcategoryId)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_SUBCAT_CONFIG, subcategoryId.ToString());
        return resp.HasValue ? resp.Value : null;
    }

    private async Task<TableEntity?> GetSupplierReceiveConfigEntityAsync(int subcategoryId)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_SUPPLIER_CONFIG, subcategoryId.ToString());
        return resp.HasValue ? resp.Value : null;
    }

    // ── Private: message serialization ────────────────────────────────────────

    private async Task EnqueueMessageAsync(WarehouseOperationMessage msg, TimeSpan visibilityDelay)
    {
        string json   = JsonSerializer.Serialize(msg);
        string base64 = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json));
        await _queueClient.SendMessageAsync(base64, visibilityTimeout: visibilityDelay);
    }

    // ── Private: entity mappers ───────────────────────────────────────────────

    private static SubcategoryHandlingConfig EntityToSubcategoryConfig(TableEntity e) =>
        new(
            SubcategoryId:         int.TryParse(e.RowKey, out int id) ? id : 0,
            SubcategoryName:       e.GetString("SubcategoryName") ?? "",
            StoreMinMinutes:       e.GetInt32("StoreMinMinutes") ?? 3,
            StoreMaxMinutes:       e.GetInt32("StoreMaxMinutes") ?? 10,
            RetrieveMinMinutes:    e.GetInt32("RetrieveMinMinutes") ?? 2,
            RetrieveMaxMinutes:    e.GetInt32("RetrieveMaxMinutes") ?? 8,
            BaseWeightKgThreshold: e.GetDouble("BaseWeightKgThreshold") ?? WEIGHT_THRESHOLD_KG,
            Note:                  e.GetString("Note"));

    private static SupplierReceiveConfig EntityToSupplierReceiveConfig(TableEntity e) =>
        new(
            SubcategoryId:            int.TryParse(e.RowKey, out int id) ? id : 0,
            SubcategoryName:          e.GetString("SubcategoryName") ?? "",
            ReceiveMinMinutes:        e.GetInt32("ReceiveMinMinutes") ?? 5,
            ReceiveMaxMinutes:        e.GetInt32("ReceiveMaxMinutes") ?? 15,
            InspectionMinMinutes:     e.GetInt32("InspectionMinMinutes") ?? 1,
            InspectionMaxMinutes:     e.GetInt32("InspectionMaxMinutes") ?? 4,
            AdditionalMinutesPerUnit: e.GetDouble("AdditionalMinutesPerUnit") ?? 0.3,
            Note:                     e.GetString("Note"));

    private static WarehouseDamageConfig EntityToDamageConfig(TableEntity e)
    {
        int[] ids = JsonSerializer.Deserialize<int[]>(e.GetString("DamageReasonIds") ?? "[]")
                    ?? Array.Empty<int>();
        return new(
            OperationType:  e.RowKey,
            DamageRatePct:  e.GetDouble("DamageRatePct") ?? 0.02,
            DamageReasonIds: ids,
            Note:           e.GetString("Note"));
    }

    private static string GetEffectiveWorkerStatus(TableEntity e)
    {
        string stored = e.GetString("Status") ?? "available";
        if (stored == "working")
        {
            // Auto-release if safety timeout expired
            var busyUntil = e.GetDateTimeOffset("BusyUntilUtc");
            if (busyUntil.HasValue && busyUntil.Value < DateTimeOffset.UtcNow)
                return "available";
            return "working";
        }

        int shiftStart  = e.GetInt32("ShiftStartHour") ?? 7;
        int shiftEnd    = e.GetInt32("ShiftEndHour")   ?? 15;
        int currentHour = DateTime.UtcNow.Hour;

        bool onShift = shiftStart < shiftEnd
            ? currentHour >= shiftStart && currentHour < shiftEnd
            : currentHour >= shiftStart || currentHour < shiftEnd;

        if (!onShift) return "off-shift";

        int vacHours = e.GetInt32("VacationHours") ?? 40;
        if (vacHours <= 0) return "unavailable";

        return "available";
    }
}
