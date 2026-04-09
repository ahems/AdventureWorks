using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

// ── Data transfer types ──────────────────────────────────────────────────────

public record FeasibilityComponent(
    int ProductId,
    string Name,
    decimal RequiredPerUnit,
    int RequiredForQty,
    int CurrentStock,
    int CanSupportUnits,   // floor(currentStock / requiredPerUnit)
    int ShortfallForQty,   // max(0, required - currentStock)
    bool IsBottleneck);

public record FeasibilityResult(
    int ProductId,
    string Name,
    int RequestedQty,
    int MaxProducibleNow,              // limited by current inventory
    int MaxProducibleWithProcurement,  // + pending supply orders (placed/confirmed/picking/shipped)
    decimal ProcurementCostToMeetRequest, // cost to buy missing components cheapest vendor
    string? BottleneckComponentName,
    List<FeasibilityComponent> Components);

public record BomCostLine(
    int ProductId,
    string Name,
    decimal RequiredPerUnit,
    decimal StandardCost,
    decimal CostContribution,  // RequiredPerUnit × StandardCost
    bool IsPurchased);

public record CostAnalysis(
    int ProductId,
    string ProductName,
    decimal ListPrice,
    decimal MaterialCost,      // sum of all BOM StandardCost × qty
    decimal RoutingCost,       // avg total from historical WorkOrderRouting
    decimal EstimatedCogs,     // MaterialCost + RoutingCost
    decimal GrossMarginPct,    // (ListPrice - EstimatedCogs) / ListPrice
    string PricingSignal,      // "healthy" | "thin-margin" | "loss-making" | "no-price"
    List<BomCostLine> BomLines);

public record FinishedGoodSnapshot(
    int ProductId,
    string Name,
    string? ProductNumber,
    decimal ListPrice,
    decimal EstimatedCogs,
    decimal GrossMarginPct,
    string PricingSignal,
    int CurrentStockQty,
    double SalesLast30Days,
    double WeeksOfSupply,
    string InventorySignal,    // "healthy" | "overstock" | "low-stock" | "out-of-stock"
    int MaxProducibleNow);

public record ComponentShortage(
    int ComponentProductId,
    string ComponentName,
    int CurrentStock,
    double DailyConsumptionRate,     // units consumed per real day based on sales
    double DaysUntilStockout,
    double WeeksUntilStockout,
    string UrgencyLevel,             // "critical" (<7 days) | "warning" (7-30) | "watch" (30-60) | "ok"
    List<AffectedFinishedGood> AffectedProducts);

public record AffectedFinishedGood(
    int ProductId,
    string Name,
    decimal RequiredPerUnit,
    double DailySalesRate);

public record ReorderRecommendation(
    int ComponentProductId,
    string ComponentName,
    int CurrentStock,
    double DaysUntilStockout,
    string UrgencyLevel,
    int SuggestedOrderQty,       // 30-day supply
    ReorderVendorOption? BestVendor,
    List<ReorderVendorOption> AllVendors);

public record ReorderVendorOption(
    string VendorId,
    string VendorName,
    int StockAvailable,
    bool CanFulfillOrder,
    decimal UnitCost,
    decimal TotalCost,
    double EstimatedDeliveryRealMins,
    double ReliabilityPct,
    int LeadTimeDays);

public record CurrentManufacturingCost(
    int ProductId,
    string ProductName,
    decimal ListPrice,
    decimal CurrentMaterialCost,   // sum of all BOM components using current ProductCostHistory
    decimal EstimatedRoutingCost,  // avg from recent WorkOrderRouting
    decimal TotalManufacturingCost, // CurrentMaterialCost + EstimatedRoutingCost
    decimal GrossMarginPct,        // (ListPrice - TotalManufacturingCost) / ListPrice
    string PricingSignal,          // "healthy" | "thin-margin" | "loss-making" | "no-price"
    DateTime CostAsOf,             // timestamp of cost calculation
    List<CurrentCostBomLine> BomBreakdown);

public record CurrentCostBomLine(
    int ProductId,
    string Name,
    decimal RequiredPerUnit,
    decimal CurrentCost,           // from ProductCostHistory (latest entry)
    DateTime? CostDate,            // StartDate of the cost record used
    decimal CostContribution,      // RequiredPerUnit × CurrentCost
    bool IsPurchased,
    string CostSource);            // "ProductCostHistory" | "ProductVendor.LastReceiptCost" | "Product.StandardCost"

// ── Service ──────────────────────────────────────────────────────────────────

public class ManufacturingPlanningService
{
    private readonly string _connectionString;
    private readonly ILogger<ManufacturingPlanningService> _logger;

    // LocationID=7 is Finished Goods Storage (used for finished product inventory)
    private const int FINISHED_GOODS_LOCATION = 7;

    public ManufacturingPlanningService(
        string connectionString,
        ILogger<ManufacturingPlanningService> logger)
    {
        _connectionString = connectionString;
        _logger           = logger;
    }

    // ── Feasibility ───────────────────────────────────────────────────────────

    /// <summary>
    /// For a given finished good, how many units can be produced right now given current
    /// component stock? Optionally factors in pending supply orders.
    /// </summary>
    public async Task<FeasibilityResult?> GetFeasibilityAsync(
        int productId,
        int requestedQty,
        IReadOnlyList<PurchaseOrder>? pendingOrders = null)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Validate product exists and is a manufactured finished good
        var product = await conn.QuerySingleOrDefaultAsync(@"
            SELECT ProductID, Name
            FROM Production.Product
            WHERE ProductID = @Id AND MakeFlag = 1 AND FinishedGoodsFlag = 1",
            new { Id = productId });
        if (product == null) return null;

        // Get BOM (purchased components only — these are the inventory constraints)
        // Aggregate cumulative qty for diamond dependencies
        var bom = await conn.QueryAsync(@"
            WITH BomTree AS (
                SELECT p.ProductID, p.Name, CAST(p.MakeFlag AS BIT) AS MakeFlag,
                       0 AS Depth, CAST(1.0 AS DECIMAL(18,4)) AS CumulativeQty
                FROM Production.Product p WHERE p.ProductID = @RootProductId
                UNION ALL
                SELECT pc.ProductID, pc.Name, CAST(pc.MakeFlag AS BIT),
                       bt.Depth + 1,
                       CAST(bt.CumulativeQty * bom.PerAssemblyQty AS DECIMAL(18,4))
                FROM BomTree bt
                INNER JOIN Production.BillOfMaterials bom
                    ON bom.ProductAssemblyID = bt.ProductID AND bom.EndDate IS NULL
                INNER JOIN Production.Product pc ON bom.ComponentID = pc.ProductID
            )
            SELECT ProductID, Name, SUM(CumulativeQty) AS CumulativeQty
            FROM BomTree
            WHERE MakeFlag = 0 AND ProductID <> @RootProductId
            GROUP BY ProductID, Name
            OPTION (MAXRECURSION 20)",
            new { RootProductId = productId });

        var bomList = bom.Select(r => (
            ProductId:      (int)r.ProductID,
            Name:           (string)r.Name,
            CumulativeQty:  (decimal)r.CumulativeQty)).ToList();

        if (!bomList.Any())
        {
            // No purchased components — producibility is unlimited by materials
            return new FeasibilityResult(productId, (string)product.Name, requestedQty,
                int.MaxValue, int.MaxValue, 0, null, new List<FeasibilityComponent>());
        }

        // Get current stock for all components in one query
        var componentIds = bomList.Select(b => b.ProductId).ToList();
        var stockRows = await conn.QueryAsync(@"
            SELECT ProductID, ISNULL(SUM(Quantity), 0) AS TotalQty
            FROM Production.ProductInventory
            WHERE ProductID IN @Ids
            GROUP BY ProductID",
            new { Ids = componentIds });
        var stockMap = stockRows.ToDictionary(r => (int)r.ProductID, r => (int)r.TotalQty);

        // Pending supply orders: aggregate in-flight qty per productId
        var pendingMap = new Dictionary<int, int>();
        if (pendingOrders != null)
        {
            foreach (var o in pendingOrders.Where(o =>
                o.Status is "placed" or "confirmed" or "picking" or "shipped"))
                pendingMap[o.ProductId] = pendingMap.GetValueOrDefault(o.ProductId) + o.Qty;
        }

        // Build component feasibility lines
        var components = new List<FeasibilityComponent>();
        foreach (var (cid, cname, cqty) in bomList)
        {
            int stock       = stockMap.GetValueOrDefault(cid);
            int pending     = pendingMap.GetValueOrDefault(cid);
            int requiredFor = (int)Math.Ceiling((double)cqty * requestedQty);
            int canSupport  = cqty > 0 ? (int)Math.Floor(stock / (double)cqty) : int.MaxValue;
            int shortfall   = Math.Max(0, requiredFor - stock);

            components.Add(new FeasibilityComponent(
                cid, cname, cqty, requiredFor, stock, canSupport, shortfall, false));
        }

        int maxNow = components.Any()
            ? components.Min(c => c.CanSupportUnits)
            : int.MaxValue;

        // With procurement: canSupport using stock + pending orders
        var compWithProcurement = components.Select(c =>
        {
            int augmented   = c.CurrentStock + pendingMap.GetValueOrDefault(c.ProductId);
            int canWithProc = c.RequiredPerUnit > 0
                ? (int)Math.Floor(augmented / (double)c.RequiredPerUnit)
                : int.MaxValue;
            return c with { CanSupportUnits = canWithProc };
        }).ToList();

        int maxWithProcurement = compWithProcurement.Any()
            ? compWithProcurement.Min(c => c.CanSupportUnits)
            : int.MaxValue;

        // Identify bottleneck (component with lowest canSupport) among original (no proc)
        var bottleneck = components.OrderBy(c => c.CanSupportUnits).FirstOrDefault();
        var markedComponents = components
            .Select(c => c with { IsBottleneck = c.ProductId == bottleneck?.ProductId })
            .ToList();

        // Estimate cheapest procurement cost to fill gap to requestedQty
        decimal procCost = await EstimateProcurementCostAsync(
            markedComponents.Where(c => c.ShortfallForQty > 0).ToList());

        return new FeasibilityResult(
            productId, (string)product.Name, requestedQty,
            maxNow, maxWithProcurement, procCost,
            bottleneck?.Name,
            markedComponents);
    }

    // ── Cost analysis ─────────────────────────────────────────────────────────

    public async Task<CostAnalysis?> GetCostAnalysisAsync(int productId)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var product = await conn.QuerySingleOrDefaultAsync(@"
            SELECT ProductID, Name, ListPrice
            FROM Production.Product
            WHERE ProductID = @Id AND MakeFlag = 1 AND FinishedGoodsFlag = 1",
            new { Id = productId });
        if (product == null) return null;

        // Full BOM (all levels, both purchased and manufactured)
        var bom = await conn.QueryAsync(@"
            WITH BomTree AS (
                SELECT p.ProductID, p.Name, CAST(p.MakeFlag AS BIT) AS MakeFlag,
                       0 AS Depth, CAST(1.0 AS DECIMAL(18,4)) AS CumulativeQty
                FROM Production.Product p WHERE p.ProductID = @RootProductId
                UNION ALL
                SELECT pc.ProductID, pc.Name, CAST(pc.MakeFlag AS BIT),
                       bt.Depth + 1,
                       CAST(bt.CumulativeQty * bom.PerAssemblyQty AS DECIMAL(18,4))
                FROM BomTree bt
                INNER JOIN Production.BillOfMaterials bom
                    ON bom.ProductAssemblyID = bt.ProductID AND bom.EndDate IS NULL
                INNER JOIN Production.Product pc ON bom.ComponentID = pc.ProductID
            )
            SELECT bt.ProductID, bt.Name, bt.MakeFlag, SUM(bt.CumulativeQty) AS CumulativeQty,
                   p.StandardCost
            FROM BomTree bt
            INNER JOIN Production.Product p ON bt.ProductID = p.ProductID
            WHERE bt.ProductID <> @RootProductId
            GROUP BY bt.ProductID, bt.Name, bt.MakeFlag, p.StandardCost
            OPTION (MAXRECURSION 20)",
            new { RootProductId = productId });

        var bomLines = bom.Select(r => new BomCostLine(
            (int)r.ProductID,
            (string)r.Name,
            (decimal)r.CumulativeQty,
            (decimal)r.StandardCost,
            (decimal)r.CumulativeQty * (decimal)r.StandardCost,
            !(bool)r.MakeFlag)).ToList();

        decimal materialCost = bomLines.Sum(b => b.CostContribution);

        // Average total routing cost from the most recent 10 completed work orders
        var routingCost = await conn.ExecuteScalarAsync<decimal?>(@"
            SELECT AVG(totalCost)
            FROM (
                SELECT TOP 10 SUM(ISNULL(wor.ActualCost, wor.PlannedCost)) AS totalCost
                FROM Production.WorkOrder wo
                INNER JOIN Production.WorkOrderRouting wor ON wo.WorkOrderID = wor.WorkOrderID
                WHERE wo.ProductID = @ProductId AND wo.EndDate IS NOT NULL
                GROUP BY wo.WorkOrderID
                ORDER BY wo.WorkOrderID DESC
            ) t",
            new { ProductId = productId }) ?? 0;

        decimal listPrice  = (decimal)product.ListPrice;
        decimal cogs       = materialCost + routingCost;
        decimal marginPct  = listPrice > 0 ? (listPrice - cogs) / listPrice : -1;

        string signal = (listPrice, marginPct) switch
        {
            (0, _)          => "no-price",
            (_, < 0)        => "loss-making",
            (_, < 0.15m)    => "thin-margin",
            _               => "healthy",
        };

        return new CostAnalysis(
            productId, (string)product.Name, listPrice,
            materialCost, routingCost, cogs, marginPct, signal, bomLines);
    }

    // ── Full catalog snapshot ─────────────────────────────────────────────────

    /// <summary>
    /// Returns a snapshot for every sellable finished good including cost, margin,
    /// current stock, sales velocity, and derived signals for the UI.
    /// </summary>
    public async Task<List<FinishedGoodSnapshot>> GetCatalogSnapshotAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Gather all finished goods that are currently on sale
        var products = await conn.QueryAsync(@"
            SELECT p.ProductID, p.Name, p.ProductNumber, p.ListPrice, p.StandardCost
            FROM Production.Product p
            WHERE p.MakeFlag = 1 AND p.FinishedGoodsFlag = 1
              AND p.SellEndDate IS NULL OR p.SellEndDate > GETDATE()
            ORDER BY p.ProductID");

        // Finished goods stock (LocationID 7)
        var stockRows = await conn.QueryAsync(@"
            SELECT ProductID, ISNULL(SUM(Quantity), 0) AS Qty
            FROM Production.ProductInventory
            WHERE LocationID = @Loc
            GROUP BY ProductID",
            new { Loc = FINISHED_GOODS_LOCATION });
        var stockMap = stockRows.ToDictionary(r => (int)r.ProductID, r => (int)r.Qty);

        // 30-day sales volume per product
        var salesRows = await conn.QueryAsync(@"
            SELECT sod.ProductID, SUM(CAST(sod.OrderQty AS FLOAT)) AS SoldQty
            FROM Sales.SalesOrderDetail sod
            INNER JOIN Sales.SalesOrderHeader soh ON sod.SalesOrderID = soh.SalesOrderID
            WHERE soh.OrderDate >= DATEADD(DAY, -30, GETDATE())
            GROUP BY sod.ProductID");
        var salesMap = salesRows.ToDictionary(r => (int)r.ProductID, r => (double)r.SoldQty);

        var result = new List<FinishedGoodSnapshot>();
        foreach (var p in products)
        {
            int pid         = (int)p.ProductID;
            decimal lp      = (decimal)p.ListPrice;
            decimal sc      = (decimal)p.StandardCost;
            int stock       = stockMap.GetValueOrDefault(pid);
            double sold30   = salesMap.GetValueOrDefault(pid);
            double dailyRate = sold30 / 30.0;
            double wos      = dailyRate > 0 ? (stock / dailyRate) / 7.0 : double.MaxValue;

            // Simple margin using StandardCost as proxy (fast, no BOM explosion)
            decimal marginPct = lp > 0 ? (lp - sc) / lp : -1;
            string pricingSignal = (lp, marginPct) switch
            {
                (0, _)       => "no-price",
                (_, < 0)     => "loss-making",
                (_, < 0.15m) => "thin-margin",
                _            => "healthy",
            };

            string invSignal = (stock, wos) switch
            {
                (0, _)       => "out-of-stock",
                (_, > 12.0)  => "overstock",
                (_, < 2.0)   => "low-stock",
                _            => "healthy",
            };

            // Quick feasibility: max producible from purchased components
            int maxNow = await GetMaxProducibleFastAsync(conn, pid);

            result.Add(new FinishedGoodSnapshot(
                pid, (string)p.Name, p.ProductNumber as string,
                lp, sc, marginPct, pricingSignal,
                stock, sold30, wos > 1e9 ? -1 : Math.Round(wos, 1),
                invSignal, maxNow));
        }

        return result;
    }

    // ── Overstock / sale candidates ───────────────────────────────────────────

    public async Task<List<FinishedGoodSnapshot>> GetOverstockItemsAsync(double minWeeksOfSupply = 12.0)
    {
        var all = await GetCatalogSnapshotAsync();
        return all
            .Where(s => s.InventorySignal == "overstock" || s.WeeksOfSupply >= minWeeksOfSupply)
            .OrderByDescending(s => s.WeeksOfSupply)
            .ToList();
    }

    // ── Pricing / margin analysis ─────────────────────────────────────────────

    public async Task<List<FinishedGoodSnapshot>> GetThinMarginItemsAsync(double maxMarginPct = 0.20)
    {
        var all = await GetCatalogSnapshotAsync();
        return all
            .Where(s => s.PricingSignal is "thin-margin" or "loss-making" or "no-price"
                        || (double)s.GrossMarginPct < maxMarginPct)
            .OrderBy(s => s.GrossMarginPct)
            .ToList();
    }

    // ── Component shortage forecast ───────────────────────────────────────────

    /// <summary>
    /// Forecasts which purchased components will run out first, given current sales
    /// velocity and the BOM requirements of finished goods.
    /// </summary>
    public async Task<List<ComponentShortage>> GetShortageForeceastAsync(int forecastDays = 90)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Sales velocity per finished good (units per day, last 30 days)
        var salesRows = await conn.QueryAsync(@"
            SELECT sod.ProductID, SUM(CAST(sod.OrderQty AS FLOAT)) / 30.0 AS DailyRate
            FROM Sales.SalesOrderDetail sod
            INNER JOIN Sales.SalesOrderHeader soh ON sod.SalesOrderID = soh.SalesOrderID
            WHERE soh.OrderDate >= DATEADD(DAY, -30, GETDATE())
              AND EXISTS (
                  SELECT 1 FROM Production.Product p
                  WHERE p.ProductID = sod.ProductID
                    AND p.MakeFlag = 1 AND p.FinishedGoodsFlag = 1)
            GROUP BY sod.ProductID");
        var salesMap = salesRows.ToDictionary(r => (int)r.ProductID, r => (double)r.DailyRate);

        if (!salesMap.Any()) return new List<ComponentShortage>();

        // BOM for every product that has sales velocity
        var finishedGoodIds = salesMap.Keys.ToList();

        // Build component → daily consumption map
        // component_daily_consumption = SUM over all products( dailySaleRate × CumulativeQty )
        var componentConsumption = new Dictionary<int, (double dailyRate, List<AffectedFinishedGood> affected)>();

        foreach (var fgId in finishedGoodIds)
        {
            double fgDailyRate = salesMap[fgId];

            var bom = await conn.QueryAsync(@"
                WITH BomTree AS (
                    SELECT p.ProductID, CAST(p.MakeFlag AS BIT) AS MakeFlag,
                           CAST(1.0 AS DECIMAL(18,4)) AS CumulativeQty
                    FROM Production.Product p WHERE p.ProductID = @RootProductId
                    UNION ALL
                    SELECT pc.ProductID, CAST(pc.MakeFlag AS BIT),
                           CAST(bt.CumulativeQty * bom.PerAssemblyQty AS DECIMAL(18,4))
                    FROM BomTree bt
                    INNER JOIN Production.BillOfMaterials bom
                        ON bom.ProductAssemblyID = bt.ProductID AND bom.EndDate IS NULL
                    INNER JOIN Production.Product pc ON bom.ComponentID = pc.ProductID
                )
                SELECT ProductID, SUM(CumulativeQty) AS CumulativeQty
                FROM BomTree
                WHERE MakeFlag = 0 AND ProductID <> @RootProductId
                GROUP BY ProductID
                OPTION (MAXRECURSION 20)",
                new { RootProductId = fgId });

            var fgName = (await conn.ExecuteScalarAsync<string>(
                "SELECT Name FROM Production.Product WHERE ProductID = @Id",
                new { Id = fgId })) ?? fgId.ToString();

            foreach (var row in bom)
            {
                int cid    = (int)row.ProductID;
                double qty = (double)(decimal)row.CumulativeQty;
                double componentDailyConsumption = fgDailyRate * qty;

                if (!componentConsumption.ContainsKey(cid))
                    componentConsumption[cid] = (0, new List<AffectedFinishedGood>());

                var (current, affected) = componentConsumption[cid];
                affected.Add(new AffectedFinishedGood(fgId, fgName, (decimal)qty, fgDailyRate));
                componentConsumption[cid] = (current + componentDailyConsumption, affected);
            }
        }

        // Get current stock for all these components
        var compIds = componentConsumption.Keys.ToList();
        var stockRows = await conn.QueryAsync(@"
            SELECT p.ProductID, p.Name, ISNULL(SUM(i.Quantity), 0) AS TotalQty
            FROM Production.Product p
            LEFT JOIN Production.ProductInventory i ON i.ProductID = p.ProductID
            WHERE p.ProductID IN @Ids
            GROUP BY p.ProductID, p.Name",
            new { Ids = compIds });
        var stockMap = stockRows.ToDictionary(r => (int)r.ProductID,
            r => (stock: (int)r.TotalQty, name: (string)r.Name));

        var shortages = new List<ComponentShortage>();
        foreach (var (cid, (dailyUsage, affected)) in componentConsumption)
        {
            if (!stockMap.TryGetValue(cid, out var sm)) continue;
            double daysUntil = dailyUsage > 0 ? sm.stock / dailyUsage : double.MaxValue;

            if (daysUntil > forecastDays) continue; // outside forecast window

            string urgency = daysUntil switch
            {
                < 7  => "critical",
                < 30 => "warning",
                < 60 => "watch",
                _    => "ok",
            };

            shortages.Add(new ComponentShortage(
                cid, sm.name, sm.stock,
                Math.Round(dailyUsage, 4),
                Math.Round(daysUntil, 1),
                Math.Round(daysUntil / 7.0, 1),
                urgency,
                affected.OrderByDescending(a => a.DailySalesRate).ToList()));
        }

        return shortages.OrderBy(s => s.DaysUntilStockout).ToList();
    }

    // ── Reorder recommendations ────────────────────────────────────────────────

    /// <summary>
    /// For every component with a shortage in the next <paramref name="forecastDays"/> days,
    /// returns the best vendor option plus all alternatives from the supply chain catalog.
    /// </summary>
    public async Task<List<ReorderRecommendation>> GetReorderRecommendationsAsync(
        int forecastDays = 60,
        IReadOnlyList<SupplyQuote>? catalog = null)
    {
        var shortages = await GetShortageForeceastAsync(forecastDays);
        var recommendations = new List<ReorderRecommendation>();

        foreach (var s in shortages.Where(x => x.UrgencyLevel != "ok"))
        {
            int suggestedQty = (int)Math.Ceiling(s.DailyConsumptionRate * 30); // 30-day buffer
            suggestedQty = Math.Max(suggestedQty, 1);

            var vendorOptions = new List<ReorderVendorOption>();

            if (catalog != null)
            {
                var offers = catalog
                    .Where(q => q.ProductId == s.ComponentProductId)
                    .OrderBy(q => q.TotalCost);

                foreach (var o in offers)
                {
                    decimal unitCost = (decimal)o.UnitCost;
                    decimal shipping = (decimal)o.ShippingCost;
                    decimal total    = unitCost * suggestedQty + shipping;

                    vendorOptions.Add(new ReorderVendorOption(
                        o.VendorId, o.VendorName,
                        o.StockAvailable,
                        o.StockAvailable >= suggestedQty,
                        unitCost, Math.Round(total, 2),
                        o.EstimatedDeliveryRealMins,
                        o.ReliabilityPct,
                        o.LeadTimeDays));
                }
            }

            var best = vendorOptions
                .Where(v => v.CanFulfillOrder)
                .OrderBy(v => v.TotalCost)
                .FirstOrDefault()
                ?? vendorOptions.OrderBy(v => v.TotalCost).FirstOrDefault();

            recommendations.Add(new ReorderRecommendation(
                s.ComponentProductId, s.ComponentName,
                s.CurrentStock, s.DaysUntilStockout, s.UrgencyLevel,
                suggestedQty, best, vendorOptions));
        }

        return recommendations.OrderBy(r => r.DaysUntilStockout).ToList();
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    /// <summary>
    /// Fast max-producible calc using a single SQL query (no BOM explosion in C# loops).
    /// Returns -1 if no purchased BOM components exist (not inventory-constrained).
    /// </summary>
    private static async Task<int> GetMaxProducibleFastAsync(SqlConnection conn, int productId)
    {
        try
        {
            var rows = await conn.QueryAsync(@"
                WITH BomTree AS (
                    SELECT p.ProductID, CAST(p.MakeFlag AS BIT) AS MakeFlag,
                           CAST(1.0 AS DECIMAL(18,4)) AS CumulativeQty
                    FROM Production.Product p WHERE p.ProductID = @RootProductId
                    UNION ALL
                    SELECT pc.ProductID, CAST(pc.MakeFlag AS BIT),
                           CAST(bt.CumulativeQty * bom.PerAssemblyQty AS DECIMAL(18,4))
                    FROM BomTree bt
                    INNER JOIN Production.BillOfMaterials bom
                        ON bom.ProductAssemblyID = bt.ProductID AND bom.EndDate IS NULL
                    INNER JOIN Production.Product pc ON bom.ComponentID = pc.ProductID
                ),
                ComponentStock AS (
                    SELECT bt.ProductID, SUM(bt.CumulativeQty) AS RequiredPerUnit,
                           ISNULL(SUM(i.Quantity), 0) AS TotalStock
                    FROM BomTree bt
                    LEFT JOIN Production.ProductInventory i ON i.ProductID = bt.ProductID
                    WHERE bt.MakeFlag = 0 AND bt.ProductID <> @RootProductId
                    GROUP BY bt.ProductID
                )
                SELECT MIN(FLOOR(CAST(TotalStock AS FLOAT) / CAST(RequiredPerUnit AS FLOAT))) AS MaxProducible
                FROM ComponentStock
                WHERE RequiredPerUnit > 0
                OPTION (MAXRECURSION 20)",
                new { RootProductId = productId });

            var val = rows.FirstOrDefault()?.MaxProducible;
            if (val == null) return -1;
            return (int)(double)val;
        }
        catch
        {
            return -1;
        }
    }

    /// <summary>
    /// Rough procurement cost estimate: for each component shortfall, find the cheapest
    /// vendor offer from the static vendor catalog using StandardCost as a proxy.
    /// </summary>
    private async Task<decimal> EstimateProcurementCostAsync(
        List<FeasibilityComponent> shortfalls)
    {
        if (!shortfalls.Any()) return 0;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        decimal totalCost = 0;
        foreach (var sf in shortfalls)
        {
            // Use cheapest available vendor price from ProductVendor, falling back to StandardCost
            var cheapest = await conn.ExecuteScalarAsync<decimal?>(@"
                SELECT TOP 1 CAST(pv.StandardPrice AS DECIMAL(18,4))
                FROM Purchasing.ProductVendor pv
                INNER JOIN Purchasing.Vendor v ON pv.BusinessEntityID = v.BusinessEntityID
                WHERE pv.ProductID = @ProductId AND v.ActiveFlag = 1
                ORDER BY pv.StandardPrice ASC",
                new { ProductId = sf.ProductId });

            if (cheapest == null || cheapest == 0)
                cheapest = await conn.ExecuteScalarAsync<decimal?>(
                    "SELECT StandardCost FROM Production.Product WHERE ProductID = @Id",
                    new { Id = sf.ProductId }) ?? 0;

            // Add flat shipping estimate (minimum ship base)
            decimal shippingEst = 8.99m; // CARGO TRANSPORT 5 ShipBase as floor estimate
            decimal price = cheapest ?? 0m;
            totalCost += (price + shippingEst / sf.ShortfallForQty) * sf.ShortfallForQty;
        }
        return Math.Round(totalCost, 2);
    }

    // ── Current Manufacturing Cost (using ProductCostHistory) ─────────────────

    /// <summary>
    /// Calculates the current accurate manufacturing cost for a finished good using the
    /// latest ProductCostHistory entries for all components, falling back to ProductVendor.LastReceiptCost
    /// and then Product.StandardCost. This provides real-time costing for the UI.
    /// </summary>
    public async Task<CurrentManufacturingCost?> GetCurrentManufacturingCostAsync(int productId)
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var product = await conn.QuerySingleOrDefaultAsync(@"
            SELECT ProductID, Name, ListPrice
            FROM Production.Product
            WHERE ProductID = @Id AND MakeFlag = 1 AND FinishedGoodsFlag = 1",
            new { Id = productId });
        if (product == null) return null;

        // Full BOM (all levels, both purchased and manufactured components)
        var bom = await conn.QueryAsync(@"
            WITH BomTree AS (
                SELECT p.ProductID, p.Name, CAST(p.MakeFlag AS BIT) AS MakeFlag,
                       0 AS Depth, CAST(1.0 AS DECIMAL(18,4)) AS CumulativeQty
                FROM Production.Product p WHERE p.ProductID = @RootProductId
                UNION ALL
                SELECT pc.ProductID, pc.Name, CAST(pc.MakeFlag AS BIT),
                       bt.Depth + 1,
                       CAST(bt.CumulativeQty * bom.PerAssemblyQty AS DECIMAL(18,4))
                FROM BomTree bt
                INNER JOIN Production.BillOfMaterials bom
                    ON bom.ProductAssemblyID = bt.ProductID AND bom.EndDate IS NULL
                INNER JOIN Production.Product pc ON bom.ComponentID = pc.ProductID
            )
            SELECT bt.ProductID, bt.Name, bt.MakeFlag, SUM(bt.CumulativeQty) AS CumulativeQty,
                   p.StandardCost
            FROM BomTree bt
            INNER JOIN Production.Product p ON bt.ProductID = p.ProductID
            WHERE bt.ProductID <> @RootProductId
            GROUP BY bt.ProductID, bt.Name, bt.MakeFlag, p.StandardCost
            OPTION (MAXRECURSION 20)",
            new { RootProductId = productId });

        var bomLines = new List<CurrentCostBomLine>();
        
        foreach (var item in bom)
        {
            int componentId = (int)item.ProductID;
            string componentName = (string)item.Name;
            decimal requiredQty = (decimal)item.CumulativeQty;
            bool isPurchased = !(bool)item.MakeFlag;
            
            // Get the current cost from the best available source
            var costInfo = await GetCurrentComponentCostAsync(conn, componentId);
            
            decimal currentCost = costInfo.Cost;
            DateTime? costDate = costInfo.CostDate;
            string costSource = costInfo.Source;
            
            bomLines.Add(new CurrentCostBomLine(
                componentId,
                componentName,
                requiredQty,
                currentCost,
                costDate,
                requiredQty * currentCost,
                isPurchased,
                costSource));
        }

        decimal materialCost = bomLines.Sum(b => b.CostContribution);

        // Average total routing cost from the most recent 10 completed work orders
        var routingCost = await conn.ExecuteScalarAsync<decimal?>(@"
            SELECT AVG(totalCost)
            FROM (
                SELECT TOP 10 SUM(ISNULL(wor.ActualCost, wor.PlannedCost)) AS totalCost
                FROM Production.WorkOrder wo
                INNER JOIN Production.WorkOrderRouting wor ON wo.WorkOrderID = wor.WorkOrderID
                WHERE wo.ProductID = @ProductId AND wo.EndDate IS NOT NULL
                GROUP BY wo.WorkOrderID
                ORDER BY wo.WorkOrderID DESC
            ) t",
            new { ProductId = productId }) ?? 0;

        decimal listPrice = (decimal)product.ListPrice;
        decimal totalCost = materialCost + routingCost;
        decimal marginPct = listPrice > 0 ? (listPrice - totalCost) / listPrice : -1;

        string signal = (listPrice, marginPct) switch
        {
            (0, _)       => "no-price",
            (_, < 0)     => "loss-making",
            (_, < 0.15m) => "thin-margin",
            _            => "healthy",
        };

        return new CurrentManufacturingCost(
            productId,
            (string)product.Name,
            listPrice,
            materialCost,
            routingCost,
            totalCost,
            marginPct,
            signal,
            DateTime.UtcNow,
            bomLines);
    }

    /// <summary>
    /// Gets the current cost for a component from the best available source:
    /// 1. ProductCostHistory (latest entry with NULL EndDate or most recent)
    /// 2. ProductVendor.LastReceiptCost (for purchased components)
    /// 3. Product.StandardCost (fallback)
    /// </summary>
    private async Task<(decimal Cost, DateTime? CostDate, string Source)> GetCurrentComponentCostAsync(
        SqlConnection conn, int productId)
    {
        // Try ProductCostHistory first (most accurate, captures vendor purchase history)
        var costHistory = await conn.QuerySingleOrDefaultAsync<dynamic>(@"
            SELECT TOP 1 StandardCost, StartDate
            FROM Production.ProductCostHistory
            WHERE ProductID = @ProductId
              AND (EndDate IS NULL OR EndDate >= GETDATE())
            ORDER BY StartDate DESC",
            new { ProductId = productId });

        if (costHistory != null && costHistory.StandardCost != null)
        {
            return ((decimal)costHistory.StandardCost, 
                    (DateTime?)costHistory.StartDate, 
                    "ProductCostHistory");
        }

        // Try ProductVendor.LastReceiptCost (for recently purchased components)
        var lastReceipt = await conn.QuerySingleOrDefaultAsync<dynamic>(@"
            SELECT TOP 1 LastReceiptCost, LastReceiptDate
            FROM Purchasing.ProductVendor
            WHERE ProductID = @ProductId
              AND LastReceiptCost IS NOT NULL
            ORDER BY LastReceiptDate DESC",
            new { ProductId = productId });

        if (lastReceipt != null && lastReceipt.LastReceiptCost != null)
        {
            return ((decimal)lastReceipt.LastReceiptCost,
                    (DateTime?)lastReceipt.LastReceiptDate,
                    "ProductVendor.LastReceiptCost");
        }

        // Fallback to Product.StandardCost
        var standardCost = await conn.ExecuteScalarAsync<decimal?>(
            "SELECT StandardCost FROM Production.Product WHERE ProductID = @Id",
            new { Id = productId }) ?? 0;

        return (standardCost, null, "Product.StandardCost");
    }
}
