using System.Text.Json;
using api_functions.Models;
using Azure.Data.Tables;
using Azure.Identity;
using Azure.Storage.Queues;
using Dapper;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

// ── Data transfer types ──────────────────────────────────────────────────────

public record VendorInfo(
    string VendorId,              // Purchasing.Vendor.BusinessEntityID as string
    string AccountNumber,         // e.g. "AUSTRALI0001"
    string Name,                  // e.g. "Australia Bike Retailer"
    string Description,           // narrative derived from CreditRating
    int CreditRating,             // 1–5 from Purchasing.Vendor (1 = best)
    bool PreferredVendorStatus,   // Purchasing.Vendor.PreferredVendorStatus
    int DefaultLeadTimeDays,      // typical lead time (avg across their products)
    double ReliabilityPct,        // derived: 1→0.97, 2→0.90, 3→0.83, 4→0.73, 5→0.65
    int ShipMethodId,             // most-used ShipMethodID from PurchaseOrderHeader history
    string ShipMethodName,        // e.g. "ZY - EXPRESS"
    double ShipBase,              // Purchasing.ShipMethod.ShipBase
    double ShipRate,              // Purchasing.ShipMethod.ShipRate (per-unit)
    int RestockDelaySimHrs,       // derived: 1→4, 2→8, 3→16, 4→30, 5→48
    string[] Strengths,
    string[] Weaknesses);

public record VendorStockItem(
    string VendorId,
    int ProductId,
    string ProductName,
    double StandardPrice,     // Purchasing.ProductVendor.StandardPrice (no multiplier)
    int AverageLeadTime,      // Purchasing.ProductVendor.AverageLeadTime (per-item)
    int MinOrderQty,          // Purchasing.ProductVendor.MinOrderQty
    int MaxOrderQty,          // Purchasing.ProductVendor.MaxOrderQty
    int CurrentStock,
    int MaxStock,
    double WeightKg);

public record SupplyQuote(
    string VendorId,
    string VendorName,
    int ProductId,
    string ProductName,
    int QtyRequested,
    int StockAvailable,
    double UnitCost,
    double ShippingCost,
    double TotalCost,
    double EstimatedDeliverySimHrs,
    double EstimatedDeliveryRealMins,
    bool InStock,
    double ReliabilityPct = 0.85,   // from vendor profile
    int LeadTimeDays = 14,           // per-item AverageLeadTime
    int MinOrderQty = 1,
    int MaxOrderQty = 10000,
    // Total quantity currently in-flight on open purchase orders (placed/confirmed/picking/
    // shipped/delayed) for this vendor+product pair. These units have already been deducted
    // from StockAvailable at the vendor; once delivered they will be added to
    // Production.ProductInventory. Use this to show "X incoming" alongside stock level.
    int IncomingQty = 0,
    // UTC timestamp of the earliest DueDate across all open in-flight orders for this
    // vendor+product pair. Null when IncomingQty == 0. Use this to show "arriving in ~X mins".
    DateTime? EarliestIncomingEtaUtc = null);

public record PurchaseOrder(
    string OrderId,
    string VendorId,
    string VendorName,
    int ProductId,
    string ProductName,
    int Qty,
    double UnitCost,
    double ShippingCost,
    double TotalCost,
    string Status,             // "pending" | "approved" | "rejected" | "complete"
    DateTime PlacedAtUtc,
    DateTime EstimatedDeliveryUtc);

public record VendorSummary(
    VendorInfo Vendor,
    int TotalComponents,
    int InStockComponents,
    int ActiveOrders,
    int DeliveredToday);

// ── Service ──────────────────────────────────────────────────────────────────

public class SupplyChainService
{
    private const string TABLE_NAME           = "awSupplyChain";
    private const string PART_STOCK           = "stock";
    private const string PART_PENDING_INJECTED = "pending-injected";

    internal const string QUEUE_NAME = "supply-chain-orders-queue";

    // ── Reliability & restock tables keyed by CreditRating (1=best, 5=worst) ──
    private static readonly double[] ReliabilityByRating    = { 0, 0.97, 0.90, 0.83, 0.73, 0.65 };
    private static readonly int[]    RestockHoursByRating   = { 0,    4,    8,   16,   30,   48 };
    // Initial stock fill ratio (fraction of MaxOrderQty at seed time)
    private static readonly double[] FillRatioByRating      = { 0, 0.90, 0.80, 0.68, 0.55, 0.45 };

    private const string PART_CONFIG = "config";
    private const string ROW_SPEED  = "speed-multiplier";

    private readonly string _connectionString;
    private readonly TableClient _tableClient;
    private readonly double _simTimeScale;
    private readonly double _defaultSpeedMultiplier;
    private readonly ILogger<SupplyChainService> _logger;
    private readonly TelemetryClient _telemetry;
    private readonly BankService? _bank;
    private readonly WarehouseService? _warehouse;

    // Vendor cache — loaded lazily from Purchasing.Vendor on first access
    private List<VendorInfo>? _vendorCache;
    private readonly SemaphoreSlim _vendorLoadLock = new(1, 1);

    // Static initialization guard — ensures InitializeAsync body runs only once per process
    // even when multiple scoped instances are created concurrently (e.g. parallel useQueries).
    private static readonly SemaphoreSlim _initLock = new(1, 1);
    private static volatile bool _initComplete = false;

    // Cached default purchasing employee ID for new PurchaseOrderHeader rows
    private int? _defaultEmployeeId;

    public SupplyChainService(
        string connectionString,
        string tableServiceUri,
        double simTimeScale,
        double supplyChainSpeedMultiplier,
        ILogger<SupplyChainService> logger,
        TelemetryClient telemetry,
        BankService? bank = null,
        WarehouseService? warehouse = null)
    {
        _connectionString = connectionString;
        _simTimeScale     = simTimeScale;
        _defaultSpeedMultiplier = supplyChainSpeedMultiplier;
        _logger           = logger;
        _telemetry        = telemetry;
        _bank             = bank;
        _warehouse        = warehouse;

        var svc = new TableServiceClient(new Uri(tableServiceUri), new DefaultAzureCredential());
        _tableClient = svc.GetTableClient(TABLE_NAME);
    }

    // ── Vendor loading (replaces static list) ────────────────────────────────

    private async Task<IReadOnlyList<VendorInfo>> GetVendorsAsync()
    {
        if (_vendorCache != null) return _vendorCache;
        await _vendorLoadLock.WaitAsync();
        try
        {
            if (_vendorCache != null) return _vendorCache;
            _vendorCache = await LoadVendorsFromSqlAsync();
            _logger.LogInformation("Loaded {Count} active vendors from Purchasing.Vendor", _vendorCache.Count);
            return _vendorCache;
        }
        finally { _vendorLoadLock.Release(); }
    }

    private async Task<List<VendorInfo>> LoadVendorsFromSqlAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Load vendors that actually have entries in ProductVendor for BOM components.
        // Join to historical PurchaseOrderHeader to determine each vendor's most-used ship method.
        var rows = await conn.QueryAsync(@"
            SELECT v.BusinessEntityID,
                   v.AccountNumber,
                   v.Name,
                   v.CreditRating,
                   CAST(v.PreferredVendorStatus AS INT) AS PreferredVendorStatus,
                   ISNULL(top_sm.ShipMethodID, 5)  AS ShipMethodId,
                   ISNULL(sm.Name, 'CARGO TRANSPORT 5') AS ShipMethodName,
                   ISNULL(sm.ShipBase, 8.99)        AS ShipBase,
                   ISNULL(sm.ShipRate, 1.49)        AS ShipRate,
                   AVG(CAST(pv.AverageLeadTime AS FLOAT)) AS AvgLeadTime
            FROM Purchasing.Vendor v
            INNER JOIN Purchasing.ProductVendor pv
                ON v.BusinessEntityID = pv.BusinessEntityID
            INNER JOIN Production.Product p ON pv.ProductID = p.ProductID
            INNER JOIN Production.BillOfMaterials bom
                ON bom.ComponentID = p.ProductID AND bom.EndDate IS NULL
            LEFT JOIN (
                SELECT poh.VendorID,
                       poh.ShipMethodID,
                       ROW_NUMBER() OVER (PARTITION BY poh.VendorID
                                         ORDER BY COUNT(*) DESC) AS rn
                FROM Purchasing.PurchaseOrderHeader poh
                GROUP BY poh.VendorID, poh.ShipMethodID
            ) top_sm ON v.BusinessEntityID = top_sm.VendorID AND top_sm.rn = 1
            LEFT JOIN Purchasing.ShipMethod sm ON top_sm.ShipMethodID = sm.ShipMethodID
            WHERE v.ActiveFlag = 1
              AND p.MakeFlag = 0
            GROUP BY v.BusinessEntityID, v.AccountNumber, v.Name, v.CreditRating,
                     v.PreferredVendorStatus, top_sm.ShipMethodID, sm.Name, sm.ShipBase, sm.ShipRate
            ORDER BY v.CreditRating, v.Name");

        var result = new List<VendorInfo>();
        foreach (var r in rows)
        {
            int cr          = (int)r.CreditRating;
            bool preferred  = (int)r.PreferredVendorStatus == 1;
            int  leadDays   = (int)Math.Round((double)r.AvgLeadTime);
            double rel      = cr >= 1 && cr <= 5 ? ReliabilityByRating[cr] : 0.80;
            int   restock   = cr >= 1 && cr <= 5 ? RestockHoursByRating[cr] : 16;

            result.Add(new VendorInfo(
                VendorId:             ((int)r.BusinessEntityID).ToString(),
                AccountNumber:        (string)r.AccountNumber,
                Name:                 (string)r.Name,
                Description:          BuildDescription(cr, preferred, (string)r.Name),
                CreditRating:         cr,
                PreferredVendorStatus: preferred,
                DefaultLeadTimeDays:  leadDays,
                ReliabilityPct:       rel,
                ShipMethodId:         (int)r.ShipMethodId,
                ShipMethodName:       (string)r.ShipMethodName,
                ShipBase:             (double)r.ShipBase,
                ShipRate:             (double)r.ShipRate,
                RestockDelaySimHrs:   restock,
                Strengths:            BuildStrengths(cr, preferred, leadDays),
                Weaknesses:           BuildWeaknesses(cr, preferred)));
        }
        return result;
    }

    private static string BuildDescription(int cr, bool preferred, string name) => cr switch
    {
        1 => $"{name} is a top-rated vendor" + (preferred ? " and preferred supplier" : "") + " with excellent credit standing and fast, reliable delivery.",
        2 => $"{name} has a strong performance record with good reliability and competitive lead times.",
        3 => $"{name} offers average reliability and pricing. Suitable for non-urgent orders where cost matters.",
        4 => $"{name} is a budget option with below-average reliability. Expect occasional delays and quality variance.",
        5 => $"{name} is a high-risk, low-cost supplier. Use only when no alternatives exist — delays are common.",
        _ => name
    };

    private static string[] BuildStrengths(int cr, bool preferred, int leadDays) => cr switch
    {
        1 => preferred
            ? new[] { "Preferred vendor status", "Top credit rating", $"{leadDays}-day lead time" }
            : new[] { "Top credit rating", "Highly reliable", $"{leadDays}-day lead time" },
        2 => new[] { "Good reliability", $"{leadDays}-day lead time", "Consistent delivery" },
        3 => new[] { "Competitive pricing", "Average reliability" },
        4 => new[] { "Lower unit costs", "Budget option for bulk orders" },
        5 => new[] { "Lowest prices", "High-volume capacity" },
        _ => Array.Empty<string>()
    };

    private static string[] BuildWeaknesses(int cr, bool preferred) => cr switch
    {
        1 => new[] { "Premium pricing" + (!preferred ? ", not preferred" : "") },
        2 => new[] { "Slightly above market price" },
        3 => new[] { "Not the cheapest", "Average lead times" },
        4 => new[] { "Below-average credit rating", "Occasional delays", "Quality variance" },
        5 => new[] { "Poorest credit rating", "High delay risk", "Frequent quality issues", "Very slow restock" },
        _ => Array.Empty<string>()
    };

    // ── Initialisation ────────────────────────────────────────────────────────

    /// <summary>
    /// Idempotent: creates the SQL extension tables and seeds vendor stock in Table Storage
    /// from Purchasing.ProductVendor if not already present.
    /// Called lazily from the first GET /api/supply/* request.
    /// </summary>
    public async Task InitializeAsync()
    {
        // Fast path: already initialized in this process — skip all work.
        if (_initComplete) return;

        await _initLock.WaitAsync();
        try
        {
            // Double-check after acquiring lock in case another request just finished.
            if (_initComplete) return;

            // Process any existing Approved (Status=2) BOM vendor POs from the AdventureWorks data.
            // Runs once per process lifetime; idempotent — POs already at Status=3/4 will not match.
            await ProcessHistoricalApprovedOrdersAsync();

            // Table Storage used only for vendor stock levels
            await _tableClient.CreateIfNotExistsAsync();

            // Fast path: if stock rows already exist, skip all seeding work.
            // We still need to run ProcessHistoricalPendingOrdersAsync even when already seeded
            // because it is idempotent (guarded by SimOrderState) and handles the queue injection.
            bool alreadySeeded = false;
            await foreach (var _ in _tableClient.QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{PART_STOCK}'",
                maxPerPage: 1,
                select: new[] { "RowKey" }))
            {
                alreadySeeded = true;
                break;
            }

            // Fetch pending BOM orders before seeding so stock accounts for already-committed qty.
            // Returns (VendorId, ProductId) → total OrderQty across all Status=1 BOM POs.
            var pendingQtys = await GetPendingBomOrderQtysAsync();

            if (!alreadySeeded)
            {
                var vendors         = await GetVendorsAsync();
                var vendorDict      = vendors.ToDictionary(v => v.VendorId);
                var vendorProducts  = await GetVendorProductsFromSqlAsync();
                var historicalStock = await GetHistoricalStockLevelsAsync();

                int seededFromHistory = 0, seededFromFormula = 0;

                foreach (var vp in vendorProducts)
                {
                    if (!vendorDict.TryGetValue(vp.VendorId, out var vendor)) continue;

                    var rowKey   = StockRowKey(vp.VendorId, vp.ProductId);
                    int maxStock = Math.Max(vp.MaxOrderQty, 10);

                    int initStock;
                    if (historicalStock.TryGetValue((vp.VendorId, vp.ProductId), out int histQty))
                    {
                        // Seed from the average stocked qty on completed POs for this vendor+product,
                        // randomised ±20 % to give a realistic spread across runs.
                        initStock = (int)Math.Round(histQty * (0.8 + 0.4 * Random.Shared.NextDouble()));
                        initStock = Math.Clamp(initStock, 0, maxStock);
                        seededFromHistory++;
                    }
                    else
                    {
                        // No purchase history for this pair — fall back to credit-rating fill ratio
                        double fillRatio = vendor.CreditRating >= 1 && vendor.CreditRating <= 5
                            ? FillRatioByRating[vendor.CreditRating] : 0.70;
                        initStock = (int)Math.Round(maxStock * fillRatio
                            * (0.7 + 0.6 * Random.Shared.NextDouble()));
                        initStock = Math.Clamp(initStock, 0, maxStock);
                        seededFromFormula++;
                    }

                    // Deduct qty already committed in Status=1 (Pending) BOM purchase orders so
                    // that stockAvailable accurately reflects what is still orderable at this vendor.
                    if (pendingQtys.TryGetValue((vp.VendorId, vp.ProductId), out int pendingQty))
                        initStock = Math.Max(0, initStock - pendingQty);

                    var entity = new TableEntity(PART_STOCK, rowKey)
                    {
                        ["VendorId"]        = vp.VendorId,
                        ["ProductId"]       = vp.ProductId,
                        ["ProductName"]     = vp.ProductName,
                        ["StandardPrice"]   = vp.StandardPrice,
                        ["AverageLeadTime"] = vp.AverageLeadTime,
                        ["MinOrderQty"]     = vp.MinOrderQty,
                        ["MaxOrderQty"]     = vp.MaxOrderQty,
                        ["WeightKg"]        = vp.WeightKg > 0 ? vp.WeightKg : 0.5,
                        ["CurrentStock"]    = initStock,
                        ["MaxStock"]        = maxStock,
                    };
                    await _tableClient.UpsertEntityAsync(entity);
                }

                _logger.LogInformation(
                    "Supply chain initialized: {VendorCount} vendors, {ProductCount} vendor-product pairs " +
                    "({FromHistory} seeded from PO history, {FromFormula} from fill-ratio fallback)",
                    vendors.Count, vendorProducts.Count, seededFromHistory, seededFromFormula);
            }

            // Inject historical Pending (Status=1) BOM orders into the queue so they go through
            // the normal approval → delivery state machine.
            await ProcessHistoricalPendingOrdersAsync(pendingQtys);

            _initComplete = true;
        }
        finally
        {
            _initLock.Release();
        }
    }

    /// <summary>
    /// Returns the total <c>OrderQty</c> committed in Status=1 (Pending) purchase orders
    /// scoped to BOM purchased components with active vendors.
    /// Used during stock seeding to deduct already-committed quantities.
    /// </summary>
    private async Task<Dictionary<(string VendorId, int ProductId), int>> GetPendingBomOrderQtysAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var rows = await conn.QueryAsync(@"
            SELECT CAST(poh.VendorID AS VARCHAR(20)) AS VendorId,
                   pod.ProductID,
                   SUM(CAST(pod.OrderQty AS INT)) AS TotalQty
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
            INNER JOIN Production.Product p ON pod.ProductID = p.ProductID
            INNER JOIN Production.BillOfMaterials bom
                ON bom.ComponentID = p.ProductID AND bom.EndDate IS NULL
            WHERE poh.Status = 1
              AND v.ActiveFlag = 1
              AND p.MakeFlag = 0
            GROUP BY poh.VendorID, pod.ProductID");

        return rows.ToDictionary(
            r => ((string)r.VendorId, (int)r.ProductID),
            r => (int)r.TotalQty);
    }

    /// <summary>
    /// Injects historical Status=1 (Pending) BOM purchase orders into the supply-chain queue
    /// so they proceed through the normal pending → approved → complete/rejected state machine.
    /// Messages are staggered 1 second apart to avoid a thundering-herd on SQL.
    /// </summary>
    private async Task ProcessHistoricalPendingOrdersAsync(
        Dictionary<(string VendorId, int ProductId), int> pendingQtys)
    {
        if (pendingQtys.Count == 0) return;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Find Status=1 BOM POs with active vendors.
        var pendingPos = await conn.QueryAsync(@"
            SELECT poh.PurchaseOrderID,
                   CAST(poh.VendorID AS VARCHAR(20)) AS VendorId,
                   pod.ProductID,
                   CAST(pod.OrderQty AS INT) AS Qty,
                   pod.DueDate
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
            INNER JOIN Production.Product p ON pod.ProductID = p.ProductID
            INNER JOIN Production.BillOfMaterials bom
                ON bom.ComponentID = p.ProductID AND bom.EndDate IS NULL
            WHERE poh.Status = 1
              AND v.ActiveFlag = 1
              AND p.MakeFlag = 0");

        var poList = pendingPos.AsList();
        if (poList.Count == 0) return;

        // Build queue client
        string? queueUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        QueueClient queueClient;
        if (!string.IsNullOrEmpty(queueUri))
        {
            var qSvc = new QueueServiceClient(new Uri(queueUri), new DefaultAzureCredential());
            queueClient = qSvc.GetQueueClient(QUEUE_NAME);
        }
        else
        {
            string connStr = Environment.GetEnvironmentVariable("AzureWebJobsStorage") ?? "UseDevelopmentStorage=true";
            queueClient = new QueueClient(connStr, QUEUE_NAME,
                new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
        }
        await queueClient.CreateIfNotExistsAsync();

        // Load recently-injected PO tracking rows to prevent duplicate queue messages.
        // Any PO injected within the last 10 minutes is considered "in flight" and skipped.
        // This guards against the scenario where InitializeAsync is called on every HTTP request
        // and would otherwise flood the queue with duplicate approval messages.
        var recentlyInjected = new HashSet<int>();
        var cutoff = DateTimeOffset.UtcNow.AddMinutes(-10);
        await foreach (var entity in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_PENDING_INJECTED}'",
            select: new[] { "RowKey", "InjectedAt" }))
        {
            if (entity.GetDateTimeOffset("InjectedAt") is DateTimeOffset injectedAt
                && injectedAt >= cutoff
                && int.TryParse(entity.RowKey, out int trackedId))
            {
                recentlyInjected.Add(trackedId);
            }
        }

        int enqueued = 0;
        for (int i = 0; i < poList.Count; i++)
        {
            var r    = poList[i];
            int poId = (int)r.PurchaseOrderID;
            DateTime eta = ((DateTime)r.DueDate).ToUniversalTime();

            // Idempotency guard: skip POs that were already injected within the last 10 minutes.
            if (recentlyInjected.Contains(poId)) continue;

            _telemetry.TrackEvent("SupplyChainOrder", new Dictionary<string, string>
            {
                ["PurchaseOrderId"] = poId.ToString(),
                ["EventType"]       = "pending",
                ["Description"]     = "Order found in AdventureWorks seed data with Status=Pending. Injected into approval queue.",
            });

            // Stagger 1 second per order (5 sec base + index offset) so SQL approval writes
            // don't all land simultaneously.
            int approvalDelaySec = PendingToApprovedSimSec + i;

            var msg = new PurchaseOrderMessage
            {
                MessageType    = "order-transition",
                OrderId        = poId.ToString(),
                TargetStatus   = "approved",
                ScheduledAtUtc = DateTime.UtcNow.AddSeconds(approvalDelaySec),
            };
            string json    = System.Text.Json.JsonSerializer.Serialize(msg);
            string encoded = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json));
            await queueClient.SendMessageAsync(encoded,
                visibilityTimeout: TimeSpan.FromSeconds(approvalDelaySec));

            // Mark this PO as recently injected so subsequent calls within 10 min skip it.
            var trackEntity = new TableEntity(PART_PENDING_INJECTED, poId.ToString())
            {
                ["InjectedAt"] = DateTimeOffset.UtcNow,
            };
            await _tableClient.UpsertEntityAsync(trackEntity);

            enqueued++;
        }

        if (enqueued > 0)
            _logger.LogInformation(
                "Injected {Count} historical Pending BOM POs into the supply-chain approval queue " +
                "(staggered 1s apart, first fires in {BaseDelay}s). {Skipped} already in-flight POs skipped.",
                enqueued, PendingToApprovedSimSec, poList.Count - enqueued);
        else
            _logger.LogDebug(
                "ProcessHistoricalPendingOrders: all {Count} Status=1 POs were injected within the last 10 minutes; skipping.",
                poList.Count);
    }

    // Mirrors the constant in PurchaseOrderProcessorFunction / SupplyChainControlFunction.
    private const int PendingToApprovedSimSec = 5;

    private async Task ProcessHistoricalApprovedOrdersAsync()
    {
        var vendors = await GetVendorsAsync();
        var vendorReliability = vendors.ToDictionary(
            v => v.VendorId,
            v => v.ReliabilityPct);

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Find approved POs for BOM purchased components with active vendors.
        // Idempotent: POs already at Status=3/4 won't be selected by WHERE poh.Status = 2.
        // Scoped to historical seed-data orders (OrderDate > 1 day old) to avoid immediately
        // completing simulator-placed orders that the queue processor is already handling.
        var pending = await conn.QueryAsync(@"
            SELECT poh.PurchaseOrderID,
                   CAST(poh.VendorID AS VARCHAR(20))   AS VendorId,
                   pod.ProductID,
                   CAST(pod.OrderQty   AS INT)   AS Qty,
                   CAST(pod.UnitPrice  AS FLOAT) AS UnitCost,
                   pod.DueDate
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
            INNER JOIN Production.Product p ON pod.ProductID = p.ProductID
            INNER JOIN Production.BillOfMaterials bom
                ON bom.ComponentID = p.ProductID AND bom.EndDate IS NULL
            WHERE poh.Status = 2
              AND v.ActiveFlag = 1
              AND p.MakeFlag = 0
              AND poh.OrderDate < DATEADD(day, -1, GETDATE())");

        int passed = 0, rejected = 0;
        foreach (var r in pending)
        {
            int    poId     = (int)r.PurchaseOrderID;
            string vendorId = (string)r.VendorId;
            int    productId= (int)r.ProductID;
            int    qty      = (int)r.Qty;
            double unitCost = (double)r.UnitCost;

            double reliability = vendorReliability.TryGetValue(vendorId, out double rel) ? rel : 0.85;

            if (Random.Shared.NextDouble() <= reliability)
            {
                // Reliability passed → deliver
                await conn.ExecuteAsync(@"
                    UPDATE Purchasing.PurchaseOrderHeader
                    SET Status = 4, RevisionNumber = RevisionNumber + 1, ModifiedDate = GETDATE()
                    WHERE PurchaseOrderID = @Id",
                    new { Id = poId });
                await conn.ExecuteAsync(@"
                    UPDATE Purchasing.PurchaseOrderDetail
                    SET ReceivedQty = @Qty, ModifiedDate = GETDATE()
                    WHERE PurchaseOrderID = @Id",
                    new { Id = poId, Qty = (decimal)qty });
                await AddToSqlInventoryAsync(productId, qty, vendorId, unitCost, poId);
                _telemetry.TrackEvent("SupplyChainOrder", new Dictionary<string, string>
                {
                    ["PurchaseOrderId"] = poId.ToString(),
                    ["EventType"]       = "complete",
                    ["Description"]     = $"Reliability check passed. {qty} units of ProductID {productId} delivered and added to inventory.",
                });
                passed++;
            }
            else
            {
                // Reliability failed → reject
                await conn.ExecuteAsync(@"
                    UPDATE Purchasing.PurchaseOrderHeader
                    SET Status = 3, RevisionNumber = RevisionNumber + 1, ModifiedDate = GETDATE()
                    WHERE PurchaseOrderID = @Id",
                    new { Id = poId });
                _telemetry.TrackEvent("SupplyChainOrder", new Dictionary<string, string>
                {
                    ["PurchaseOrderId"] = poId.ToString(),
                    ["EventType"]       = "rejected",
                    ["Description"]     = $"Reliability check failed (vendor reliability: {reliability:P0}). Order rejected.",
                });
                rejected++;
            }
        }

        if (passed + rejected > 0)
            _logger.LogInformation(
                "Processed {Total} historical Approved POs: {Passed} delivered, {Rejected} rejected.",
                passed + rejected, passed, rejected);
    }

    // ── Vendor read ────────────────────────────────────────────────────────────

    public async Task<VendorInfo?> GetVendorAsync(string vendorId)
    {
        var vendors = await GetVendorsAsync();
        return vendors.FirstOrDefault(v => v.VendorId == vendorId);
    }

    public async Task<List<VendorSummary>> GetVendorSummariesAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var vendors = await GetVendorsAsync();

        // Count active and delivered-today orders per vendor from SQL
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var orderStats = (await conn.QueryAsync(@"
            SELECT CAST(poh.VendorID AS VARCHAR(20)) AS VendorId,
                   SUM(CASE WHEN poh.Status = 2 THEN 1 ELSE 0 END) AS ActiveOrders,
                   SUM(CASE WHEN poh.Status = 4
                             AND CAST(poh.ModifiedDate AS DATE) = CAST(GETUTCDATE() AS DATE)
                            THEN 1 ELSE 0 END) AS DeliveredToday
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
            INNER JOIN Production.Product p ON pod.ProductID = p.ProductID
            INNER JOIN Production.BillOfMaterials bom ON bom.ComponentID = p.ProductID AND bom.EndDate IS NULL
            WHERE v.ActiveFlag = 1 AND p.MakeFlag = 0
            GROUP BY poh.VendorID"))
            .ToDictionary(
                r => (string)r.VendorId,
                r => ((int)r.ActiveOrders, (int)r.DeliveredToday));

        var result = new List<VendorSummary>();
        foreach (var v in vendors)
        {
            int totalComponents = 0, inStock = 0;
            await foreach (var e in _tableClient.QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{PART_STOCK}' and VendorId eq '{v.VendorId}'"))
            {
                totalComponents++;
                if ((e.GetInt32("CurrentStock") ?? 0) > 0) inStock++;
            }
            var (activeOrders, deliveredToday) = orderStats.TryGetValue(v.VendorId, out var s) ? s : (0, 0);
            result.Add(new VendorSummary(v, totalComponents, inStock, activeOrders, deliveredToday));
        }
        return result;
    }

    // ── Catalog / quote ────────────────────────────────────────────────────────

    /// <summary>
    /// Builds a (vendorId, productId) → incomingQty lookup from all open purchase orders
    /// (Status=2 Approved — in transit). Sourced from SQL.
    /// </summary>
    private record IncomingEntry(int Qty, DateTime? EarliestEta);

    private async Task<Dictionary<(string VendorId, int ProductId), IncomingEntry>> GetIncomingQtyMapAsync(
        string? scopeVendorId = null, int? scopeProductId = null)
    {
        var map = new Dictionary<(string, int), IncomingEntry>();

        string whereExtra = "";
        if (!string.IsNullOrEmpty(scopeVendorId))
            whereExtra += $" AND poh.VendorID = {int.Parse(scopeVendorId)}";
        if (scopeProductId.HasValue)
            whereExtra += $" AND pod.ProductID = {scopeProductId.Value}";

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var rows = await conn.QueryAsync($@"
            SELECT CAST(poh.VendorID AS VARCHAR(20)) AS VendorId,
                   pod.ProductID,
                   CAST(pod.OrderQty AS INT) AS Qty,
                   pod.DueDate AS EarliestEta
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
            INNER JOIN Production.Product p ON pod.ProductID = p.ProductID
            INNER JOIN Production.BillOfMaterials bom ON bom.ComponentID = p.ProductID AND bom.EndDate IS NULL
            WHERE poh.Status IN (1, 2) AND v.ActiveFlag = 1 AND p.MakeFlag = 0{whereExtra}");

        foreach (var r in rows)
        {
            var key = ((string)r.VendorId, (int)r.ProductID);
            int addQty = (int)r.Qty;
            DateTime? eta = r.EarliestEta is DateTime d ? (DateTime?)d.ToUniversalTime() : null;
            if (map.TryGetValue(key, out var cur))
            {
                DateTime? minEta = (cur.EarliestEta.HasValue && eta.HasValue)
                    ? (cur.EarliestEta.Value < eta.Value ? cur.EarliestEta : eta)
                    : (cur.EarliestEta ?? eta);
                map[key] = new IncomingEntry(cur.Qty + addQty, minEta);
            }
            else
            {
                map[key] = new IncomingEntry(addQty, eta);
            }
        }
        return map;
    }

    public async Task<List<SupplyQuote>> GetCatalogAsync(int? filterProductId = null)
    {
        await _tableClient.CreateIfNotExistsAsync();
        var vendors = await GetVendorsAsync();
        var vendorDict = vendors.ToDictionary(v => v.VendorId);

        // Load all in-flight order quantities in a single pass so StockAvailable
        // can be supplemented with IncomingQty without an N+1 query per catalog row.
        var incomingMap = await GetIncomingQtyMapAsync(scopeProductId: filterProductId);

        var quotes = new List<SupplyQuote>();

        string filter = $"PartitionKey eq '{PART_STOCK}'";
        if (filterProductId.HasValue)
            filter += $" and ProductId eq {filterProductId.Value}";

        await foreach (var e in _tableClient.QueryAsync<TableEntity>(filter: filter))
        {
            var vendorId = e.GetString("VendorId") ?? "";
            if (!vendorDict.TryGetValue(vendorId, out var vendor)) continue;

            int    productId    = e.GetInt32("ProductId") ?? 0;
            string name         = e.GetString("ProductName") ?? productId.ToString();
            double standardPrice= e.GetDouble("StandardPrice") ?? e.GetDouble("UnitCostBase") ?? 1.0; // fallback for legacy rows
            int    leadTime     = e.GetInt32("AverageLeadTime") ?? vendor.DefaultLeadTimeDays;
            int    minQty       = e.GetInt32("MinOrderQty") ?? 1;
            int    maxQty       = e.GetInt32("MaxOrderQty") ?? 10000;
            double weight       = e.GetDouble("WeightKg") ?? 0.5;
            int    stock        = e.GetInt32("CurrentStock") ?? 0;
            int       incoming    = incomingMap.TryGetValue((vendorId, productId), out var ie) ? ie.Qty : 0;
            DateTime? earliestEta = ie?.EarliestEta;

            double shipping     = Math.Round(vendor.ShipBase + weight * vendor.ShipRate, 2);
            double simHrs       = leadTime * 24.0;
            double realMins     = simHrs * 60.0 / _simTimeScale;

            quotes.Add(new SupplyQuote(
                vendorId, vendor.Name, productId, name,
                QtyRequested: 1, stock,
                UnitCost: Math.Round(standardPrice, 2),
                ShippingCost: shipping,
                TotalCost: Math.Round(standardPrice + shipping, 2),
                simHrs, realMins, stock > 0,
                ReliabilityPct: vendor.ReliabilityPct,
                LeadTimeDays: leadTime,
                MinOrderQty: minQty,
                MaxOrderQty: maxQty,
                IncomingQty: incoming,
                EarliestIncomingEtaUtc: earliestEta));
        }
        return quotes.OrderBy(q => q.ProductId).ThenBy(q => q.TotalCost).ToList();
    }

    public async Task<SupplyQuote?> GetQuoteAsync(string vendorId, int productId, int qty)
    {
        await _tableClient.CreateIfNotExistsAsync();
        var vendors = await GetVendorsAsync();
        var vendor  = vendors.FirstOrDefault(v => v.VendorId == vendorId);
        if (vendor == null) return null;

        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_STOCK, StockRowKey(vendorId, productId));
        if (!resp.HasValue) return null;

        var e = resp.Value!;
        double standardPrice = e.GetDouble("StandardPrice") ?? e.GetDouble("UnitCostBase") ?? 1.0;
        int    leadTime      = e.GetInt32("AverageLeadTime") ?? vendor.DefaultLeadTimeDays;
        int    minQty        = e.GetInt32("MinOrderQty") ?? 1;
        int    maxQty        = e.GetInt32("MaxOrderQty") ?? 10000;
        double weight        = e.GetDouble("WeightKg") ?? 0.5;
        int    stock         = e.GetInt32("CurrentStock") ?? 0;
        string name          = e.GetString("ProductName") ?? productId.ToString();
        double shipping      = Math.Round(vendor.ShipBase + weight * vendor.ShipRate * qty, 2);
        double simHrs        = leadTime * 24.0;
        double realMins      = simHrs * 60.0 / _simTimeScale;

        // Tally in-flight orders scoped to this exact vendor+product
        var incomingMap = await GetIncomingQtyMapAsync(scopeVendorId: vendorId, scopeProductId: productId);
        int incoming = incomingMap.TryGetValue((vendorId, productId), out var ie) ? ie.Qty : 0;
        DateTime? earliestEta = ie?.EarliestEta;

        return new SupplyQuote(
            vendorId, vendor.Name, productId, name, qty, stock,
            UnitCost: Math.Round(standardPrice, 2),
            shipping,
            TotalCost: Math.Round(standardPrice * qty + shipping, 2),
            simHrs, realMins, stock >= qty,
            ReliabilityPct: vendor.ReliabilityPct,
            LeadTimeDays: leadTime,
            MinOrderQty: minQty,
            MaxOrderQty: maxQty,
            IncomingQty: incoming,
            EarliestIncomingEtaUtc: earliestEta);
    }

    // ── Order placement ────────────────────────────────────────────────────────

    /// <summary>
    /// Places a purchase order. Deducts stock from Table Storage immediately (prevents oversell).
    /// Creates Purchasing.PurchaseOrderHeader/Detail + SimOrderState in SQL as the primary state.
    /// Returns null if vendorId/productId invalid or insufficient stock.
    /// The returned <see cref="PurchaseOrder.OrderId"/> is the SQL PurchaseOrderID as a string.
    /// </summary>
    public async Task<PurchaseOrder?> PlaceOrderAsync(string vendorId, int productId, int qty)
    {
        var vendors = await GetVendorsAsync();
        var vendor  = vendors.FirstOrDefault(v => v.VendorId == vendorId);
        if (vendor == null || qty <= 0) return null;

        // Read + deduct stock atomically via ETag (Table Storage still owns vendor stock)
        var stockResp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_STOCK, StockRowKey(vendorId, productId));
        if (!stockResp.HasValue) return null;

        var stock  = stockResp.Value!;
        int minQty = stock.GetInt32("MinOrderQty") ?? 1;
        int maxQty = stock.GetInt32("MaxOrderQty") ?? int.MaxValue;
        if (qty < minQty || qty > maxQty) return null;

        int current = stock.GetInt32("CurrentStock") ?? 0;
        if (current < qty) return null;

        stock["CurrentStock"] = current - qty;
        try
        {
            await _tableClient.UpdateEntityAsync(stock, stock.ETag);
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 412 || ex.Status == 409)
        {
            // Concurrent order — re-read and retry once
            stockResp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
                PART_STOCK, StockRowKey(vendorId, productId));
            if (!stockResp.HasValue) return null;
            stock   = stockResp.Value!;
            current = stock.GetInt32("CurrentStock") ?? 0;
            if (current < qty) return null;
            stock["CurrentStock"] = current - qty;
            await _tableClient.UpdateEntityAsync(stock, stock.ETag);
        }

        double standardPrice = stock.GetDouble("StandardPrice") ?? stock.GetDouble("UnitCostBase") ?? 1.0;
        int    leadTime      = stock.GetInt32("AverageLeadTime") ?? vendor.DefaultLeadTimeDays;
        double weight        = stock.GetDouble("WeightKg") ?? 0.5;
        string name          = stock.GetString("ProductName") ?? productId.ToString();
        double unitCost      = Math.Round(standardPrice, 2);
        double shipping      = Math.Round(vendor.ShipBase + weight * vendor.ShipRate * qty, 2);
        double total         = Math.Round(unitCost * qty + shipping, 2);
        double simHrs        = leadTime * 24.0;
        DateTime placed      = DateTime.UtcNow;
        DateTime eta         = placed.AddSeconds(simHrs * 3600.0 / _simTimeScale);

        if (!int.TryParse(vendorId, out int vendorBusinessId)) return null;

        // SQL is the primary state — create PurchaseOrderHeader, Detail, and SimOrderState
        int purchaseOrderId = await InsertSqlPurchaseOrderAsync(
            vendorBusinessId, vendor.ShipMethodId, placed, eta,
            productId, qty, unitCost, shipping);

        _logger.LogInformation(
            "PO {OrderId} placed: {Qty}x ProductID={ProductId} from {Vendor}, ETA={Eta:u}",
            purchaseOrderId, qty, productId, vendor.Name, eta);

        return await GetOrderAsync(purchaseOrderId.ToString());
    }

    // ── Order state transitions ────────────────────────────────────────────────

    /// <summary>
    /// Advances a purchase order through the simulation state machine using
    /// <c>PurchaseOrderHeader.Status</c> as the single source of truth.
    /// <paramref name="orderId"/> is the SQL <c>PurchaseOrderID</c> as a string.
    /// <para>Valid transitions:
    /// <c>pending(1) → approved(2)</c>,
    /// <c>approved(2) → complete(4)</c>,
    /// <c>approved(2) → rejected(3)</c>,
    /// <c>pending(1) → rejected(3)</c> (cancellation path).
    /// </para>
    /// </summary>
    public async Task<bool> TransitionOrderAsync(string orderId, string targetStatus)
    {
        if (!int.TryParse(orderId, out int purchaseOrderId)) return false;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // A PO can have multiple detail lines; use QueryAsync to handle all of them.
        var rows = (await conn.QueryAsync(@"
            SELECT poh.Status                          AS PoStatus,
                   CAST(poh.VendorID AS VARCHAR(20))   AS VendorId,
                   v.Name                              AS VendorName,
                   pod.ProductID,
                   CAST(pod.OrderQty AS INT)            AS Qty,
                   CAST(pod.UnitPrice AS FLOAT)         AS UnitCost,
                   CAST(poh.TotalDue AS FLOAT)          AS TotalDue
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
            WHERE poh.PurchaseOrderID = @Id",
            new { Id = purchaseOrderId })).AsList();

        if (rows.Count == 0) return false;

        var firstRow = rows[0];
        int currentPoStatus = (int)firstRow.PoStatus;

        // Validate transition against current PurchaseOrderHeader.Status
        bool valid = (currentPoStatus, targetStatus) switch
        {
            (1, "approved")  => true,
            (2, "complete")  => true,
            (2, "rejected")  => true,
            (1, "rejected")  => true,  // cancellation from pending
            _                => false,
        };
        if (!valid) return false;

        string vendorId   = (string)firstRow.VendorId;
        string vendorName = (string)firstRow.VendorName;
        double totalDue   = (double)firstRow.TotalDue;

        byte newPoStatus = targetStatus switch
        {
            "approved" => 2,
            "complete" => 4,
            "rejected" => 3,
            _          => throw new InvalidOperationException($"Unexpected target: {targetStatus}"),
        };
        await UpdateSqlPurchaseOrderAsync(conn, purchaseOrderId, newPoStatus);

        if (targetStatus == "complete")
        {
            int totalQty = 0;
            foreach (var row in rows)
            {
                int    productId = (int)row.ProductID;
                int    qty       = (int)row.Qty;
                double unitCost  = (double)row.UnitCost;
                await UpdateSqlPurchaseOrderAsync(conn, purchaseOrderId, status: 4, receivedQty: qty);
                await AddToSqlInventoryAsync(productId, qty, vendorId, unitCost, purchaseOrderId);
                totalQty += qty;
            }
            _telemetry.TrackEvent("SupplyChainOrder", new Dictionary<string, string>
            {
                ["PurchaseOrderId"] = purchaseOrderId.ToString(),
                ["EventType"]       = "complete",
                ["Description"]     = $"Delivery confirmed. {totalQty} units across {rows.Count} line(s) added to Production.ProductInventory.",
            });
        }
        else if (targetStatus == "rejected")
        {
            foreach (var row in rows)
            {
                await RefundStockAsync(vendorId, (int)row.ProductID, (int)row.Qty);
            }
            _telemetry.TrackEvent("SupplyChainOrder", new Dictionary<string, string>
            {
                ["PurchaseOrderId"] = purchaseOrderId.ToString(),
                ["EventType"]       = "rejected",
                ["Description"]     = "Order rejected. Vendor stock refunded.",
            });

            // Bank: refund the PO debit if it was previously approved (status was 2)
            if (currentPoStatus == 2 && _bank != null)
            {
                try
                {
                    await _bank.InitializeAsync();
                    await _bank.PostTransactionAsync(new BankTransactionRequest(
                        CurrencyCode:    "USD",
                        Amount:          (decimal)totalDue,
                        Description:     $"PO-{purchaseOrderId} refund: {vendorName} delivery failed — vendor stock returned",
                        ReferenceId:     $"PO-{purchaseOrderId}-refund",
                        TransactionType: "other"));
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[Bank] Failed to record PO refund for PO {PurchaseOrderId} — continuing.", purchaseOrderId);
                }
            }
        }
        else // approved
        {
            _telemetry.TrackEvent("SupplyChainOrder", new Dictionary<string, string>
            {
                ["PurchaseOrderId"] = purchaseOrderId.ToString(),
                ["EventType"]       = "approved",
                ["Description"]     = "Order approved by vendor. In transit.",
            });

            // Bank: debit the full PO cost (TotalDue includes freight) at approval time
            if (_bank != null)
            {
                try
                {
                    await _bank.InitializeAsync();
                    await _bank.PostTransactionAsync(new BankTransactionRequest(
                        CurrencyCode:    "USD",
                        Amount:          -(decimal)totalDue,
                        Description:     $"PO-{purchaseOrderId} approved: {rows.Count} line(s) from {vendorName}",
                        ReferenceId:     $"PO-{purchaseOrderId}",
                        TransactionType: "purchase"));
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[Bank] Failed to record PO debit for PO {PurchaseOrderId} — continuing.", purchaseOrderId);
                }
            }
        }

        return true;
    }

    public async Task<bool> CancelOrderAsync(string orderId, string reason)
    {
        if (!int.TryParse(orderId, out int purchaseOrderId)) return false;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // A PO can have multiple detail lines; use QueryAsync to handle all of them.
        var rows = (await conn.QueryAsync(@"
            SELECT poh.Status AS PoStatus,
                   CAST(poh.VendorID AS VARCHAR(20)) AS VendorId,
                   pod.ProductID,
                   CAST(pod.OrderQty AS INT) AS Qty
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            WHERE poh.PurchaseOrderID = @Id",
            new { Id = purchaseOrderId })).AsList();

        if (rows.Count == 0) return false;
        // Can only cancel while Pending (1) — once Approved it is already in transit
        if ((int)rows[0].PoStatus != 1) return false;

        string vendorId = (string)rows[0].VendorId;
        foreach (var row in rows)
        {
            await RefundStockAsync(vendorId, (int)row.ProductID, (int)row.Qty);
        }
        await UpdateSqlPurchaseOrderAsync(conn, purchaseOrderId, status: 3);
        _telemetry.TrackEvent("SupplyChainOrder", new Dictionary<string, string>
        {
            ["PurchaseOrderId"] = purchaseOrderId.ToString(),
            ["EventType"]       = "rejected",
            ["Description"]     = $"Order cancelled: {reason}. Stock returned to vendor.",
        });

        return true;
    }

    // ── Vendor restock ────────────────────────────────────────────────────────

    public async Task RestockVendorAsync(string vendorId, int productId = 0)
    {
        await _tableClient.CreateIfNotExistsAsync();
        string filter = $"PartitionKey eq '{PART_STOCK}' and VendorId eq '{vendorId}'";
        if (productId > 0)
            filter += $" and ProductId eq {productId}";

        var toUpdate = new List<TableEntity>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(filter: filter))
            toUpdate.Add(e);

        foreach (var e in toUpdate)
        {
            int maxStock = e.GetInt32("MaxStock") ?? 100;
            e["CurrentStock"] = maxStock;
            await _tableClient.UpdateEntityAsync(e, e.ETag);
        }

        _logger.LogInformation("Restocked vendor {VendorId}, {Count} SKUs", vendorId, toUpdate.Count);
    }

    // ── Speed multiplier config (Table Storage) ────────────────────────────────

    /// <summary>
    /// Returns the effective supply chain speed multiplier.
    /// Reads from Table Storage config partition; falls back to the constructor default.
    /// </summary>
    public async Task<double> GetSpeedMultiplierAsync()
    {
        try
        {
            var entity = await _tableClient.GetEntityAsync<TableEntity>(PART_CONFIG, ROW_SPEED);
            double val = entity.Value.GetDouble("Value") ?? _defaultSpeedMultiplier;
            return val > 0 ? val : _defaultSpeedMultiplier;
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 404)
        {
            return _defaultSpeedMultiplier;
        }
    }

    /// <summary>
    /// Persists the supply chain speed multiplier to Table Storage.
    /// </summary>
    public async Task SetSpeedMultiplierAsync(double value)
    {
        if (value < 1.0) value = 1.0;
        if (value > 50.0) value = 50.0;

        var entity = new TableEntity(PART_CONFIG, ROW_SPEED)
        {
            ["Value"] = value,
            ["UpdatedAtUtc"] = DateTime.UtcNow,
        };
        await _tableClient.UpsertEntityAsync(entity);
        _logger.LogInformation("Supply chain speed multiplier updated to {Value}×", value);
    }

    /// <summary>
    /// Returns the effective combined scale for converting sim-time to real seconds.
    /// Used by PurchaseOrderProcessorFunction for delivery and restock delays.
    /// </summary>
    public async Task<double> GetEffectiveTimeScaleAsync()
    {
        double multiplier = await GetSpeedMultiplierAsync();
        return _simTimeScale * multiplier;
    }

    // ── Order queries ──────────────────────────────────────────────────────────

    private const string OrderSelectSql = @"
        SELECT poh.PurchaseOrderID,
               CAST(poh.VendorID AS VARCHAR(20)) AS VendorId,
               v.Name  AS VendorName,
               pod.ProductID,
               p.Name  AS ProductName,
               CAST(pod.OrderQty   AS INT)   AS Qty,
               CAST(pod.UnitPrice  AS FLOAT) AS UnitCost,
               CAST(poh.Freight    AS FLOAT) AS ShippingCost,
               CAST(poh.TotalDue   AS FLOAT) AS TotalCost,
               CASE poh.Status
                   WHEN 1 THEN 'pending'
                   WHEN 2 THEN 'approved'
                   WHEN 3 THEN 'rejected'
                   WHEN 4 THEN 'complete'
                   ELSE 'unknown'
               END AS Status,
               poh.OrderDate AS PlacedAtUtc,
               pod.DueDate   AS EstimatedDeliveryUtc
        FROM Purchasing.PurchaseOrderHeader poh
        INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
        INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
        INNER JOIN Production.Product p ON pod.ProductID = p.ProductID
        WHERE v.ActiveFlag = 1 AND p.MakeFlag = 0
          AND EXISTS (SELECT 1 FROM Production.BillOfMaterials bom WHERE bom.ComponentID = p.ProductID AND bom.EndDate IS NULL)";

    public async Task<List<PurchaseOrder>> GetOrdersAsync(bool includeCompleted = false)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        string sql = OrderSelectSql;
        if (!includeCompleted)
            sql += " AND poh.Status IN (1, 2)";  // pending or approved (in transit)
        sql += " ORDER BY poh.OrderDate DESC";

        var rows   = await conn.QueryAsync(sql);
        var result = new List<PurchaseOrder>();
        foreach (var r in rows)
            result.Add(RowToOrder(r));
        return result;
    }

    public async Task<List<PurchaseOrder>> GetOrderHistoryAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var rows   = await conn.QueryAsync(OrderSelectSql + " ORDER BY poh.OrderDate DESC");
        var result = new List<PurchaseOrder>();
        foreach (var r in rows)
            result.Add(RowToOrder(r));
        return result;
    }

    public async Task<PurchaseOrder?> GetOrderAsync(string orderId)
    {
        if (!int.TryParse(orderId, out int purchaseOrderId)) return null;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var row = await conn.QueryFirstOrDefaultAsync(
            OrderSelectSql + " AND poh.PurchaseOrderID = @Id",
            new { Id = purchaseOrderId });

        if (row == null) return null;
        return RowToOrder(row);
    }

    // ── Reset ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Resets simulation state and re-seeds vendor stock.
    /// Reverts Status=3/4 BOM vendor POs back to Approved (2) so the next call to
    /// <see cref="ProcessHistoricalApprovedOrdersAsync"/> can replay them.
    /// </summary>
    public async Task ResetAsync()
    {
        _vendorCache = null;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Revert sim-touched BOM vendor POs back to Approved (2) so they can be re-processed
        await conn.ExecuteAsync(@"
            UPDATE poh
            SET poh.Status = 2,
                poh.ShipDate = NULL,
                poh.RevisionNumber = poh.RevisionNumber + 1,
                poh.ModifiedDate = GETDATE()
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
            INNER JOIN Production.Product p ON pod.ProductID = p.ProductID
            INNER JOIN Production.BillOfMaterials bom ON bom.ComponentID = p.ProductID AND bom.EndDate IS NULL
            WHERE v.ActiveFlag = 1 AND p.MakeFlag = 0 AND poh.Status IN (3, 4)");

        // Also reset ReceivedQty on detail rows of reverted POs
        await conn.ExecuteAsync(@"
            UPDATE pod
            SET pod.ReceivedQty = 0, pod.ModifiedDate = GETDATE()
            FROM Purchasing.PurchaseOrderDetail pod
            INNER JOIN Purchasing.PurchaseOrderHeader poh ON pod.PurchaseOrderID = poh.PurchaseOrderID
            INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
            INNER JOIN Production.Product p ON pod.ProductID = p.ProductID
            INNER JOIN Production.BillOfMaterials bom ON bom.ComponentID = p.ProductID AND bom.EndDate IS NULL
            WHERE v.ActiveFlag = 1 AND p.MakeFlag = 0");

        _logger.LogInformation("Reset: reverted BOM vendor POs (Status 3/4) back to Approved.");

        // Re-seed vendor stock in Table Storage
        var toDelete = new List<(string pk, string rk)>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_STOCK}'",
            select: new[] { "PartitionKey", "RowKey" }))
            toDelete.Add((e.PartitionKey, e.RowKey));
        foreach (var (pk, rk) in toDelete)
            await _tableClient.DeleteEntityAsync(pk, rk);

        await InitializeAsync();
        _logger.LogInformation("Supply chain simulation reset — vendor stock re-seeded from Purchasing tables.");
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    private static string StockRowKey(string vendorId, int productId) => $"{vendorId}_{productId}";

    /// <summary>Projects a Dapper dynamic row (from <see cref="OrderSelectSql"/>) to a <see cref="PurchaseOrder"/>.</summary>
    private static PurchaseOrder RowToOrder(dynamic r)
    {
        int poId = (int)r.PurchaseOrderID;
        return new PurchaseOrder(
            OrderId:              poId.ToString(),
            VendorId:             (string)r.VendorId,
            VendorName:           (string)r.VendorName,
            ProductId:            (int)r.ProductID,
            ProductName:          (string)r.ProductName,
            Qty:                  (int)r.Qty,
            UnitCost:             (double)r.UnitCost,
            ShippingCost:         (double)r.ShippingCost,
            TotalCost:            (double)r.TotalCost,
            Status:               (string)r.Status,
            PlacedAtUtc:          ((DateTime)r.PlacedAtUtc).ToUniversalTime(),
            EstimatedDeliveryUtc: ((DateTime)r.EstimatedDeliveryUtc).ToUniversalTime());
    }

    private async Task RefundStockAsync(string vendorId, int productId, int qty)
    {
        if (vendorId == "" || productId == 0 || qty == 0) return;

        var stockResp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_STOCK, StockRowKey(vendorId, productId));
        if (!stockResp.HasValue) return;

        var stock    = stockResp.Value!;
        int current  = stock.GetInt32("CurrentStock") ?? 0;
        int maxStock = stock.GetInt32("MaxStock") ?? 999;
        stock["CurrentStock"] = Math.Min(current + qty, maxStock);
        await _tableClient.UpdateEntityAsync(stock, stock.ETag);
    }

    private async Task AddToSqlInventoryAsync(int productId, int qty, string vendorId, double unitCost, int purchaseOrderId = 0)
    {
        // Route through warehouse simulation — goods must be put away by a warehouse worker
        // before they appear in inventory at LocationID 7 (Finished Goods Storage).
        if (_warehouse != null)
        {
            try
            {
                await _warehouse.EnqueueReceiveSupplierOperationAsync(purchaseOrderId, productId, qty);
                // Still record TransactionHistory immediately for audit trail
                await RecordPurchaseTransactionHistoryAsync(productId, qty, purchaseOrderId, unitCost, vendorId);
                _logger.LogInformation("Warehouse receive op enqueued for ProductID={ProductId} qty={Qty} PO={POId}", productId, qty, purchaseOrderId);
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Warehouse] Failed to enqueue receive op for PO {PurchaseOrderId} — falling back to direct inventory insert.", purchaseOrderId);
            }
        }

        // Fallback: direct SQL inventory insert (warehouse service unavailable)
        await DirectInsertToSqlInventoryAsync(productId, qty, vendorId, unitCost, purchaseOrderId);
    }

    private async Task DirectInsertToSqlInventoryAsync(int productId, int qty, string vendorId, double unitCost, int purchaseOrderId)
    {
        // Adds stock to the first bin (LocationID 7 = Finished Goods Storage)
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Check if a row for this product/location exists
        int existing = await conn.ExecuteScalarAsync<int>(
            "SELECT COUNT(1) FROM Production.ProductInventory WHERE ProductID = @ProductId AND LocationID = 7",
            new { ProductId = productId });

        if (existing > 0)
        {
            await conn.ExecuteAsync(
                "UPDATE Production.ProductInventory SET Quantity = Quantity + @Qty, ModifiedDate = GETDATE() " +
                "WHERE ProductID = @ProductId AND LocationID = 7",
                new { ProductId = productId, Qty = qty });
        }
        else
        {
            await conn.ExecuteAsync(
                "INSERT INTO Production.ProductInventory (ProductID, LocationID, Shelf, Bin, Quantity, rowguid, ModifiedDate) " +
                "VALUES (@ProductId, 7, N'A', 1, @Qty, NEWID(), GETDATE())",
                new { ProductId = productId, Qty = qty });
        }

        _logger.LogInformation("Added {Qty} units of ProductID={ProductId} to SQL inventory (LocationID=7)", qty, productId);
        await RecordPurchaseTransactionHistoryAsync(productId, qty, purchaseOrderId, unitCost, vendorId);
    }

    private async Task RecordPurchaseTransactionHistoryAsync(int productId, int qty, int purchaseOrderId, double unitCost, string vendorId)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Record purchase receipt in TransactionHistory ('P' = Purchase Order, positive qty = received)
        await conn.ExecuteAsync(@"
            INSERT INTO Production.TransactionHistory
                (ProductID, ReferenceOrderID, ReferenceOrderLineID, TransactionDate, TransactionType, Quantity, ActualCost, ModifiedDate)
            VALUES (@ProductId, @PurchaseOrderId, 0, GETDATE(), 'P', @Qty, @ActualCost, GETDATE())",
            new { ProductId = productId, PurchaseOrderId = purchaseOrderId, Qty = qty, ActualCost = (decimal)unitCost });

        // Update ProductVendor with receipt cost and date (if vendor info provided)
        if (!string.IsNullOrEmpty(vendorId) && int.TryParse(vendorId, out int businessEntityId) && unitCost > 0)
        {
            await RecordPurchaseCostAsync(conn, productId, businessEntityId, unitCost);
        }
    }

    /// <summary>
    /// Records purchase cost in ProductVendor and ProductCostHistory when components are received from vendors.
    /// </summary>
    private async Task RecordPurchaseCostAsync(SqlConnection conn, int productId, int businessEntityId, double unitCost)
    {
        var receiptDate = DateTime.UtcNow;

        // Update Purchasing.ProductVendor with last receipt cost and date
        int vendorUpdated = await conn.ExecuteAsync(
            @"UPDATE Purchasing.ProductVendor 
              SET LastReceiptCost = @UnitCost, 
                  LastReceiptDate = @ReceiptDate, 
                  ModifiedDate = GETDATE()
              WHERE ProductID = @ProductId AND BusinessEntityID = @BusinessEntityId",
            new { ProductId = productId, BusinessEntityId = businessEntityId, UnitCost = unitCost, ReceiptDate = receiptDate });

        if (vendorUpdated > 0)
        {
            _logger.LogInformation("Updated ProductVendor: ProductID={ProductId}, Vendor={VendorId}, LastReceiptCost={Cost:C}",
                productId, businessEntityId, unitCost);
        }

        // Close any open-ended ProductCostHistory records for this product
        await conn.ExecuteAsync(
            @"UPDATE Production.ProductCostHistory
              SET EndDate = @ReceiptDate
              WHERE ProductID = @ProductId AND EndDate IS NULL AND StartDate < @ReceiptDate",
            new { ProductId = productId, ReceiptDate = receiptDate });

        // Insert new ProductCostHistory record with the receipt cost
        int costHistoryInserted = await conn.ExecuteAsync(
            @"INSERT INTO Production.ProductCostHistory (ProductID, StartDate, EndDate, StandardCost, ModifiedDate)
              VALUES (@ProductId, @StartDate, NULL, @StandardCost, GETDATE())",
            new { ProductId = productId, StartDate = receiptDate, StandardCost = unitCost });

        if (costHistoryInserted > 0)
        {
            _logger.LogInformation("Recorded ProductCostHistory: ProductID={ProductId}, Cost={Cost:C}, Date={Date:u}",
                productId, unitCost, receiptDate);
        }
    }

    /// <summary>
    /// Returns a (vendorId, productId) → averageStockedQty map derived from completed
    /// purchase orders. "Average stocked qty" is the mean of
    /// <c>PurchaseOrderDetail.StockedQty</c> (= ReceivedQty − RejectedQty) across all
    /// completed lines for each vendor+product pair.
    /// <para>
    /// Preference order: simulation-delivered POs tracked in <c>SimOrderState</c> are used
    /// first (they represent the most realistic volume for this environment). When no
    /// simulation history exists yet (first-ever run), the query falls back to the full set
    /// of completed AdventureWorks POs so the initial seed is still data-driven.
    /// </para>
    /// </summary>
    private async Task<Dictionary<(string VendorId, int ProductId), int>> GetHistoricalStockLevelsAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // StockedQty is a computed column: ReceivedQty - RejectedQty.
        // We use the AVG across completed PO lines as a "typical batch" size per vendor+product.
        var rows = await conn.QueryAsync(@"
            SELECT CAST(poh.VendorID AS VARCHAR(20)) AS VendorId,
                   pod.ProductID,
                   CAST(AVG(CAST(pod.StockedQty AS FLOAT)) AS INT) AS AvgStockedQty
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            WHERE poh.Status = 4 AND pod.StockedQty > 0
            GROUP BY poh.VendorID, pod.ProductID
            HAVING AVG(CAST(pod.StockedQty AS FLOAT)) > 0");

        return rows.ToDictionary(
            r => ((string)r.VendorId, (int)r.ProductID),
            r => (int)r.AvgStockedQty);
    }

    /// <summary>
    /// Loads all vendor-product pairs from Purchasing.ProductVendor for BOM purchased components.
    /// Used to seed Table Storage stock entities.
    /// NOTE: The BOM filter (EXISTS ... BillOfMaterials) includes retail-only products
    /// (MakeFlag=0, FinishedGoodsFlag=1) via top-level BOM entries (NULL ProductAssemblyID,
    /// BOMLevel=0) added in BillOfMaterials-ai.csv. Without those entries, retail products
    /// like helmets, gloves, and accessories would be excluded from the supply chain catalog
    /// and could not be restocked when sold out.
    /// </summary>
    internal async Task<List<VendorStockItem>> GetVendorProductsFromSqlAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var rows = await conn.QueryAsync(@"
            SELECT pv.BusinessEntityID AS VendorId,
                   pv.ProductID,
                   p.Name AS ProductName,
                   CAST(pv.StandardPrice AS FLOAT) AS StandardPrice,
                   pv.AverageLeadTime,
                   pv.MinOrderQty,
                   pv.MaxOrderQty,
                   ISNULL(CAST(p.Weight AS FLOAT), 0.5) AS WeightKg
            FROM Purchasing.ProductVendor pv
            INNER JOIN Production.Product p ON pv.ProductID = p.ProductID
            INNER JOIN Purchasing.Vendor v ON pv.BusinessEntityID = v.BusinessEntityID
            WHERE p.MakeFlag = 0
              AND v.ActiveFlag = 1
              AND EXISTS (
                  SELECT 1 FROM Production.BillOfMaterials bom
                  WHERE bom.ComponentID = pv.ProductID AND bom.EndDate IS NULL)
            ORDER BY pv.BusinessEntityID, pv.ProductID");

        return rows.Select(r => new VendorStockItem(
            VendorId:      ((int)r.VendorId).ToString(),
            ProductId:     (int)r.ProductID,
            ProductName:   (string)r.ProductName,
            StandardPrice: (double)r.StandardPrice,
            AverageLeadTime: (int)r.AverageLeadTime,
            MinOrderQty:   (int)r.MinOrderQty,
            MaxOrderQty:   (int)r.MaxOrderQty,
            CurrentStock:  0,
            MaxStock:      Math.Max((int)r.MaxOrderQty, 10),
            WeightKg:      (double)r.WeightKg)).ToList();
    }

    // ── SQL Purchase Order persistence helpers ─────────────────────────────────

    /// <summary>
    /// Finds an active employee in the Inventory Management department to use as the EmployeeID
    /// on new PurchaseOrderHeader rows. Result is cached for the service lifetime.
    /// </summary>
    private async Task<int> GetDefaultPurchasingEmployeeIdAsync()
    {
        if (_defaultEmployeeId.HasValue) return _defaultEmployeeId.Value;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        int? empId = await conn.ExecuteScalarAsync<int?>(
            @"SELECT TOP 1 e.BusinessEntityID
              FROM HumanResources.Employee e
              INNER JOIN HumanResources.EmployeeDepartmentHistory edh
                  ON e.BusinessEntityID = edh.BusinessEntityID
              INNER JOIN HumanResources.Department d
                  ON edh.DepartmentID = d.DepartmentID
              WHERE d.GroupName = 'Inventory Management'
                AND edh.EndDate IS NULL
                AND e.CurrentFlag = 1
              ORDER BY e.BusinessEntityID");

        _defaultEmployeeId = empId ?? 258;
        return _defaultEmployeeId.Value;
    }

    /// <summary>
    /// Creates a <c>Purchasing.PurchaseOrderHeader</c> (Status=1 Pending),
    /// <c>Purchasing.PurchaseOrderDetail</c>, and the companion <c>Purchasing.SimOrderState</c>
    /// row in a single connection. Writes the first tracking event.
    /// Returns the new <c>PurchaseOrderID</c>.
    /// </summary>
    private async Task<int> InsertSqlPurchaseOrderAsync(
        int vendorId, int shipMethodId, DateTime orderDate, DateTime estimatedDelivery,
        int productId, int qty, double unitCost, double shipping)
    {
        int    employeeId = await GetDefaultPurchasingEmployeeIdAsync();
        decimal subTotal  = Math.Round((decimal)(unitCost * qty), 4);
        decimal taxAmt    = Math.Round(subTotal * 0.08m, 4);
        decimal freight   = Math.Round((decimal)shipping, 4);

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        int purchaseOrderId = await conn.ExecuteScalarAsync<int>(
            @"INSERT INTO Purchasing.PurchaseOrderHeader
                (RevisionNumber, Status, EmployeeID, VendorID, ShipMethodID,
                 OrderDate, ShipDate, SubTotal, TaxAmt, Freight, ModifiedDate)
              VALUES
                (1, 1, @EmployeeId, @VendorId, @ShipMethodId,
                 @OrderDate, NULL, @SubTotal, @TaxAmt, @Freight, GETDATE());
              SELECT CAST(SCOPE_IDENTITY() AS INT);",
            new { EmployeeId = employeeId, VendorId = vendorId, ShipMethodId = shipMethodId,
                  OrderDate = orderDate, SubTotal = subTotal, TaxAmt = taxAmt, Freight = freight });

        await conn.ExecuteAsync(
            @"INSERT INTO Purchasing.PurchaseOrderDetail
                (PurchaseOrderID, DueDate, OrderQty, ProductID, UnitPrice,
                 ReceivedQty, RejectedQty, ModifiedDate)
              VALUES
                (@PurchaseOrderId, @DueDate, @OrderQty, @ProductId, @UnitPrice, 0, 0, GETDATE())",
            new { PurchaseOrderId = purchaseOrderId, DueDate = estimatedDelivery,
                  OrderQty = (short)Math.Min(qty, short.MaxValue),
                  ProductId = productId, UnitPrice = (decimal)unitCost });

        _telemetry.TrackEvent("SupplyChainOrder", new Dictionary<string, string>
        {
            ["PurchaseOrderId"] = purchaseOrderId.ToString(),
            ["EventType"]       = "pending",
            ["Description"]     = $"Order placed for {qty}× ProductID {productId}. Estimated delivery: {estimatedDelivery:yyyy-MM-dd HH:mm} UTC (PO #{purchaseOrderId}).",
        });

        _logger.LogInformation(
            "Created PurchaseOrderHeader ID={Id} for VendorID={VendorId}, ProductID={ProductId}, Qty={Qty}",
            purchaseOrderId, vendorId, productId, qty);

        return purchaseOrderId;
    }

    /// <summary>
    /// Updates <c>Purchasing.PurchaseOrderHeader</c> status and optionally <c>ShipDate</c>
    /// and <c>ReceivedQty</c> on the detail row. Accepts an already-open connection.
    /// </summary>
    private async Task UpdateSqlPurchaseOrderAsync(
        SqlConnection conn, int purchaseOrderId, byte status,
        DateTime? shipDate = null, int? receivedQty = null)
    {
        if (shipDate.HasValue)
        {
            await conn.ExecuteAsync(
                @"UPDATE Purchasing.PurchaseOrderHeader
                  SET Status = @Status, ShipDate = @ShipDate,
                      RevisionNumber = RevisionNumber + 1, ModifiedDate = GETDATE()
                  WHERE PurchaseOrderID = @Id",
                new { Status = status, ShipDate = shipDate.Value, Id = purchaseOrderId });
        }
        else
        {
            await conn.ExecuteAsync(
                @"UPDATE Purchasing.PurchaseOrderHeader
                  SET Status = @Status,
                      RevisionNumber = RevisionNumber + 1, ModifiedDate = GETDATE()
                  WHERE PurchaseOrderID = @Id",
                new { Status = status, Id = purchaseOrderId });
        }

        if (receivedQty.HasValue)
        {
            await conn.ExecuteAsync(
                @"UPDATE Purchasing.PurchaseOrderDetail
                  SET ReceivedQty = @ReceivedQty, ModifiedDate = GETDATE()
                  WHERE PurchaseOrderID = @Id",
                new { ReceivedQty = (decimal)receivedQty.Value, Id = purchaseOrderId });
        }
    }

    /// <summary>
    /// Returns all purchased BOM components (used by ManufacturingPlanningService).
    /// </summary>
    internal async Task<List<(int ProductId, string Name, decimal StandardCost, double Weight)>> GetPurchasedComponentsAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var rows = await conn.QueryAsync(@"
            SELECT DISTINCT p.ProductID, p.Name, p.StandardCost,
                   ISNULL(CAST(p.Weight AS FLOAT), 0.5) AS Weight
            FROM Production.BillOfMaterials bom
            INNER JOIN Production.Product p ON bom.ComponentID = p.ProductID
            WHERE bom.EndDate IS NULL AND p.MakeFlag = 0
            ORDER BY p.ProductID");

        return rows.Select(r => ((int)r.ProductID, (string)r.Name, (decimal)r.StandardCost, (double)r.Weight)).ToList();
    }
}

