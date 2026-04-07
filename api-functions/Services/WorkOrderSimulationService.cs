using System.Data;
using System.Text.Json;
using Azure.Data.Tables;
using Azure.Identity;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

// ── Data transfer types ──────────────────────────────────────────────────────

public record ProductInfo(int ProductId, string Name, bool MakeFlag, bool FinishedGoodsFlag);
public record BomRow(int ProductId, string Name, bool MakeFlag, int Depth, decimal CumulativeQty, int? ParentProductId);
public record InventoryWarning(int ProductId, string Name, int Required, int Available, int Shortfall);
public record RoutingOpTemplate(int OperationSequence, int LocationId, decimal PlannedCost, decimal CostRate);
public record RoutingOpInfo(int WorkOrderId, int ProductId, int OperationSequence, int LocationId, decimal PlannedCost, decimal CostRate);
public record LocationConfigData(int LocationId, int CapacityUnits, double DailyOperatingHours, double SpeedFactor, double OvertimeMultiplier, int ShiftStartHour, string? Note);
public record ScrapConfigData(int LocationId, string LocationName, double FailureRatePct, int[] ScrapReasonIds, string? Note);
public record ShortageData(int WorkOrderId, int ProductId, string ProductName, int Needed, int Available, int Shortfall, DateTime LastRetryUtc);
public record ScrapEventData(int WorkOrderId, int ProductId, string ProductName, int LocationId, string LocationName, int ScrapReasonId, string ScrapReasonName, bool IsTotalFailure, DateTime FailedAtUtc);
public record ActiveOperationData(int WorkOrderId, int ProductId, string ProductName, int OperationSequence, int LocationId, string LocationName, DateTime ActualStartDate, double ElapsedMinutes);
public record LocationLoadData(int LocationId, string LocationName, DateTime? EarliestFreeSlotUtc, double AvailabilityHrs, int CapacityUnits);
public record ManufacturingStatusData(bool IsRunning, long QueueDepth, int PendingWorkOrders, int InProgressWorkOrders, int CompletedToday, int StalledForMaterials, List<ShortageData> Shortages, List<ScrapEventData> RecentScrapEvents, List<LocationLoadData> LocationLoad);
public record RunWoItem(int WorkOrderId, int ProductId, int? ParentProductId, bool IsLeaf);
public record ManufacturingRunRecord(string RunId, int RootProductId, int RootWorkOrderId, DateTime StartedUtc, List<RunWoItem> WorkOrders);
public record BeginManufacturingResult(string RunId, int RootWorkOrderId, int TotalWorkOrders, int LeafWorkOrders, List<InventoryWarning> Warnings);

internal class LocationSlot
{
    public int SlotIndex { get; set; }
    public DateTime BusyUntilUtc { get; set; }
}

// ── Service ──────────────────────────────────────────────────────────────────

public class WorkOrderSimulationService
{
    // Table Storage — one table, multiple logical partitions
    private const string TABLE_NAME = "awManufacturing";
    private const string PART_LOCATION_CONFIG = "locationconfig";
    private const string PART_LOCATION_SLOTS  = "locationslots";
    private const string PART_SCRAP_CONFIG    = "scrapconfig";
    private const string PART_SHORTAGE        = "shortage";
    private const string PART_SCRAP_EVENT     = "scrapevent";
    private const string PART_RUN             = "run";

    // LocationID → (default failure rate, applicable ScrapReasonIDs)
    private static readonly Dictionary<int, (double Rate, int[] Reasons)> DefaultScrapMap = new()
    {
        [10] = (0.05, new[] { 3, 4, 5, 6, 12, 13, 14, 15 }),  // Frame Forming
        [20] = (0.03, new[] { 3, 11 }),                          // Frame Welding
        [30] = (0.04, new[] { 3, 7, 14, 15 }),                   // Debur and Polish
        [40] = (0.05, new[] { 2, 8, 9 }),                        // Paint
        [45] = (0.06, new[] { 2, 8, 9 }),                        // Specialized Paint
        [50] = (0.04, new[] { 1, 7, 10, 16 }),                   // Subassembly
        [60] = (0.03, new[] { 1, 7, 10, 11, 16 }),               // Final Assembly
    };

    // Default routing ops for products with no historical routing data
    private static readonly RoutingOpTemplate[] DefaultLeafRouting =
    {
        new(1, 50,  50m, 12.25m),  // Subassembly
    };
    private static readonly RoutingOpTemplate[] DefaultAssemblyRouting =
    {
        new(1, 50, 100m, 12.25m),  // Subassembly
        new(2, 60, 150m, 12.25m),  // Final Assembly
    };

    private readonly string _connectionString;
    private readonly TableClient _tableClient;
    private readonly double _simulationTimeScale;
    private readonly double _defaultScrapRate;
    private readonly ILogger<WorkOrderSimulationService> _logger;

    public WorkOrderSimulationService(
        string connectionString,
        string tableServiceUri,
        double simulationTimeScale,
        double defaultScrapRate,
        ILogger<WorkOrderSimulationService> logger)
    {
        _connectionString = connectionString;
        _simulationTimeScale = simulationTimeScale;
        _defaultScrapRate = defaultScrapRate;
        _logger = logger;

        var tableServiceClient = new TableServiceClient(
            new Uri(tableServiceUri),
            new DefaultAzureCredential());
        _tableClient = tableServiceClient.GetTableClient(TABLE_NAME);
    }

    // ── SQL helpers ──────────────────────────────────────────────────────────

    private async Task<IDbConnection> GetConnectionAsync()
    {
        var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();
        return conn;
    }

    // ── Table setup ──────────────────────────────────────────────────────────

    public async Task InitializeTablesAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        await InitializeLocationConfigAsync();
        await InitializeScrapConfigAsync();
    }

    // ── BOM methods ──────────────────────────────────────────────────────────

    public async Task<ProductInfo?> ValidateFinishedGoodAsync(int productId)
    {
        using var conn = await GetConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync(
            "SELECT ProductID, Name, CAST(MakeFlag AS BIT) AS MakeFlag, CAST(FinishedGoodsFlag AS BIT) AS FinishedGoodsFlag " +
            "FROM Production.Product WHERE ProductID = @ProductId",
            new { ProductId = productId });
        if (row == null) return null;
        return new ProductInfo((int)row.ProductID, (string)row.Name, (bool)row.MakeFlag, (bool)row.FinishedGoodsFlag);
    }

    /// <summary>
    /// Explodes the BOM recursively from rootProductId.
    /// Returns a flat list ordered by ascending depth; duplicates (diamond deps) are kept — caller aggregates.
    /// </summary>
    public async Task<List<BomRow>> GetBomFlatAsync(int rootProductId)
    {
        using var conn = await GetConnectionAsync();
        const string sql = @"
            WITH BomTree AS (
                SELECT p.ProductID, p.Name,
                       CAST(p.MakeFlag AS BIT)            AS MakeFlag,
                       0                                   AS Depth,
                       CAST(1.0 AS DECIMAL(18,4))          AS CumulativeQty,
                       CAST(NULL AS INT)                   AS ParentProductId
                FROM Production.Product p WHERE p.ProductID = @RootProductId
                UNION ALL
                SELECT pc.ProductID, pc.Name,
                       CAST(pc.MakeFlag AS BIT),
                       bt.Depth + 1,
                       CAST(bt.CumulativeQty * bom.PerAssemblyQty AS DECIMAL(18,4)),
                       bt.ProductID
                FROM BomTree bt
                INNER JOIN Production.BillOfMaterials bom
                    ON bom.ProductAssemblyID = bt.ProductID AND bom.EndDate IS NULL
                INNER JOIN Production.Product pc ON bom.ComponentID = pc.ProductID
            )
            SELECT ProductID, Name, MakeFlag, Depth, CumulativeQty, ParentProductId
            FROM BomTree
            ORDER BY Depth, ProductID
            OPTION (MAXRECURSION 20)";

        var rows = await conn.QueryAsync(sql, new { RootProductId = rootProductId });
        return rows.Select(r => new BomRow(
            (int)r.ProductID, (string)r.Name, (bool)r.MakeFlag,
            (int)r.Depth, (decimal)r.CumulativeQty, (int?)r.ParentProductId)).ToList();
    }

    public async Task<List<InventoryWarning>> GetInventoryWarningsAsync(List<BomRow> purchasedNodes, int rootOrderQty)
    {
        if (!purchasedNodes.Any()) return new List<InventoryWarning>();
        using var conn = await GetConnectionAsync();

        var warnings = new List<InventoryWarning>();
        foreach (var node in purchasedNodes)
        {
            var required = (int)Math.Ceiling((double)node.CumulativeQty * rootOrderQty);
            var available = await conn.ExecuteScalarAsync<int>(
                "SELECT ISNULL(SUM(Quantity), 0) FROM Production.ProductInventory WHERE ProductID = @ProductId",
                new { ProductId = node.ProductId });
            if (available < required)
                warnings.Add(new InventoryWarning(node.ProductId, node.Name, required, available, required - available));
        }
        return warnings;
    }

    // ── WorkOrder creation ───────────────────────────────────────────────────

    public async Task<int> CreateWorkOrderAsync(int productId, int orderQty, DateTime startDate, DateTime dueDate)
    {
        using var conn = await GetConnectionAsync();
        var workOrderId = await conn.ExecuteScalarAsync<int>(@"
            INSERT INTO Production.WorkOrder
                (ProductID, OrderQty, ScrappedQty, StartDate, DueDate, ModifiedDate)
            OUTPUT INSERTED.WorkOrderID
            VALUES (@ProductId, @OrderQty, 0, @StartDate, @DueDate, GETDATE())",
            new { ProductId = productId, OrderQty = orderQty, StartDate = startDate, DueDate = dueDate });
        return workOrderId;
    }

    public async Task<List<RoutingOpTemplate>> GetRoutingTemplateAsync(int productId, bool isAssemblyNode)
    {
        using var conn = await GetConnectionAsync();
        var rows = await conn.QueryAsync(@"
            SELECT wor.OperationSequence, wor.LocationID,
                   CAST(AVG(wor.PlannedCost) AS DECIMAL(10,4)) AS PlannedCost,
                   l.CostRate
            FROM Production.WorkOrderRouting wor
            INNER JOIN Production.Location l ON wor.LocationID = l.LocationID
            WHERE wor.ProductID = @ProductId
            GROUP BY wor.OperationSequence, wor.LocationID, l.CostRate
            ORDER BY wor.OperationSequence",
            new { ProductId = productId });

        var templates = rows.Select(r => new RoutingOpTemplate(
            (int)r.OperationSequence, (int)r.LocationID,
            (decimal)r.PlannedCost, (decimal)r.CostRate)).ToList();

        if (!templates.Any())
            templates = (isAssemblyNode ? DefaultAssemblyRouting : DefaultLeafRouting).ToList();

        return templates;
    }

    public async Task CreateWorkOrderRoutingAsync(int workOrderId, int productId,
        List<RoutingOpTemplate> routing, DateTime scheduledStart, DateTime scheduledEnd)
    {
        using var conn = await GetConnectionAsync();
        foreach (var op in routing)
        {
            await conn.ExecuteAsync(@"
                INSERT INTO Production.WorkOrderRouting
                    (WorkOrderID, ProductID, OperationSequence, LocationID,
                     ScheduledStartDate, ScheduledEndDate, PlannedCost, ModifiedDate)
                VALUES (@WorkOrderId, @ProductId, @OperationSequence, @LocationId,
                        @ScheduledStart, @ScheduledEnd, @PlannedCost, GETDATE())",
                new
                {
                    WorkOrderId = workOrderId, ProductId = productId,
                    op.OperationSequence, LocationId = op.LocationId,
                    ScheduledStart = scheduledStart, ScheduledEnd = scheduledEnd,
                    op.PlannedCost
                });
        }
    }

    public async Task<RoutingOpInfo?> GetFirstRoutingOpAsync(int workOrderId)
    {
        using var conn = await GetConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync(@"
            SELECT TOP 1 wor.WorkOrderID, wor.ProductID, wor.OperationSequence,
                         wor.LocationID, wor.PlannedCost, l.CostRate
            FROM Production.WorkOrderRouting wor
            INNER JOIN Production.Location l ON wor.LocationID = l.LocationID
            WHERE wor.WorkOrderID = @WorkOrderId AND wor.ActualEndDate IS NULL
            ORDER BY wor.OperationSequence ASC",
            new { WorkOrderId = workOrderId });
        if (row == null) return null;
        return new RoutingOpInfo((int)row.WorkOrderID, (int)row.ProductID, (int)row.OperationSequence,
            (int)row.LocationID, (decimal)row.PlannedCost, (decimal)row.CostRate);
    }

    // ── Routing op lifecycle ─────────────────────────────────────────────────

    /// <summary>Atomically set ActualStartDate if not already set. Returns false if already claimed.</summary>
    public async Task<bool> SetActualStartDateAsync(int workOrderId, int opSeq, DateTime startUtc)
    {
        using var conn = await GetConnectionAsync();
        var rows = await conn.ExecuteAsync(@"
            UPDATE Production.WorkOrderRouting
            SET ActualStartDate = @StartDate, ModifiedDate = GETDATE()
            WHERE WorkOrderID = @WorkOrderId AND OperationSequence = @OpSeq
              AND ActualStartDate IS NULL",
            new { WorkOrderId = workOrderId, OpSeq = opSeq, StartDate = startUtc });
        return rows > 0;
    }

    /// <summary>Atomically set ActualEndDate if not already set. Returns false if already completed.</summary>
    public async Task<bool> SetActualEndDateAsync(int workOrderId, int opSeq,
        DateTime endUtc, decimal actualHrs, decimal actualCost)
    {
        using var conn = await GetConnectionAsync();
        var rows = await conn.ExecuteAsync(@"
            UPDATE Production.WorkOrderRouting
            SET ActualEndDate = @EndDate, ActualResourceHrs = @Hrs,
                ActualCost = @Cost, ModifiedDate = GETDATE()
            WHERE WorkOrderID = @WorkOrderId AND OperationSequence = @OpSeq
              AND ActualEndDate IS NULL",
            new { WorkOrderId = workOrderId, OpSeq = opSeq, EndDate = endUtc, Hrs = actualHrs, Cost = actualCost });
        return rows > 0;
    }

    public async Task<RoutingOpInfo?> GetNextRoutingOpAsync(int workOrderId, int completedOpSeq)
    {
        using var conn = await GetConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync(@"
            SELECT TOP 1 wor.WorkOrderID, wor.ProductID, wor.OperationSequence,
                         wor.LocationID, wor.PlannedCost, l.CostRate
            FROM Production.WorkOrderRouting wor
            INNER JOIN Production.Location l ON wor.LocationID = l.LocationID
            WHERE wor.WorkOrderID = @WorkOrderId AND wor.OperationSequence > @CompletedSeq
              AND wor.ActualEndDate IS NULL
            ORDER BY wor.OperationSequence ASC",
            new { WorkOrderId = workOrderId, CompletedSeq = completedOpSeq });
        if (row == null) return null;
        return new RoutingOpInfo((int)row.WorkOrderID, (int)row.ProductID, (int)row.OperationSequence,
            (int)row.LocationID, (decimal)row.PlannedCost, (decimal)row.CostRate);
    }

    public async Task UpdateWorkOrderScrapAsync(int workOrderId, int additionalScrap, int scrapReasonId)
    {
        using var conn = await GetConnectionAsync();
        await conn.ExecuteAsync(@"
            UPDATE Production.WorkOrder
            SET ScrappedQty = ScrappedQty + @AdditionalScrap,
                ScrapReasonID = @ScrapReasonId, ModifiedDate = GETDATE()
            WHERE WorkOrderID = @WorkOrderId",
            new { WorkOrderId = workOrderId, AdditionalScrap = additionalScrap, ScrapReasonId = scrapReasonId });
    }

    /// <summary>
    /// Marks a WorkOrder fully complete. Sets EndDate and updates ProductInventory
    /// at LocationID=7 (Finished Goods Storage) with the stocked quantity.
    /// </summary>
    public async Task CompleteWorkOrderAsync(int workOrderId)
    {
        using var conn = await GetConnectionAsync();

        // Read orderQty and scrappedQty to compute stocked qty (StockedQty is a computed column)
        var wo = await conn.QuerySingleOrDefaultAsync(
            "SELECT ProductID, OrderQty, ScrappedQty FROM Production.WorkOrder WHERE WorkOrderID = @WorkOrderId",
            new { WorkOrderId = workOrderId });
        if (wo == null) return;

        int productId = (int)wo.ProductID;
        int orderQty  = (int)wo.OrderQty;
        int scrapped  = (int)wo.ScrappedQty;
        int stocked   = orderQty - scrapped;

        await conn.ExecuteAsync(@"
            UPDATE Production.WorkOrder
            SET EndDate = GETDATE(), ModifiedDate = GETDATE()
            WHERE WorkOrderID = @WorkOrderId AND EndDate IS NULL",
            new { WorkOrderId = workOrderId });

        if (stocked > 0)
        {
            // Upsert ProductInventory at Finished Goods Storage (LocationID=7)
            await conn.ExecuteAsync(@"
                IF EXISTS (SELECT 1 FROM Production.ProductInventory WHERE ProductID = @ProductId AND LocationID = 7)
                    UPDATE Production.ProductInventory
                    SET Quantity = Quantity + @Qty, ModifiedDate = GETDATE()
                    WHERE ProductID = @ProductId AND LocationID = 7
                ELSE
                    INSERT INTO Production.ProductInventory
                        (ProductID, LocationID, Shelf, Bin, Quantity, rowguid, ModifiedDate)
                    VALUES (@ProductId, 7, 'A', 1, @Qty, NEWID(), GETDATE())",
                new { ProductId = productId, Qty = stocked });
        }

        _logger.LogInformation("WorkOrder {WorkOrderId} (Product {ProductId}) completed. Stocked={Stocked}, Scrapped={Scrapped}",
            workOrderId, productId, stocked, scrapped);
    }

    // ── Inventory consumption ────────────────────────────────────────────────

    public async Task<List<(int ProductId, int RequiredQty)>> GetPurchasedComponentsAsync(
        int assemblyProductId, int orderQty)
    {
        using var conn = await GetConnectionAsync();
        var rows = await conn.QueryAsync(@"
            SELECT bom.ComponentID AS ProductId,
                   CEILING(bom.PerAssemblyQty * @OrderQty) AS RequiredQty
            FROM Production.BillOfMaterials bom
            INNER JOIN Production.Product p ON bom.ComponentID = p.ProductID
            WHERE bom.ProductAssemblyID = @AssemblyProductId
              AND bom.EndDate IS NULL
              AND p.MakeFlag = 0",
            new { AssemblyProductId = assemblyProductId, OrderQty = orderQty });
        return rows.Select(r => ((int)r.ProductId, (int)r.RequiredQty)).ToList();
    }

    public async Task<bool> IsFirstRoutingOpAsync(int workOrderId, int opSeq)
    {
        using var conn = await GetConnectionAsync();
        var count = await conn.ExecuteScalarAsync<int>(@"
            SELECT COUNT(*) FROM Production.WorkOrderRouting
            WHERE WorkOrderID = @WorkOrderId AND OperationSequence < @OpSeq
              AND ActualEndDate IS NOT NULL",
            new { WorkOrderId = workOrderId, OpSeq = opSeq });
        return count == 0;
    }

    /// <summary>
    /// Atomically deducts inventory from bins (largest bin first).
    /// Returns false if total available is insufficient — caller writes a shortage record.
    /// </summary>
    public async Task<(bool Success, int Available)> ConsumeInventoryAsync(int productId, int requiredQty)
    {
        using var conn = await GetConnectionAsync();
        using var tran = conn.BeginTransaction();
        try
        {
            var total = await conn.ExecuteScalarAsync<int>(
                "SELECT ISNULL(SUM(Quantity), 0) FROM Production.ProductInventory WITH (UPDLOCK) WHERE ProductID = @ProductId",
                new { ProductId = productId }, tran);

            if (total < requiredQty)
            {
                tran.Rollback();
                return (false, total);
            }

            var bins = (await conn.QueryAsync<(int LocationId, int Quantity)>(
                "SELECT LocationID, Quantity FROM Production.ProductInventory WHERE ProductID = @ProductId AND Quantity > 0 ORDER BY Quantity DESC",
                new { ProductId = productId }, tran)).ToList();

            int remaining = requiredQty;
            foreach (var (locationId, qty) in bins)
            {
                if (remaining <= 0) break;
                int toDeduct = Math.Min(remaining, qty);
                await conn.ExecuteAsync(
                    "UPDATE Production.ProductInventory SET Quantity = Quantity - @Deduct, ModifiedDate = GETDATE() " +
                    "WHERE ProductID = @ProductId AND LocationID = @LocationId",
                    new { Deduct = toDeduct, ProductId = productId, LocationId = locationId }, tran);
                remaining -= toDeduct;
            }

            tran.Commit();
            return (true, total);
        }
        catch
        {
            tran.Rollback();
            throw;
        }
    }

    // ── Run tracking (Table Storage) ─────────────────────────────────────────

    public async Task SaveRunAsync(ManufacturingRunRecord run)
    {
        var entity = new TableEntity(PART_RUN, run.RunId)
        {
            ["RootProductId"]    = run.RootProductId,
            ["RootWorkOrderId"]  = run.RootWorkOrderId,
            ["StartedUtc"]       = run.StartedUtc,
            ["WorkOrdersJson"]   = JsonSerializer.Serialize(run.WorkOrders),
        };
        await _tableClient.UpsertEntityAsync(entity);
    }

    public async Task<ManufacturingRunRecord?> GetRunAsync(string runId)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_RUN, runId);
        if (!resp.HasValue) return null;
        var e = resp.Value!;
        var wos = JsonSerializer.Deserialize<List<RunWoItem>>(e.GetString("WorkOrdersJson") ?? "[]")!;
        return new ManufacturingRunRecord(runId,
            e.GetInt32("RootProductId") ?? 0,
            e.GetInt32("RootWorkOrderId") ?? 0,
            e.GetDateTimeOffset("StartedUtc")?.UtcDateTime ?? DateTime.UtcNow,
            wos);
    }

    // ── Parent assembly unblocking ────────────────────────────────────────────

    private async Task<List<int>> GetBomParentProductIdsAsync(int completedProductId)
    {
        using var conn = await GetConnectionAsync();
        var ids = await conn.QueryAsync<int>(@"
            SELECT DISTINCT bom.ProductAssemblyID
            FROM Production.BillOfMaterials bom
            INNER JOIN Production.Product p ON bom.ProductAssemblyID = p.ProductID
            WHERE bom.ComponentID = @CompletedProductId
              AND bom.ProductAssemblyID IS NOT NULL
              AND bom.EndDate IS NULL
              AND p.MakeFlag = 1",
            new { CompletedProductId = completedProductId });
        return ids.ToList();
    }

    private async Task<List<int>> GetManufacturedBomChildProductIdsAsync(int parentProductId)
    {
        using var conn = await GetConnectionAsync();
        var ids = await conn.QueryAsync<int>(@"
            SELECT DISTINCT bom.ComponentID
            FROM Production.BillOfMaterials bom
            INNER JOIN Production.Product p ON bom.ComponentID = p.ProductID
            WHERE bom.ProductAssemblyID = @ParentProductId
              AND bom.EndDate IS NULL AND p.MakeFlag = 1",
            new { ParentProductId = parentProductId });
        return ids.ToList();
    }

    private async Task<DateTime?> GetWorkOrderEndDateAsync(int workOrderId)
    {
        using var conn = await GetConnectionAsync();
        return await conn.ExecuteScalarAsync<DateTime?>(
            "SELECT EndDate FROM Production.WorkOrder WHERE WorkOrderID = @WorkOrderId",
            new { WorkOrderId = workOrderId });
    }

    public async Task<List<int>> GetReadyParentWorkOrderIdsAsync(string runId, int completedProductId)
    {
        var run = await GetRunAsync(runId);
        if (run == null) return new List<int>();

        var parentProductIds = await GetBomParentProductIdsAsync(completedProductId);
        var readyWoIds = new List<int>();

        foreach (var parentProductId in parentProductIds)
        {
            var parentWoItem = run.WorkOrders.FirstOrDefault(wo => wo.ProductId == parentProductId);
            if (parentWoItem == null) continue;

            // Parent must still be pending
            var parentEndDate = await GetWorkOrderEndDateAsync(parentWoItem.WorkOrderId);
            if (parentEndDate.HasValue) continue;

            // All manufactured children must be completed
            var childProductIds = await GetManufacturedBomChildProductIdsAsync(parentProductId);
            bool allDone = true;
            foreach (var childProductId in childProductIds)
            {
                var childWoItem = run.WorkOrders.FirstOrDefault(wo => wo.ProductId == childProductId);
                if (childWoItem == null) { allDone = false; break; }
                var childEnd = await GetWorkOrderEndDateAsync(childWoItem.WorkOrderId);
                if (!childEnd.HasValue) { allDone = false; break; }
            }

            if (allDone)
                readyWoIds.Add(parentWoItem.WorkOrderId);
        }
        return readyWoIds;
    }

    // ── Location capacity (Table Storage) ────────────────────────────────────

    private async Task InitializeLocationConfigAsync()
    {
        using var conn = await GetConnectionAsync();
        var locations = await conn.QueryAsync(
            "SELECT LocationID, Name, CostRate, Availability FROM Production.Location WHERE CostRate > 0");

        foreach (var loc in locations)
        {
            int locationId = (int)loc.LocationID;
            string rowKey = locationId.ToString();

            // Only seed if not already present
            var existing = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_LOCATION_CONFIG, rowKey);
            if (existing.HasValue) continue;

            double availHrs = (double)(decimal)loc.Availability;
            int capacityUnits = Math.Max(1, (int)Math.Floor(availHrs / 40.0));

            var entity = new TableEntity(PART_LOCATION_CONFIG, rowKey)
            {
                ["Name"]               = (string)loc.Name,
                ["CapacityUnits"]      = capacityUnits,
                ["DailyOperatingHrs"]  = 8.0,
                ["SpeedFactor"]        = 1.0,
                ["OvertimeMultiplier"] = 1.5,
                ["ShiftStartHour"]     = 6,
                ["AvailabilityHrs"]    = availHrs,
                ["Note"]               = "Seeded from Production.Location.Availability",
            };
            await _tableClient.UpsertEntityAsync(entity);
            _logger.LogInformation("Seeded LocationConfig for LocationID={LocationId} ({Name}), CapacityUnits={Units}",
                locationId, (string)loc.Name, capacityUnits);
        }
    }

    public async Task<LocationConfigData> GetLocationConfigAsync(int locationId)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_LOCATION_CONFIG, locationId.ToString());

        if (!resp.HasValue)
            return new LocationConfigData(locationId, 1, 8.0, 1.0, 1.5, 6, null);

        var e = resp.Value!;
        return new LocationConfigData(
            locationId,
            e.GetInt32("CapacityUnits") ?? 1,
            e.GetDouble("DailyOperatingHrs") ?? 8.0,
            e.GetDouble("SpeedFactor") ?? 1.0,
            e.GetDouble("OvertimeMultiplier") ?? 1.5,
            e.GetInt32("ShiftStartHour") ?? 6,
            e.GetString("Note"));
    }

    public async Task UpsertLocationConfigAsync(int locationId, LocationConfigData config)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_LOCATION_CONFIG, locationId.ToString());
        var entity = resp.HasValue
            ? resp.Value!
            : new TableEntity(PART_LOCATION_CONFIG, locationId.ToString());

        entity["CapacityUnits"]      = config.CapacityUnits;
        entity["DailyOperatingHrs"]  = config.DailyOperatingHours;
        entity["SpeedFactor"]        = config.SpeedFactor;
        entity["OvertimeMultiplier"] = config.OvertimeMultiplier;
        entity["ShiftStartHour"]     = config.ShiftStartHour;
        entity["Note"]               = config.Note;
        await _tableClient.UpsertEntityAsync(entity);

        // Resize slot array if capacity changed
        await ResizeLocationSlotsAsync(locationId, config.CapacityUnits);
    }

    public async Task<List<LocationConfigData>> GetAllLocationConfigsAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var results = new List<LocationConfigData>();
        await foreach (var entity in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_LOCATION_CONFIG}'"))
        {
            if (!int.TryParse(entity.RowKey, out int locationId)) continue;
            results.Add(new LocationConfigData(
                locationId,
                entity.GetInt32("CapacityUnits") ?? 1,
                entity.GetDouble("DailyOperatingHrs") ?? 8.0,
                entity.GetDouble("SpeedFactor") ?? 1.0,
                entity.GetDouble("OvertimeMultiplier") ?? 1.5,
                entity.GetInt32("ShiftStartHour") ?? 6,
                entity.GetString("Note")));
        }
        return results;
    }

    private async Task<(List<LocationSlot> Slots, Azure.ETag ETag)> ReadLocationSlotsAsync(
        int locationId, int capacityUnits)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_LOCATION_SLOTS, locationId.ToString());

        if (!resp.HasValue)
        {
            var defaultSlots = Enumerable.Range(0, capacityUnits)
                .Select(i => new LocationSlot { SlotIndex = i, BusyUntilUtc = DateTime.MinValue })
                .ToList();
            return (defaultSlots, Azure.ETag.All);
        }

        var slots = JsonSerializer.Deserialize<List<LocationSlot>>(
            resp.Value!.GetString("SlotsJson") ?? "[]") ?? new List<LocationSlot>();

        // Ensure slot count matches current capacity
        while (slots.Count < capacityUnits)
            slots.Add(new LocationSlot { SlotIndex = slots.Count, BusyUntilUtc = DateTime.MinValue });
        if (slots.Count > capacityUnits)
            slots = slots.Take(capacityUnits).ToList();

        return (slots, resp.Value.ETag);
    }

    private async Task ResizeLocationSlotsAsync(int locationId, int newCapacity)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_LOCATION_SLOTS, locationId.ToString());
        if (!resp.HasValue) return;

        var slots = JsonSerializer.Deserialize<List<LocationSlot>>(
            resp.Value!.GetString("SlotsJson") ?? "[]") ?? new List<LocationSlot>();

        while (slots.Count < newCapacity)
            slots.Add(new LocationSlot { SlotIndex = slots.Count, BusyUntilUtc = DateTime.MinValue });
        if (slots.Count > newCapacity)
            slots = slots.Take(newCapacity).ToList();

        var entity = resp.Value!;
        entity["SlotsJson"] = JsonSerializer.Serialize(slots);
        await _tableClient.UpdateEntityAsync(entity, resp.Value.ETag);
    }

    /// <summary>
    /// Atomically reserves the earliest free slot at a location.
    /// Returns (claimed=true, startDelay) on success, (false, 5s) on ETag conflict for retry.
    /// startDelay is the time until the slot opens; 0 = free immediately.
    /// </summary>
    public async Task<(bool Claimed, TimeSpan StartDelay, TimeSpan TotalDuration)> TryClaimLocationSlotAsync(
        int locationId, double plannedCost, double costRate)
    {
        var config = await GetLocationConfigAsync(locationId);
        double adjustedDurationHrs = costRate > 0
            ? (plannedCost / costRate) / config.SpeedFactor
            : 0.5 / config.SpeedFactor;
        double realDurationSec = adjustedDurationHrs * 3600.0 / _simulationTimeScale;

        for (int attempt = 0; attempt < 3; attempt++)
        {
            var (slots, etag) = await ReadLocationSlotsAsync(locationId, config.CapacityUnits);
            var now = DateTime.UtcNow;

            var earliest = slots.OrderBy(s => s.BusyUntilUtc).First();
            var slotFreeAt = earliest.BusyUntilUtc < now ? now : earliest.BusyUntilUtc;
            var slotEndAt  = slotFreeAt.AddSeconds(realDurationSec);
            var startDelay = slotFreeAt > now ? slotFreeAt - now : TimeSpan.Zero;

            earliest.BusyUntilUtc = slotEndAt;

            var entity = new TableEntity(PART_LOCATION_SLOTS, locationId.ToString())
            {
                ["SlotsJson"] = JsonSerializer.Serialize(slots)
            };

            try
            {
                if (etag == Azure.ETag.All)
                    await _tableClient.AddEntityAsync(entity);
                else
                    await _tableClient.UpdateEntityAsync(entity, etag, TableUpdateMode.Replace);

                return (true, startDelay, TimeSpan.FromSeconds(realDurationSec));
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 412 || ex.Status == 409)
            {
                // ETag conflict — retry
                await Task.Delay(50 + Random.Shared.Next(100));
            }
        }

        // All retries failed — caller re-enqueues with short backoff
        return (false, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(realDurationSec));
    }

    public async Task<List<LocationLoadData>> GetLocationLoadsAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var loads = new List<LocationLoadData>();
        await foreach (var entity in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_LOCATION_SLOTS}'"))
        {
            if (!int.TryParse(entity.RowKey, out int locationId)) continue;
            var slots = JsonSerializer.Deserialize<List<LocationSlot>>(
                entity.GetString("SlotsJson") ?? "[]") ?? new List<LocationSlot>();

            var configResp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
                PART_LOCATION_CONFIG, locationId.ToString());
            string locationName = configResp.HasValue
                ? configResp.Value!.GetString("Name") ?? locationId.ToString()
                : locationId.ToString();
            double availHrs = configResp.HasValue
                ? configResp.Value!.GetDouble("AvailabilityHrs") ?? 0.0
                : 0.0;

            var earliest = slots.OrderBy(s => s.BusyUntilUtc).FirstOrDefault();
            loads.Add(new LocationLoadData(locationId, locationName,
                earliest?.BusyUntilUtc > DateTime.UtcNow ? earliest.BusyUntilUtc : null,
                availHrs, slots.Count));
        }
        return loads;
    }

    // ── Scrap config (Table Storage) ─────────────────────────────────────────

    private async Task InitializeScrapConfigAsync()
    {
        using var conn = await GetConnectionAsync();
        var locations = await conn.QueryAsync(
            "SELECT LocationID, Name FROM Production.Location WHERE CostRate > 0");

        foreach (var loc in locations)
        {
            int locationId = (int)loc.LocationID;
            var rowKey = locationId.ToString();
            var existing = await _tableClient.GetEntityIfExistsAsync<TableEntity>(PART_SCRAP_CONFIG, rowKey);
            if (existing.HasValue) continue;

            DefaultScrapMap.TryGetValue(locationId, out var defaults);
            var entity = new TableEntity(PART_SCRAP_CONFIG, rowKey)
            {
                ["LocationName"]       = (string)loc.Name,
                ["FailureRatePct"]     = defaults.Rate > 0 ? defaults.Rate : _defaultScrapRate,
                ["ScrapReasonIdsJson"] = JsonSerializer.Serialize(defaults.Reasons ?? Array.Empty<int>()),
                ["Note"]               = "Seeded from default mapping",
            };
            await _tableClient.UpsertEntityAsync(entity);
        }
    }

    public async Task<ScrapConfigData> GetScrapConfigAsync(int locationId)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_SCRAP_CONFIG, locationId.ToString());

        if (!resp.HasValue)
        {
            DefaultScrapMap.TryGetValue(locationId, out var def);
            return new ScrapConfigData(locationId, locationId.ToString(),
                def.Rate > 0 ? def.Rate : _defaultScrapRate,
                def.Reasons ?? Array.Empty<int>(), null);
        }

        var e = resp.Value!;
        var reasonIds = JsonSerializer.Deserialize<int[]>(e.GetString("ScrapReasonIdsJson") ?? "[]")
                        ?? Array.Empty<int>();
        return new ScrapConfigData(locationId,
            e.GetString("LocationName") ?? locationId.ToString(),
            e.GetDouble("FailureRatePct") ?? _defaultScrapRate,
            reasonIds, e.GetString("Note"));
    }

    public async Task UpsertScrapConfigAsync(int locationId, double failureRatePct, int[] scrapReasonIds, string? note)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_SCRAP_CONFIG, locationId.ToString());
        var entity = resp.HasValue ? resp.Value! : new TableEntity(PART_SCRAP_CONFIG, locationId.ToString());
        entity["FailureRatePct"]     = failureRatePct;
        entity["ScrapReasonIdsJson"] = JsonSerializer.Serialize(scrapReasonIds);
        entity["Note"]               = note;
        await _tableClient.UpsertEntityAsync(entity);
    }

    public async Task<List<ScrapConfigData>> GetAllScrapConfigsAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var results = new List<ScrapConfigData>();
        await foreach (var entity in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_SCRAP_CONFIG}'"))
        {
            if (!int.TryParse(entity.RowKey, out int locationId)) continue;
            var reasonIds = JsonSerializer.Deserialize<int[]>(entity.GetString("ScrapReasonIdsJson") ?? "[]")
                            ?? Array.Empty<int>();
            results.Add(new ScrapConfigData(locationId,
                entity.GetString("LocationName") ?? locationId.ToString(),
                entity.GetDouble("FailureRatePct") ?? _defaultScrapRate,
                reasonIds, entity.GetString("Note")));
        }
        return results;
    }

    // ── Shortage tracking (Table Storage) ────────────────────────────────────

    public async Task WriteShortageAsync(int workOrderId, int productId, string productName,
        int needed, int available)
    {
        var rowKey = $"wo{workOrderId}p{productId}";
        var entity = new TableEntity(PART_SHORTAGE, rowKey)
        {
            ["WorkOrderId"]  = workOrderId,
            ["ProductId"]    = productId,
            ["ProductName"]  = productName,
            ["Needed"]       = needed,
            ["Available"]    = available,
            ["Shortfall"]    = needed - available,
            ["LastRetryUtc"] = DateTime.UtcNow,
        };
        await _tableClient.UpsertEntityAsync(entity);
    }

    public async Task ClearShortageAsync(int workOrderId, int productId)
    {
        try
        {
            await _tableClient.DeleteEntityAsync(PART_SHORTAGE, $"wo{workOrderId}p{productId}");
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 404) { /* Already gone */ }
    }

    public async Task<List<ShortageData>> GetAllShortagesAsync()
    {
        await _tableClient.CreateIfNotExistsAsync();
        var results = new List<ShortageData>();
        await foreach (var entity in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_SHORTAGE}'"))
        {
            results.Add(new ShortageData(
                entity.GetInt32("WorkOrderId") ?? 0,
                entity.GetInt32("ProductId") ?? 0,
                entity.GetString("ProductName") ?? "",
                entity.GetInt32("Needed") ?? 0,
                entity.GetInt32("Available") ?? 0,
                entity.GetInt32("Shortfall") ?? 0,
                entity.GetDateTimeOffset("LastRetryUtc")?.UtcDateTime ?? DateTime.UtcNow));
        }
        return results;
    }

    // ── Scrap events (Table Storage) ─────────────────────────────────────────

    public async Task WriteScrapEventAsync(int workOrderId, int productId, string productName,
        int locationId, string locationName, int scrapReasonId, string scrapReasonName,
        bool isTotalFailure)
    {
        // Reverse-chronological rowKey ensures most recent events sort first
        var rowKey = $"{long.MaxValue - DateTimeOffset.UtcNow.Ticks:D19}_{workOrderId}";
        var entity = new TableEntity(PART_SCRAP_EVENT, rowKey)
        {
            ["WorkOrderId"]    = workOrderId,
            ["ProductId"]      = productId,
            ["ProductName"]    = productName,
            ["LocationId"]     = locationId,
            ["LocationName"]   = locationName,
            ["ScrapReasonId"]  = scrapReasonId,
            ["ScrapReasonName"] = scrapReasonName,
            ["IsTotalFailure"] = isTotalFailure,
            ["FailedAtUtc"]    = DateTime.UtcNow,
        };
        await _tableClient.UpsertEntityAsync(entity);
    }

    public async Task<List<ScrapEventData>> GetRecentScrapEventsAsync(int count = 10)
    {await _tableClient.CreateIfNotExistsAsync();
        
        var results = new List<ScrapEventData>();
        await foreach (var entity in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_SCRAP_EVENT}'",
            maxPerPage: count))
        {
            results.Add(new ScrapEventData(
                entity.GetInt32("WorkOrderId") ?? 0,
                entity.GetInt32("ProductId") ?? 0,
                entity.GetString("ProductName") ?? "",
                entity.GetInt32("LocationId") ?? 0,
                entity.GetString("LocationName") ?? "",
                entity.GetInt32("ScrapReasonId") ?? 0,
                entity.GetString("ScrapReasonName") ?? "",
                entity.GetBoolean("IsTotalFailure") ?? false,
                entity.GetDateTimeOffset("FailedAtUtc")?.UtcDateTime ?? DateTime.UtcNow));

            if (results.Count >= count) break;
        }
        return results;
    }

    // ── Scrap reason lookup ──────────────────────────────────────────────────

    public async Task<string> GetScrapReasonNameAsync(int scrapReasonId)
    {
        using var conn = await GetConnectionAsync();
        return await conn.ExecuteScalarAsync<string>(
            "SELECT Name FROM Production.ScrapReason WHERE ScrapReasonID = @Id",
            new { Id = scrapReasonId }) ?? "Unknown";
    }

    // ── Status queries ────────────────────────────────────────────────────────

    public async Task<(int Pending, int InProgress, int CompletedToday)> GetWorkOrderCountsAsync()
    {
        using var conn = await GetConnectionAsync();
        var row = await conn.QuerySingleAsync(@"
            SELECT
                ISNULL(SUM(CASE WHEN HasStarted = 0 AND IsComplete = 0 THEN 1 ELSE 0 END), 0) AS Pending,
                ISNULL(SUM(CASE WHEN HasStarted = 1 AND IsComplete = 0 THEN 1 ELSE 0 END), 0) AS InProgress,
                ISNULL(SUM(CASE WHEN IsComplete = 1 AND CompletedToday = 1 THEN 1 ELSE 0 END), 0) AS CompletedToday
            FROM (
                SELECT
                    wo.WorkOrderID,
                    CASE WHEN wo.EndDate IS NOT NULL THEN 1 ELSE 0 END AS IsComplete,
                    CASE WHEN CAST(wo.EndDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END AS CompletedToday,
                    ISNULL(MAX(CASE WHEN wor.ActualStartDate IS NOT NULL THEN 1 ELSE 0 END), 0) AS HasStarted
                FROM Production.WorkOrder wo
                LEFT JOIN Production.WorkOrderRouting wor ON wor.WorkOrderID = wo.WorkOrderID
                GROUP BY wo.WorkOrderID, wo.EndDate
            ) sub");
        return ((int)row.Pending, (int)row.InProgress, (int)row.CompletedToday);
    }

    public async Task<List<ActiveOperationData>> GetActiveOperationsAsync()
    {
        using var conn = await GetConnectionAsync();
        var rows = await conn.QueryAsync(@"
            SELECT wor.WorkOrderID, wor.ProductID,
                   p.Name AS ProductName,
                   wor.OperationSequence, wor.LocationID,
                   l.Name AS LocationName,
                   wor.ActualStartDate,
                   DATEDIFF(SECOND, wor.ActualStartDate, GETDATE()) / 60.0 AS ElapsedMinutes
            FROM Production.WorkOrderRouting wor
            INNER JOIN Production.Product p ON wor.ProductID = p.ProductID
            INNER JOIN Production.Location l ON wor.LocationID = l.LocationID
            WHERE wor.ActualStartDate IS NOT NULL AND wor.ActualEndDate IS NULL
            ORDER BY wor.ActualStartDate");
        return rows.Select(r => new ActiveOperationData(
            (int)r.WorkOrderID, (int)r.ProductID, (string)r.ProductName,
            (int)r.OperationSequence, (int)r.LocationID, (string)r.LocationName,
            (DateTime)r.ActualStartDate, (double)r.ElapsedMinutes)).ToList();
    }
}
