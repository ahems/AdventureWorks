using System.Text.Json;
using api_functions.Models;
using Azure.Data.Tables;
using Azure.Identity;
using Azure.Storage.Queues;
using Dapper;
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
    int IncomingQty = 0);

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
    DateTime EstimatedDeliveryUtc,
    DateTime? ActualDeliveryUtc,
    string? CancellationReason,
    List<TrackingEvent> TrackingEvents);

public record TrackingEvent(
    string EventType,
    string Description,
    DateTime TimestampUtc);

public record VendorSummary(
    VendorInfo Vendor,
    int TotalComponents,
    int InStockComponents,
    int ActiveOrders,
    int DeliveredToday);

// ── Service ──────────────────────────────────────────────────────────────────

public class SupplyChainService
{
    private const string TABLE_NAME       = "awSupplyChain";
    private const string PART_STOCK       = "stock";

    internal const string QUEUE_NAME = "supply-chain-orders-queue";

    // ── Reliability & restock tables keyed by CreditRating (1=best, 5=worst) ──
    private static readonly double[] ReliabilityByRating    = { 0, 0.97, 0.90, 0.83, 0.73, 0.65 };
    private static readonly int[]    RestockHoursByRating   = { 0,    4,    8,   16,   30,   48 };
    // Initial stock fill ratio (fraction of MaxOrderQty at seed time)
    private static readonly double[] FillRatioByRating      = { 0, 0.90, 0.80, 0.68, 0.55, 0.45 };

    private readonly string _connectionString;
    private readonly TableClient _tableClient;
    private readonly double _simTimeScale;
    private readonly ILogger<SupplyChainService> _logger;

    // Vendor cache — loaded lazily from Purchasing.Vendor on first access
    private List<VendorInfo>? _vendorCache;
    private readonly SemaphoreSlim _vendorLoadLock = new(1, 1);

    // Cached default purchasing employee ID for new PurchaseOrderHeader rows
    private int? _defaultEmployeeId;

    public SupplyChainService(
        string connectionString,
        string tableServiceUri,
        double simTimeScale,
        ILogger<SupplyChainService> logger)
    {
        _connectionString = connectionString;
        _simTimeScale     = simTimeScale;
        _logger           = logger;

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
        // Ensure SQL simulation tables exist
        await EnsureSqlTablesAsync();

        // Process any existing Approved (Status=2) POs from the AdventureWorks data that
        // have not yet been assigned a SimOrderState row. This runs every call but is
        // idempotent — it only touches POs that have no SimOrderState entry.
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
        // the normal approval → delivery state machine. Idempotent: guarded by SimOrderState.
        await ProcessHistoricalPendingOrdersAsync(pendingQtys);
    }

    /// <summary>
    /// Creates the two simulation-specific SQL tables if they do not already exist.
    /// <list type="bullet">
    ///   <item><c>Purchasing.SimOrderState</c> — per-PO simulation status and delivery times
    ///         (extends PurchaseOrderHeader with fields the AdventureWorks schema does not have).</item>
    ///   <item><c>Purchasing.SimOrderTracking</c> — ordered audit log of every state transition.</item>
    /// </list>
    /// </summary>
    private async Task EnsureSqlTablesAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();
        await conn.ExecuteAsync(@"
            IF OBJECT_ID('Purchasing.SimOrderState', 'U') IS NULL
            CREATE TABLE Purchasing.SimOrderState (
                PurchaseOrderID      INT           NOT NULL
                    CONSTRAINT PK_SimOrderState PRIMARY KEY
                    REFERENCES Purchasing.PurchaseOrderHeader(PurchaseOrderID),
                EstimatedDeliveryUtc DATETIME2     NOT NULL,
                ActualDeliveryUtc    DATETIME2     NULL,
                CancellationReason   NVARCHAR(500) NULL,
                ModifiedDate         DATETIME2     NOT NULL DEFAULT GETUTCDATE()
            )
            ELSE BEGIN
                -- Drop SimStatus if it still exists from an earlier schema version
                IF COL_LENGTH('Purchasing.SimOrderState', 'SimStatus') IS NOT NULL
                    ALTER TABLE Purchasing.SimOrderState DROP COLUMN SimStatus;
            END;

            IF OBJECT_ID('Purchasing.SimOrderTracking', 'U') IS NULL
            CREATE TABLE Purchasing.SimOrderTracking (
                TrackingId       INT            NOT NULL IDENTITY
                    CONSTRAINT PK_SimOrderTracking PRIMARY KEY,
                PurchaseOrderID  INT            NOT NULL
                    REFERENCES Purchasing.PurchaseOrderHeader(PurchaseOrderID),
                EventType        NVARCHAR(50)   NOT NULL,
                Description      NVARCHAR(1000) NULL,
                CreatedAtUtc     DATETIME2      NOT NULL DEFAULT GETUTCDATE()
            );
        ");
    }

    /// <summary>
    /// Finds all <c>Purchasing.PurchaseOrderHeader</c> rows with Status=2 (Approved) that have
    /// no <c>SimOrderState</c> entry — these are "in-flight" orders from the AdventureWorks seed
    /// data that the simulator has not yet processed. For each:
    /// <list type="bullet">
    ///   <item>Creates a <c>SimOrderState</c> row (ETA = PO DueDate).</item>
    ///   <item>Rolls against the vendor's reliability percentage.</item>
    ///   <item>Pass → Status=4 (Complete), inventory added to <c>Production.ProductInventory</c>.</item>
    ///   <item>Fail → Status=3 (Rejected).</item>
    /// </list>
    /// Scoped to active vendors supplying BOM purchased components so only procurement
    /// relevant to manufacturing is affected.
    /// </summary>
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
    /// Idempotent: each PO is skipped if a <c>SimOrderState</c> row already exists for it.
    /// </summary>
    private async Task ProcessHistoricalPendingOrdersAsync(
        Dictionary<(string VendorId, int ProductId), int> pendingQtys)
    {
        if (pendingQtys.Count == 0) return;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Find Status=1 BOM POs with active vendors that have no SimOrderState yet.
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
              AND p.MakeFlag = 0
              AND NOT EXISTS (
                  SELECT 1 FROM Purchasing.SimOrderState s
                  WHERE s.PurchaseOrderID = poh.PurchaseOrderID)");

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

        int enqueued = 0;
        for (int i = 0; i < poList.Count; i++)
        {
            var r    = poList[i];
            int poId = (int)r.PurchaseOrderID;
            DateTime eta = ((DateTime)r.DueDate).ToUniversalTime();

            // Create SimOrderState row first — this is the idempotency guard.
            // If this write succeeds the PO is owned by the simulator; queue message follows.
            await conn.ExecuteAsync(
                @"INSERT INTO Purchasing.SimOrderState (PurchaseOrderID, EstimatedDeliveryUtc, ModifiedDate)
                  VALUES (@Id, @Eta, GETUTCDATE())",
                new { Id = poId, Eta = eta });

            await WriteSqlTrackingAsync(conn, poId, "pending",
                "Order found in AdventureWorks seed data with Status=Pending. Injected into approval queue.");

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

            enqueued++;
        }

        _logger.LogInformation(
            "Injected {Count} historical Pending BOM POs into the supply-chain approval queue " +
            "(staggered 1s apart, first fires in {BaseDelay}s).",
            enqueued, PendingToApprovedSimSec);
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

        // Find approved POs for BOM purchased components with active vendors and no SimOrderState yet
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
              AND NOT EXISTS (
                  SELECT 1 FROM Purchasing.SimOrderState s
                  WHERE s.PurchaseOrderID = poh.PurchaseOrderID)");

        int passed = 0, rejected = 0;
        foreach (var r in pending)
        {
            int    poId     = (int)r.PurchaseOrderID;
            string vendorId = (string)r.VendorId;
            int    productId= (int)r.ProductID;
            int    qty      = (int)r.Qty;
            double unitCost = (double)r.UnitCost;
            DateTime eta    = ((DateTime)r.DueDate).ToUniversalTime();

            // Create SimOrderState so this PO is visible in the API
            await conn.ExecuteAsync(
                @"INSERT INTO Purchasing.SimOrderState (PurchaseOrderID, EstimatedDeliveryUtc, ModifiedDate)
                  VALUES (@Id, @Eta, GETUTCDATE())",
                new { Id = poId, Eta = eta });

            await WriteSqlTrackingAsync(conn, poId, "pending",
                $"Order found in AdventureWorks seed data with Status=Approved. Processing reliability roll.");

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
                await conn.ExecuteAsync(@"
                    UPDATE Purchasing.SimOrderState
                    SET ActualDeliveryUtc = GETUTCDATE(), ModifiedDate = GETUTCDATE()
                    WHERE PurchaseOrderID = @Id",
                    new { Id = poId });
                await AddToSqlInventoryAsync(productId, qty, vendorId, unitCost);
                await WriteSqlTrackingAsync(conn, poId, "complete",
                    $"Reliability check passed. {qty} units of ProductID {productId} delivered and added to inventory.");
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
                await conn.ExecuteAsync(@"
                    UPDATE Purchasing.SimOrderState
                    SET CancellationReason = 'Rejected: reliability check failed during historical processing.',
                        ModifiedDate = GETUTCDATE()
                    WHERE PurchaseOrderID = @Id",
                    new { Id = poId });
                await WriteSqlTrackingAsync(conn, poId, "rejected",
                    $"Reliability check failed (vendor reliability: {reliability:P0}). Order rejected.");
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
                             AND CAST(sos.ActualDeliveryUtc AS DATE) = CAST(GETUTCDATE() AS DATE)
                            THEN 1 ELSE 0 END) AS DeliveredToday
            FROM Purchasing.SimOrderState sos
            INNER JOIN Purchasing.PurchaseOrderHeader poh
                ON sos.PurchaseOrderID = poh.PurchaseOrderID
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
    private async Task<Dictionary<(string VendorId, int ProductId), int>> GetIncomingQtyMapAsync(
        string? scopeVendorId = null, int? scopeProductId = null)
    {
        var map = new Dictionary<(string, int), int>();

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
                   CAST(pod.OrderQty AS INT) AS Qty
            FROM Purchasing.SimOrderState sos
            INNER JOIN Purchasing.PurchaseOrderHeader poh
                ON sos.PurchaseOrderID = poh.PurchaseOrderID
            INNER JOIN Purchasing.PurchaseOrderDetail pod
                ON poh.PurchaseOrderID = pod.PurchaseOrderID
            WHERE poh.Status = 2{whereExtra}");

        foreach (var r in rows)
        {
            var key = ((string)r.VendorId, (int)r.ProductID);
            map[key] = map.TryGetValue(key, out int cur) ? cur + (int)r.Qty : (int)r.Qty;
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
            int    incoming     = incomingMap.TryGetValue((vendorId, productId), out int iq) ? iq : 0;

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
                IncomingQty: incoming));
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
        int incoming = incomingMap.TryGetValue((vendorId, productId), out int iq) ? iq : 0;

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
            IncomingQty: incoming);
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

        var row = await conn.QuerySingleOrDefaultAsync(@"
            SELECT poh.Status                          AS PoStatus,
                   sos.EstimatedDeliveryUtc,
                   CAST(poh.VendorID AS VARCHAR(20))   AS VendorId,
                   pod.ProductID,
                   CAST(pod.OrderQty AS INT)            AS Qty,
                   CAST(pod.UnitPrice AS FLOAT)         AS UnitCost
            FROM Purchasing.SimOrderState sos
            INNER JOIN Purchasing.PurchaseOrderHeader poh ON sos.PurchaseOrderID = poh.PurchaseOrderID
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            WHERE sos.PurchaseOrderID = @Id",
            new { Id = purchaseOrderId });

        if (row == null) return false;

        int currentPoStatus = (int)row.PoStatus;

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

        int    productId = (int)row.ProductID;
        string vendorId  = (string)row.VendorId;
        int    qty       = (int)row.Qty;
        double unitCost  = (double)row.UnitCost;

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
            await conn.ExecuteAsync(
                "UPDATE Purchasing.SimOrderState SET ActualDeliveryUtc = GETUTCDATE(), ModifiedDate = GETUTCDATE() WHERE PurchaseOrderID = @Id",
                new { Id = purchaseOrderId });
            await UpdateSqlPurchaseOrderAsync(conn, purchaseOrderId, status: 4, receivedQty: qty);
            await AddToSqlInventoryAsync(productId, qty, vendorId, unitCost);
            await WriteSqlTrackingAsync(conn, purchaseOrderId, "complete",
                $"Delivery confirmed. {qty} units of ProductID {productId} added to Production.ProductInventory.");
        }
        else if (targetStatus == "rejected")
        {
            await RefundStockAsync(vendorId, productId, qty);
            await conn.ExecuteAsync(
                @"UPDATE Purchasing.SimOrderState
                  SET CancellationReason = ISNULL(CancellationReason, 'Rejected by simulator.'),
                      ModifiedDate = GETUTCDATE()
                  WHERE PurchaseOrderID = @Id AND CancellationReason IS NULL",
                new { Id = purchaseOrderId });
            await WriteSqlTrackingAsync(conn, purchaseOrderId, "rejected",
                "Order rejected. Vendor stock refunded.");
        }
        else // approved
        {
            await WriteSqlTrackingAsync(conn, purchaseOrderId, "approved",
                "Order approved by vendor. In transit.");
        }

        return true;
    }

    public async Task<bool> CancelOrderAsync(string orderId, string reason)
    {
        if (!int.TryParse(orderId, out int purchaseOrderId)) return false;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var row = await conn.QuerySingleOrDefaultAsync(@"
            SELECT poh.Status AS PoStatus,
                   CAST(poh.VendorID AS VARCHAR(20)) AS VendorId,
                   pod.ProductID,
                   CAST(pod.OrderQty AS INT) AS Qty
            FROM Purchasing.SimOrderState sos
            INNER JOIN Purchasing.PurchaseOrderHeader poh ON sos.PurchaseOrderID = poh.PurchaseOrderID
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
            WHERE sos.PurchaseOrderID = @Id",
            new { Id = purchaseOrderId });

        if (row == null) return false;
        // Can only cancel while Pending (1) — once Approved it is already in transit
        if ((int)row.PoStatus != 1) return false;

        await RefundStockAsync((string)row.VendorId, (int)row.ProductID, (int)row.Qty);
        await UpdateSqlPurchaseOrderAsync(conn, purchaseOrderId, status: 3);
        await conn.ExecuteAsync(
            "UPDATE Purchasing.SimOrderState SET CancellationReason = @Reason, ModifiedDate = GETUTCDATE() WHERE PurchaseOrderID = @Id",
            new { Reason = reason, Id = purchaseOrderId });
        await WriteSqlTrackingAsync(conn, purchaseOrderId, "rejected",
            $"Order cancelled: {reason}. Stock returned to vendor.");

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
               poh.OrderDate               AS PlacedAtUtc,
               sos.EstimatedDeliveryUtc,
               sos.ActualDeliveryUtc,
               sos.CancellationReason
        FROM Purchasing.SimOrderState sos
        INNER JOIN Purchasing.PurchaseOrderHeader poh ON sos.PurchaseOrderID = poh.PurchaseOrderID
        INNER JOIN Purchasing.Vendor v ON poh.VendorID = v.BusinessEntityID
        INNER JOIN Purchasing.PurchaseOrderDetail pod ON poh.PurchaseOrderID = pod.PurchaseOrderID
        INNER JOIN Production.Product p ON pod.ProductID = p.ProductID";

    public async Task<List<PurchaseOrder>> GetOrdersAsync(bool includeCompleted = false)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        string sql = OrderSelectSql;
        if (!includeCompleted)
            sql += " WHERE poh.Status IN (1, 2)";  // pending or approved (in transit)
        sql += " ORDER BY poh.OrderDate DESC";

        var rows   = await conn.QueryAsync(sql);
        var result = new List<PurchaseOrder>();
        foreach (var r in rows)
            result.Add(await RowToOrderAsync(conn, r));
        return result;
    }

    public async Task<List<PurchaseOrder>> GetOrderHistoryAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var rows   = await conn.QueryAsync(OrderSelectSql + " ORDER BY poh.OrderDate DESC");
        var result = new List<PurchaseOrder>();
        foreach (var r in rows)
            result.Add(await RowToOrderAsync(conn, r));
        return result;
    }

    public async Task<PurchaseOrder?> GetOrderAsync(string orderId)
    {
        if (!int.TryParse(orderId, out int purchaseOrderId)) return null;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var row = await conn.QuerySingleOrDefaultAsync(
            OrderSelectSql + " WHERE sos.PurchaseOrderID = @Id",
            new { Id = purchaseOrderId });

        if (row == null) return null;
        return await RowToOrderAsync(conn, row);
    }

    // ── Reset ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Wipes simulation state (SimOrderTracking, SimOrderState) and re-seeds vendor stock.
    /// First reverts PurchaseOrderHeader.Status back to Approved (2) for any POs that the
    /// simulator changed to Complete (4) or Rejected (3), so the next call to
    /// <see cref="ProcessHistoricalApprovedOrdersAsync"/> can replay them.
    /// </summary>
    public async Task ResetAsync()
    {
        _vendorCache = null;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Revert sim-touched POs back to Approved (2) so they can be re-processed on next init
        await conn.ExecuteAsync(@"
            UPDATE poh
            SET poh.Status = 2,
                poh.ShipDate = NULL,
                poh.RevisionNumber = poh.RevisionNumber + 1,
                poh.ModifiedDate = GETDATE()
            FROM Purchasing.PurchaseOrderHeader poh
            INNER JOIN Purchasing.SimOrderState sos ON poh.PurchaseOrderID = sos.PurchaseOrderID
            WHERE poh.Status IN (3, 4)");

        // Also reset ReceivedQty on detail rows of reverted POs
        await conn.ExecuteAsync(@"
            UPDATE pod
            SET pod.ReceivedQty = 0, pod.ModifiedDate = GETDATE()
            FROM Purchasing.PurchaseOrderDetail pod
            INNER JOIN Purchasing.PurchaseOrderHeader poh ON pod.PurchaseOrderID = poh.PurchaseOrderID
            INNER JOIN Purchasing.SimOrderState sos ON poh.PurchaseOrderID = sos.PurchaseOrderID");

        await conn.ExecuteAsync("DELETE FROM Purchasing.SimOrderTracking");
        await conn.ExecuteAsync("DELETE FROM Purchasing.SimOrderState");
        _logger.LogInformation("Reset: reverted sim-touched POs to Approved, cleared SimOrderState and SimOrderTracking.");

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

    /// <summary>
    /// Appends a tracking event to <c>Purchasing.SimOrderTracking</c>.
    /// Accepts an open connection to avoid opening a second one within an existing transaction.
    /// </summary>
    private static async Task WriteSqlTrackingAsync(
        SqlConnection conn, int purchaseOrderId, string eventType, string description)
    {
        await conn.ExecuteAsync(
            @"INSERT INTO Purchasing.SimOrderTracking (PurchaseOrderID, EventType, Description, CreatedAtUtc)
              VALUES (@Id, @EventType, @Description, GETUTCDATE())",
            new { Id = purchaseOrderId, EventType = eventType, Description = description });
    }

    private static async Task<List<TrackingEvent>> GetSqlTrackingEventsAsync(
        SqlConnection conn, int purchaseOrderId)
    {
        var rows = await conn.QueryAsync(
            @"SELECT EventType, Description, CreatedAtUtc
              FROM Purchasing.SimOrderTracking
              WHERE PurchaseOrderID = @Id
              ORDER BY CreatedAtUtc DESC",
            new { Id = purchaseOrderId });

        return rows.Select(r => new TrackingEvent(
            (string)r.EventType,
            (string)(r.Description ?? ""),
            ((DateTime)r.CreatedAtUtc).ToUniversalTime())).ToList();
    }

    /// <summary>Projects a Dapper dynamic row (from <see cref="OrderSelectSql"/>) to a <see cref="PurchaseOrder"/>.</summary>
    private static async Task<PurchaseOrder> RowToOrderAsync(SqlConnection conn, dynamic r)
    {
        int poId     = (int)r.PurchaseOrderID;
        var tracking = await GetSqlTrackingEventsAsync(conn, poId);

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
            EstimatedDeliveryUtc: ((DateTime)r.EstimatedDeliveryUtc).ToUniversalTime(),
            ActualDeliveryUtc:    r.ActualDeliveryUtc == null ? null : ((DateTime)r.ActualDeliveryUtc).ToUniversalTime(),
            CancellationReason:   r.CancellationReason == null ? null : (string)r.CancellationReason,
            TrackingEvents:       tracking);
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

    private async Task AddToSqlInventoryAsync(int productId, int qty, string vendorId, double unitCost)
    {
        // Adds stock to the first bin (LocationID 7 = Finished Goods Storage)
        // using the same Dapper pattern as the rest of the project.
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
            // Insert new bin row — Shelf and Bin are nullable/have defaults
            await conn.ExecuteAsync(
                "INSERT INTO Production.ProductInventory (ProductID, LocationID, Shelf, Bin, Quantity, rowguid, ModifiedDate) " +
                "VALUES (@ProductId, 7, N'A', 1, @Qty, NEWID(), GETDATE())",
                new { ProductId = productId, Qty = qty });
        }

        _logger.LogInformation("Added {Qty} units of ProductID={ProductId} to SQL inventory (LocationID=7)", qty, productId);

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
            WITH SimDelivered AS (
                -- POs placed by the simulator that have been fully delivered
                SELECT pod.PurchaseOrderID
                FROM Purchasing.SimOrderState sos
                INNER JOIN Purchasing.PurchaseOrderDetail pod
                    ON sos.PurchaseOrderID = pod.PurchaseOrderID
                WHERE sos.SimStatus = 'delivered'
            ),
            Source AS (
                -- Prefer simulator history; fall back to AdventureWorks seed data when empty
                SELECT PurchaseOrderID FROM SimDelivered
                UNION ALL
                SELECT poh.PurchaseOrderID
                FROM Purchasing.PurchaseOrderHeader poh
                WHERE poh.Status = 4   -- Complete
                  AND NOT EXISTS (SELECT 1 FROM SimDelivered)
            )
            SELECT CAST(poh.VendorID AS VARCHAR(20)) AS VendorId,
                   pod.ProductID,
                   CAST(AVG(CAST(pod.StockedQty AS FLOAT)) AS INT) AS AvgStockedQty
            FROM Source src
            INNER JOIN Purchasing.PurchaseOrderDetail pod ON src.PurchaseOrderID = pod.PurchaseOrderID
            INNER JOIN Purchasing.PurchaseOrderHeader poh ON pod.PurchaseOrderID = poh.PurchaseOrderID
            WHERE pod.StockedQty > 0
            GROUP BY poh.VendorID, pod.ProductID
            HAVING AVG(CAST(pod.StockedQty AS FLOAT)) > 0");

        return rows.ToDictionary(
            r => ((string)r.VendorId, (int)r.ProductID),
            r => (int)r.AvgStockedQty);
    }

    /// <summary>
    /// Loads all vendor-product pairs from Purchasing.ProductVendor for BOM purchased components.
    /// Used to seed Table Storage stock entities.
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

        // SimOrderState holds ETA and delivery metadata (status lives in PurchaseOrderHeader)
        await conn.ExecuteAsync(
            @"INSERT INTO Purchasing.SimOrderState
                (PurchaseOrderID, EstimatedDeliveryUtc, ModifiedDate)
              VALUES
                (@Id, @Eta, GETUTCDATE())",
            new { Id = purchaseOrderId, Eta = estimatedDelivery });

        // First tracking event
        await WriteSqlTrackingAsync(conn, purchaseOrderId, "pending",
            $"Order placed for {qty}× ProductID {productId}. " +
            $"Estimated delivery: {estimatedDelivery:yyyy-MM-dd HH:mm} UTC (PO #{purchaseOrderId}).");

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

