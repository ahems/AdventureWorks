using System.Text.Json;
using Azure.Data.Tables;
using Azure.Identity;
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
    string Status,
    DateTime PlacedAtUtc,
    DateTime EstimatedDeliveryUtc,
    DateTime? ActualDeliveryUtc,
    string? CancellationReason,
    List<TrackingEvent> TrackingEvents,
    int? SqlPurchaseOrderId = null);

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
    private const string PART_VENDOR      = "vendor";
    private const string PART_STOCK       = "stock";
    private const string PART_ORDER       = "order";
    private const string PART_TRACKING    = "tracking";

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
    /// Idempotent: creates the table and seeds vendor + stock rows sourced from
    /// Purchasing.Vendor and Purchasing.ProductVendor if they don't already exist.
    /// Called lazily from the first GET /api/supply/* request.
    /// </summary>
    public async Task InitializeAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();

        // Fast path: if vendor rows already exist, skip all seeding work.
        // This makes InitializeAsync() essentially free on every subsequent call —
        // one cheap Table Storage point-read vs 63 unconditional upserts.
        bool alreadySeeded = false;
        await foreach (var _ in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_VENDOR}'",
            maxPerPage: 1,
            select: new[] { "RowKey" }))
        {
            alreadySeeded = true;
            break;
        }
        if (alreadySeeded) return;

        var vendors = await GetVendorsAsync();

        // Seed vendor rows — upsert so metadata stays current with the DB
        foreach (var v in vendors)
        {
            var entity = new TableEntity(PART_VENDOR, v.VendorId)
            {
                ["AccountNumber"]      = v.AccountNumber,
                ["Name"]               = v.Name,
                ["Description"]        = v.Description,
                ["CreditRating"]       = v.CreditRating,
                ["PreferredVendor"]    = v.PreferredVendorStatus,
                ["DefaultLeadDays"]    = v.DefaultLeadTimeDays,
                ["ReliabilityPct"]     = v.ReliabilityPct,
                ["ShipMethodId"]       = v.ShipMethodId,
                ["ShipMethodName"]     = v.ShipMethodName,
                ["ShipBase"]           = v.ShipBase,
                ["ShipRate"]           = v.ShipRate,
                ["RestockDelaySimHrs"] = v.RestockDelaySimHrs,
                ["Strengths"]          = JsonSerializer.Serialize(v.Strengths),
                ["Weaknesses"]         = JsonSerializer.Serialize(v.Weaknesses),
            };
            await _tableClient.UpsertEntityAsync(entity);
        }

        // Seed per-vendor stock from Purchasing.ProductVendor (only BOM purchased components)
        var vendorProducts = await GetVendorProductsFromSqlAsync();
        var vendorDict     = vendors.ToDictionary(v => v.VendorId);

        foreach (var vp in vendorProducts)
        {
            if (!vendorDict.TryGetValue(vp.VendorId, out var vendor)) continue;

            var rowKey = StockRowKey(vp.VendorId, vp.ProductId);
            var existing = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_STOCK, rowKey);
            if (!existing.HasValue)
            {
                int maxStock  = Math.Max(vp.MaxOrderQty, 10);
                double fillRatio = vendor.CreditRating >= 1 && vendor.CreditRating <= 5
                    ? FillRatioByRating[vendor.CreditRating] : 0.70;
                int initStock = (int)Math.Round(maxStock * fillRatio
                    * (0.7 + 0.6 * Random.Shared.NextDouble()));
                initStock = Math.Clamp(initStock, 0, maxStock);

                var entity = new TableEntity(PART_STOCK, rowKey)
                {
                    ["VendorId"]       = vp.VendorId,
                    ["ProductId"]      = vp.ProductId,
                    ["ProductName"]    = vp.ProductName,
                    ["StandardPrice"]  = vp.StandardPrice,
                    ["AverageLeadTime"]= vp.AverageLeadTime,
                    ["MinOrderQty"]    = vp.MinOrderQty,
                    ["MaxOrderQty"]    = vp.MaxOrderQty,
                    ["WeightKg"]       = vp.WeightKg > 0 ? vp.WeightKg : 0.5,
                    ["CurrentStock"]   = initStock,
                    ["MaxStock"]       = maxStock,
                };
                await _tableClient.UpsertEntityAsync(entity);
            }
        }

        _logger.LogInformation("Supply chain initialized: {VendorCount} vendors, {ProductCount} vendor-product pairs",
            vendors.Count, vendorProducts.Count);
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
        var result  = new List<VendorSummary>();

        foreach (var v in vendors)
        {
            int totalComponents = 0, inStock = 0;
            await foreach (var e in _tableClient.QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{PART_STOCK}' and VendorId eq '{v.VendorId}'"))
            {
                totalComponents++;
                if ((e.GetInt32("CurrentStock") ?? 0) > 0) inStock++;
            }

            int activeOrders = 0, deliveredToday = 0;
            await foreach (var e in _tableClient.QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{PART_ORDER}' and VendorId eq '{v.VendorId}'"))
            {
                var status = e.GetString("Status") ?? "";
                if (status is "placed" or "confirmed" or "picking" or "shipped") activeOrders++;
                if (status == "delivered" &&
                    e.GetDateTimeOffset("ActualDeliveryUtc")?.Date == DateTime.UtcNow.Date) deliveredToday++;
            }

            result.Add(new VendorSummary(v, totalComponents, inStock, activeOrders, deliveredToday));
        }
        return result;
    }

    // ── Catalog / quote ────────────────────────────────────────────────────────

    /// <summary>
    /// Builds a (vendorId, productId) → incomingQty lookup from all open purchase orders
    /// (placed/confirmed/picking/shipped/delayed). These quantities have already been deducted
    /// from vendor CurrentStock; once delivered they will arrive at our warehouse.
    /// Optionally scoped to a single vendorId or productId to reduce Table scan cost.
    /// </summary>
    private async Task<Dictionary<(string VendorId, int ProductId), int>> GetIncomingQtyMapAsync(
        string? scopeVendorId = null, int? scopeProductId = null)
    {
        var map = new Dictionary<(string, int), int>();

        // Active statuses: everything that has left the vendor's shelf but not yet arrived
        var activeStatuses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "placed", "confirmed", "picking", "shipped", "delayed" };

        // Build a filter scoped to the order partition; optionally narrow by vendor / product
        // so we do not scan the entire order partition when querying a single quote.
        string filter = $"PartitionKey eq '{PART_ORDER}'";
        if (!string.IsNullOrEmpty(scopeVendorId))
            filter += $" and VendorId eq '{scopeVendorId}'";
        if (scopeProductId.HasValue)
            filter += $" and ProductId eq {scopeProductId.Value}";

        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: filter,
            select: new[] { "VendorId", "ProductId", "Qty", "Status" }))
        {
            var status = e.GetString("Status") ?? "";
            if (!activeStatuses.Contains(status)) continue;

            var vid = e.GetString("VendorId") ?? "";
            int pid = e.GetInt32("ProductId") ?? 0;
            int qty = e.GetInt32("Qty") ?? 0;
            if (vid == "" || pid == 0 || qty == 0) continue;

            var key = (vid, pid);
            map[key] = map.TryGetValue(key, out int current) ? current + qty : qty;
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
    /// Places a purchase order. Deducts stock immediately (prevents oversell).
    /// Returns null if vendorId/productId invalid or insufficient stock.
    /// </summary>
    public async Task<PurchaseOrder?> PlaceOrderAsync(string vendorId, int productId, int qty)
    {
        var vendors = await GetVendorsAsync();
        var vendor  = vendors.FirstOrDefault(v => v.VendorId == vendorId);
        if (vendor == null || qty <= 0) return null;

        // Read + deduct stock atomically via ETag
        var stockResp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_STOCK, StockRowKey(vendorId, productId));
        if (!stockResp.HasValue) return null;

        var stock = stockResp.Value!;

        // Validate against ProductVendor constraints
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
            // Concurrent order – just re-read and try once more
            stockResp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
                PART_STOCK, StockRowKey(vendorId, productId));
            if (!stockResp.HasValue) return null;
            stock = stockResp.Value!;
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

        string orderId = Guid.NewGuid().ToString("N")[..12].ToUpperInvariant();

        // Persist to Purchasing.PurchaseOrderHeader + PurchaseOrderDetail in SQL before upserting
        // to Table Storage so the cross-reference ID is captured in the same entity write.
        int? sqlPurchaseOrderId = null;
        if (int.TryParse(vendorId, out int vendorBusinessId))
        {
            sqlPurchaseOrderId = await InsertSqlPurchaseOrderAsync(
                vendorBusinessId, vendor.ShipMethodId, placed, eta,
                productId, qty, unitCost, shipping);
        }

        var orderEntity = new TableEntity(PART_ORDER, orderId)
        {
            ["VendorId"]             = vendorId,
            ["VendorName"]           = vendor.Name,
            ["ProductId"]            = productId,
            ["ProductName"]          = name,
            ["Qty"]                  = qty,
            ["UnitCost"]             = unitCost,
            ["ShippingCost"]         = shipping,
            ["TotalCost"]            = total,
            ["Status"]               = "placed",
            ["PlacedAtUtc"]          = placed,
            ["EstimatedDeliveryUtc"] = eta,
        };
        if (sqlPurchaseOrderId.HasValue)
            orderEntity["SqlPurchaseOrderId"] = sqlPurchaseOrderId.Value;

        await _tableClient.UpsertEntityAsync(orderEntity);
        await WriteTrackingAsync(orderId, "placed", $"Order placed with {vendor.Name} for {qty}× {name}. Estimated delivery: {eta:HH:mm UTC} (PO #{sqlPurchaseOrderId?.ToString() ?? "pending"})");

        _logger.LogInformation("PO {OrderId} placed: {Qty}x ProductID={ProductId} from {Vendor}, ETA={Eta:u}",
            orderId, qty, productId, vendor.Name, eta);

        return await GetOrderAsync(orderId);
    }

    // ── Order state transitions ────────────────────────────────────────────────

    public async Task<bool> TransitionOrderAsync(string orderId, string targetStatus)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_ORDER, orderId);
        if (!resp.HasValue) return false;

        var entity  = resp.Value!;
        string current = entity.GetString("Status") ?? "";

        // Guard: only advance (or deliver/fail)
        string[] validTransitions = current switch
        {
            "placed"    => new[] { "confirmed", "out_of_stock", "cancelled" },
            "confirmed" => new[] { "picking" },
            "picking"   => new[] { "shipped", "delayed" },
            "delayed"   => new[] { "shipped" },
            "shipped"   => new[] { "delivered" },
            _           => Array.Empty<string>(),
        };

        if (!validTransitions.Contains(targetStatus)) return false;

        entity["Status"] = targetStatus;

        // Read the SQL cross-reference before modifying anything
        int? sqlPurchaseOrderId = entity.GetInt32("SqlPurchaseOrderId");

        if (targetStatus == "delivered")
        {
            entity["ActualDeliveryUtc"] = DateTime.UtcNow;

            // Add inventory to SQL — this unblocks stalled manufacturing work orders
            int productId = entity.GetInt32("ProductId") ?? 0;
            int qty       = entity.GetInt32("Qty") ?? 0;
            string vendorId = entity.GetString("VendorId") ?? "";
            double unitCost = entity.GetDouble("UnitCost") ?? 0.0;
            if (productId > 0 && qty > 0)
            {
                await AddToSqlInventoryAsync(productId, qty, vendorId, unitCost);
                await WriteTrackingAsync(orderId, "delivered",
                    $"Delivery confirmed. {qty} units of ProductID {productId} added to Production.ProductInventory. Cost recorded in ProductCostHistory.");
            }

            // Mark SQL PurchaseOrderHeader as Complete (4) and update ReceivedQty in detail
            if (sqlPurchaseOrderId.HasValue)
                await UpdateSqlPurchaseOrderAsync(sqlPurchaseOrderId.Value, status: 4, receivedQty: qty > 0 ? qty : null);
        }
        else if (targetStatus == "out_of_stock")
        {
            // Refund stock: vendor had it allocated but cancelled before pickup
            await RefundStockAsync(entity);
            await WriteTrackingAsync(orderId, "out_of_stock",
                "Item became unavailable before confirmation. Stock refunded to vendor.");

            // Mark SQL PurchaseOrderHeader as Rejected (3)
            if (sqlPurchaseOrderId.HasValue)
                await UpdateSqlPurchaseOrderAsync(sqlPurchaseOrderId.Value, status: 3);
        }
        else if (targetStatus == "delayed")
        {
            // Reliability failure — add a delay, re-queue shipped transition
            double extraSimHrs = 24.0; // 1 extra simulated day
            var eta = entity.GetDateTimeOffset("EstimatedDeliveryUtc")?.UtcDateTime ?? DateTime.UtcNow;
            entity["EstimatedDeliveryUtc"] = eta.AddSeconds(extraSimHrs * 3600.0 / _simTimeScale);
            await WriteTrackingAsync(orderId, "delayed",
                "Shipment delayed in transit. Estimated delivery extended by 1 day.");
            // SQL remains Approved (2) during a delay — no status change needed
        }
        else
        {
            string desc = targetStatus switch
            {
                "confirmed" => "Order confirmed by vendor. Processing for dispatch.",
                "picking"   => "Order picked from warehouse and prepared for shipping.",
                "shipped"   => "Shipment dispatched. Tracking number generated.",
                _           => $"Status updated to {targetStatus}.",
            };
            await WriteTrackingAsync(orderId, targetStatus, desc);

            // Sync SQL PurchaseOrderHeader status
            if (sqlPurchaseOrderId.HasValue)
            {
                switch (targetStatus)
                {
                    case "picking":
                        // Picking = Approved in AdventureWorks (procurement confirmed by buyer)
                        await UpdateSqlPurchaseOrderAsync(sqlPurchaseOrderId.Value, status: 2);
                        break;
                    case "shipped":
                        // Shipped = Approved with ShipDate recorded
                        await UpdateSqlPurchaseOrderAsync(sqlPurchaseOrderId.Value, status: 2, shipDate: DateTime.UtcNow);
                        break;
                    // "confirmed" stays as Pending (1) in SQL — no change needed
                }
            }
        }

        await _tableClient.UpdateEntityAsync(entity, entity.ETag);
        return true;
    }

    public async Task<bool> CancelOrderAsync(string orderId, string reason)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_ORDER, orderId);
        if (!resp.HasValue) return false;

        var entity = resp.Value!;
        string status = entity.GetString("Status") ?? "";
        if (status is not ("placed" or "confirmed")) return false;

        // Refund stock
        await RefundStockAsync(entity);

        entity["Status"]             = "cancelled";
        entity["CancellationReason"] = reason;
        await _tableClient.UpdateEntityAsync(entity, entity.ETag);
        await WriteTrackingAsync(orderId, "cancelled", $"Order cancelled: {reason}. Stock returned to vendor.");

        // Mark SQL PurchaseOrderHeader as Rejected (3)
        int? sqlPurchaseOrderId = entity.GetInt32("SqlPurchaseOrderId");
        if (sqlPurchaseOrderId.HasValue)
            await UpdateSqlPurchaseOrderAsync(sqlPurchaseOrderId.Value, status: 3);

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

    public async Task<List<PurchaseOrder>> GetOrdersAsync(bool includeCompleted = false)
    {
        await _tableClient.CreateIfNotExistsAsync();
        var orders = new List<PurchaseOrder>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_ORDER}'"))
        {
            var status = e.GetString("Status") ?? "";
            if (!includeCompleted && status is "delivered" or "cancelled" or "out_of_stock") continue;
            var order = await EntityToOrderAsync(e);
            if (order != null) orders.Add(order);
        }
        return orders.OrderByDescending(o => o.PlacedAtUtc).ToList();
    }

    public async Task<List<PurchaseOrder>> GetOrderHistoryAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var orders = new List<PurchaseOrder>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_ORDER}'"))
        {
            var order = await EntityToOrderAsync(e);
            if (order != null) orders.Add(order);
        }
        return orders.OrderByDescending(o => o.PlacedAtUtc).ToList();
    }

    public async Task<PurchaseOrder?> GetOrderAsync(string orderId)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_ORDER, orderId);
        if (!resp.HasValue) return null;
        return await EntityToOrderAsync(resp.Value!);
    }

    // ── Reset ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Wipes all order, tracking, and stock rows then re-seeds stock from Purchasing.ProductVendor.
    /// Vendor definition rows are also refreshed from the database.
    /// </summary>
    public async Task ResetAsync()
    {
        // Invalidate vendor cache so next access re-loads from SQL
        _vendorCache = null;

        foreach (string partition in new[] { PART_ORDER, PART_TRACKING, PART_STOCK, PART_VENDOR })
        {
            var toDelete = new List<(string pk, string rk)>();
            await foreach (var e in _tableClient.QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{partition}'",
                select: new[] { "PartitionKey", "RowKey" }))
                toDelete.Add((e.PartitionKey, e.RowKey));

            foreach (var (pk, rk) in toDelete)
                await _tableClient.DeleteEntityAsync(pk, rk);
        }

        // Re-seed everything from SQL
        await InitializeAsync();
        _logger.LogInformation("Supply chain simulation reset — re-seeded from Purchasing tables.");
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    private static string StockRowKey(string vendorId, int productId) => $"{vendorId}_{productId}";

    private async Task WriteTrackingAsync(string orderId, string eventType, string description)
    {
        // Reverse-chrono row key for natural sort
        var rowKey  = $"{long.MaxValue - DateTimeOffset.UtcNow.Ticks:D19}_{eventType}";
        var entity = new TableEntity(PART_TRACKING, $"{orderId}_{rowKey}")
        {
            ["OrderId"]     = orderId,
            ["EventType"]   = eventType,
            ["Description"] = description,
            ["TimestampUtc"]= DateTime.UtcNow,
        };
        await _tableClient.UpsertEntityAsync(entity);
    }

    private async Task<List<TrackingEvent>> GetTrackingEventsAsync(string orderId)
    {
        var events = new List<TrackingEvent>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_TRACKING}' and OrderId eq '{orderId}'"))
        {
            events.Add(new TrackingEvent(
                e.GetString("EventType") ?? "",
                e.GetString("Description") ?? "",
                e.GetDateTimeOffset("TimestampUtc")?.UtcDateTime ?? DateTime.UtcNow));
        }
        // Already reverse-chrono by design of row key
        return events;
    }

    private async Task<PurchaseOrder?> EntityToOrderAsync(TableEntity e)
    {
        string orderId = e.RowKey;
        var tracking   = await GetTrackingEventsAsync(orderId);
        return new PurchaseOrder(
            orderId,
            VendorId:            e.GetString("VendorId") ?? "",
            VendorName:          e.GetString("VendorName") ?? "",
            ProductId:           e.GetInt32("ProductId") ?? 0,
            ProductName:         e.GetString("ProductName") ?? "",
            Qty:                 e.GetInt32("Qty") ?? 0,
            UnitCost:            e.GetDouble("UnitCost") ?? 0,
            ShippingCost:        e.GetDouble("ShippingCost") ?? 0,
            TotalCost:           e.GetDouble("TotalCost") ?? 0,
            Status:              e.GetString("Status") ?? "",
            PlacedAtUtc:         e.GetDateTimeOffset("PlacedAtUtc")?.UtcDateTime ?? DateTime.UtcNow,
            EstimatedDeliveryUtc: e.GetDateTimeOffset("EstimatedDeliveryUtc")?.UtcDateTime ?? DateTime.UtcNow,
            ActualDeliveryUtc:   e.GetDateTimeOffset("ActualDeliveryUtc")?.UtcDateTime,
            CancellationReason:  e.GetString("CancellationReason"),
            TrackingEvents:      tracking,
            SqlPurchaseOrderId:  e.GetInt32("SqlPurchaseOrderId"));
    }

    private async Task RefundStockAsync(TableEntity orderEntity)
    {
        string vendorId = orderEntity.GetString("VendorId") ?? "";
        int productId   = orderEntity.GetInt32("ProductId") ?? 0;
        int qty         = orderEntity.GetInt32("Qty") ?? 0;
        if (vendorId == "" || productId == 0 || qty == 0) return;

        var stockResp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_STOCK, StockRowKey(vendorId, productId));
        if (!stockResp.HasValue) return;

        var stock = stockResp.Value!;
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
    /// Finds an active employee in the Purchasing (Inventory Management) department to use
    /// as the EmployeeID on new PurchaseOrderHeader rows. Result is cached for the service lifetime.
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

        _defaultEmployeeId = empId ?? 258; // fall back to a known valid purchasing agent
        _logger.LogDebug("Using EmployeeID={EmpId} as default purchasing agent for PurchaseOrderHeader rows.", _defaultEmployeeId.Value);
        return _defaultEmployeeId.Value;
    }

    /// <summary>
    /// Inserts a <c>Purchasing.PurchaseOrderHeader</c> (Status=1 Pending) and a corresponding
    /// <c>Purchasing.PurchaseOrderDetail</c> row in SQL when the simulator places an order.
    /// Returns the new <c>PurchaseOrderID</c>, or <c>null</c> if the write fails so the
    /// simulation can continue without SQL persistence.
    /// </summary>
    private async Task<int?> InsertSqlPurchaseOrderAsync(
        int vendorId, int shipMethodId, DateTime orderDate, DateTime dueDate,
        int productId, int qty, double unitCost, double shipping)
    {
        try
        {
            int    employeeId = await GetDefaultPurchasingEmployeeIdAsync();
            decimal subTotal  = Math.Round((decimal)(unitCost * qty), 4);
            decimal taxAmt    = Math.Round(subTotal * 0.08m, 4);   // AW standard 8 % tax
            decimal freight   = Math.Round((decimal)shipping, 4);

            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Insert header — TotalDue is a persisted computed column (SubTotal + TaxAmt + Freight)
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

            // Insert detail line (ReceivedQty / RejectedQty start at 0; StockedQty is computed)
            await conn.ExecuteAsync(
                @"INSERT INTO Purchasing.PurchaseOrderDetail
                    (PurchaseOrderID, DueDate, OrderQty, ProductID, UnitPrice,
                     ReceivedQty, RejectedQty, ModifiedDate)
                  VALUES
                    (@PurchaseOrderId, @DueDate, @OrderQty, @ProductId, @UnitPrice,
                     0, 0, GETDATE())",
                new { PurchaseOrderId = purchaseOrderId, DueDate = dueDate,
                      OrderQty = (short)Math.Min(qty, short.MaxValue),
                      ProductId = productId, UnitPrice = (decimal)unitCost });

            _logger.LogInformation(
                "Created Purchasing.PurchaseOrderHeader ID={PurchaseOrderId} for VendorID={VendorId}, ProductID={ProductId}, Qty={Qty}",
                purchaseOrderId, vendorId, productId, qty);

            return purchaseOrderId;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Failed to create SQL PurchaseOrderHeader for VendorID={VendorId}, ProductID={ProductId} — simulation order will proceed without SQL persistence.",
                vendorId, productId);
            return null;
        }
    }

    /// <summary>
    /// Updates <c>Purchasing.PurchaseOrderHeader</c> status and optionally <c>ShipDate</c>
    /// (set when the simulator reaches the "shipped" state) and <c>ReceivedQty</c> in the
    /// detail row (set to <c>OrderQty</c> when delivered).<br/>
    /// SQL status codes: 1=Pending, 2=Approved, 3=Rejected, 4=Complete.
    /// </summary>
    private async Task UpdateSqlPurchaseOrderAsync(
        int sqlPurchaseOrderId, byte status,
        DateTime? shipDate = null, int? receivedQty = null)
    {
        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            if (shipDate.HasValue)
            {
                await conn.ExecuteAsync(
                    @"UPDATE Purchasing.PurchaseOrderHeader
                      SET Status = @Status, ShipDate = @ShipDate,
                          RevisionNumber = RevisionNumber + 1, ModifiedDate = GETDATE()
                      WHERE PurchaseOrderID = @Id",
                    new { Status = status, ShipDate = shipDate.Value, Id = sqlPurchaseOrderId });
            }
            else
            {
                await conn.ExecuteAsync(
                    @"UPDATE Purchasing.PurchaseOrderHeader
                      SET Status = @Status,
                          RevisionNumber = RevisionNumber + 1, ModifiedDate = GETDATE()
                      WHERE PurchaseOrderID = @Id",
                    new { Status = status, Id = sqlPurchaseOrderId });
            }

            if (receivedQty.HasValue)
            {
                // ReceivedQty updated; StockedQty is a computed column and updates automatically
                await conn.ExecuteAsync(
                    @"UPDATE Purchasing.PurchaseOrderDetail
                      SET ReceivedQty = @ReceivedQty, ModifiedDate = GETDATE()
                      WHERE PurchaseOrderID = @Id",
                    new { ReceivedQty = (decimal)receivedQty.Value, Id = sqlPurchaseOrderId });
            }

            _logger.LogDebug(
                "Updated Purchasing.PurchaseOrderHeader ID={Id} → Status={Status}{ShipNote}{RecvNote}",
                sqlPurchaseOrderId, status,
                shipDate.HasValue ? $", ShipDate={shipDate:u}" : "",
                receivedQty.HasValue ? $", ReceivedQty={receivedQty}" : "");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Failed to update Purchasing.PurchaseOrderHeader ID={Id} to Status={Status}.",
                sqlPurchaseOrderId, status);
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

