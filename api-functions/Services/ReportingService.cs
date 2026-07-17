using Dapper;
using Microsoft.Data.SqlClient;
using System.Data;

namespace api_functions.Services;

// ─── Return types ─────────────────────────────────────────────────────────────

public record CategoryRevenue(string CategoryName, decimal Revenue);

public record MonthlyRevenue(int Year, int Month, decimal Revenue, int OrderCount);

public record TopProduct(string ProductName, decimal Revenue, int UnitsSold);

public record OrderStatusCount(int Status, int OrderCount);

public record TerritoryRevenue(string TerritoryName, string CountryRegionCode, decimal Revenue, int OrderCount);

public record CategoryInventory(string CategoryName, int TotalQuantity, int ProductCount);

public record DashboardCounts(
    int TotalProducts,
    int TotalCustomers,
    int TotalOrders,
    int PendingOrders,
    int ReviewsToModerate);

public record ProductProfit(
    string ProductName,
    decimal Revenue,
    decimal TotalCost,
    decimal Profit,
    decimal MarginPct,
    int UnitsSold);

public record CategoryProfit(
    string CategoryName,
    decimal Revenue,
    decimal TotalCost,
    decimal Profit,
    decimal MarginPct);

public record DiscountTypeRevenue(
    string OfferType,
    decimal TotalRevenue,
    decimal TotalDiscount,
    int OrderCount);

public record SlowMover(
    int ProductID,
    string ProductName,
    string? CategoryName,
    decimal CurrentListPrice,
    decimal CurrentCost,
    int CurrentStock,
    decimal StockValue,
    int UnitsSoldLast12Months,
    int? DaysSinceLastSale,
    decimal MarginPct,
    int ActiveDiscounts);

public record ProductProfitDetail(
    int ProductID,
    string ProductName,
    string CategoryName,
    decimal CurrentListPrice,
    decimal CurrentCost,
    decimal Revenue,
    decimal TotalCost,
    decimal Profit,
    decimal MarginPct,
    int UnitsSold,
    int CurrentStock,
    int CurrentOrders,
    int ActiveDiscounts);

public record SalesTrendMonth(int Year, int Month, int UnitsSold, decimal Revenue);

public record ProductPriceHistory(DateTime StartDate, DateTime? EndDate, decimal ListPrice);

public record ProductCostHistory(DateTime StartDate, DateTime? EndDate, decimal StandardCost);

// ─── Service ──────────────────────────────────────────────────────────────────

/// <summary>
/// Pre-aggregated SQL reporting queries for the admin dashboard.
/// Bypasses the DAB 100-item pagination limit by querying the full dataset directly.
/// Uses Authentication=Active Directory Default — no passwords required.
/// </summary>
public class ReportingService
{
    private readonly string _connectionString;

    public ReportingService(string connectionString)
    {
        _connectionString = connectionString;
    }

    private async Task<IDbConnection> GetConnectionAsync()
    {
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    // ─── Channel helper ──────────────────────────────────────────────────────
    // onlineOrderFlag: null = all channels, true = eShop (online), false = B2B (store)
    private static int? ToChannelInt(bool? onlineOrderFlag)
        => onlineOrderFlag.HasValue ? (int?)(onlineOrderFlag.Value ? 1 : 0) : null;

    /// <summary>
    /// Total revenue grouped by top-level product category (Bikes, Components, Clothing, Accessories).
    /// </summary>
    public async Task<IEnumerable<CategoryRevenue>> GetRevenueByCategoryAsync(bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<CategoryRevenue>(@"
            SELECT
                pc.Name AS CategoryName,
                CAST(SUM(od.LineTotal) AS decimal(18,2)) AS Revenue
            FROM Sales.SalesOrderDetail od
            INNER JOIN Sales.SalesOrderHeader soh ON od.SalesOrderID = soh.SalesOrderID
            INNER JOIN Production.Product p ON od.ProductID = p.ProductID
            INNER JOIN Production.ProductSubcategory sc ON p.ProductSubcategoryID = sc.ProductSubcategoryID
            INNER JOIN Production.ProductCategory pc ON sc.ProductCategoryID = pc.ProductCategoryID
                AND RTRIM(pc.CultureID) = 'en'
            WHERE (@ChannelFlag IS NULL OR soh.OnlineOrderFlag = @ChannelFlag)
            GROUP BY pc.ProductCategoryID, pc.Name
            ORDER BY Revenue DESC", new { ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    /// <summary>
    /// Monthly revenue and order count for the last 12 months, ordered chronologically.
    /// </summary>
    public async Task<IEnumerable<MonthlyRevenue>> GetMonthlyRevenueTrendAsync(bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<MonthlyRevenue>(@"
            SELECT
                YEAR(OrderDate) AS Year,
                MONTH(OrderDate) AS Month,
                CAST(SUM(TotalDue) AS decimal(18,2)) AS Revenue,
                COUNT(SalesOrderID) AS OrderCount
            FROM Sales.SalesOrderHeader
            WHERE OrderDate >= DATEADD(MONTH, -12, GETDATE())
              AND (@ChannelFlag IS NULL OR OnlineOrderFlag = @ChannelFlag)
            GROUP BY YEAR(OrderDate), MONTH(OrderDate)
            ORDER BY Year, Month", new { ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    /// <summary>
    /// Top N products by total revenue across all orders.
    /// </summary>
    public async Task<IEnumerable<TopProduct>> GetTopProductsByRevenueAsync(int limit = 10, bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<TopProduct>(@"
            SELECT TOP (@Limit)
                p.Name AS ProductName,
                CAST(SUM(od.LineTotal) AS decimal(18,2)) AS Revenue,
                SUM(od.OrderQty) AS UnitsSold
            FROM Sales.SalesOrderDetail od
            INNER JOIN Sales.SalesOrderHeader soh ON od.SalesOrderID = soh.SalesOrderID
            INNER JOIN Production.Product p ON od.ProductID = p.ProductID
            WHERE (@ChannelFlag IS NULL OR soh.OnlineOrderFlag = @ChannelFlag)
            GROUP BY p.ProductID, p.Name
            ORDER BY Revenue DESC",
            new { Limit = limit, ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    /// <summary>
    /// Order count per status code.
    /// Status: 1=In Process, 2=Approved, 3=Backordered, 4=Rejected, 5=Shipped, 6=Cancelled
    /// </summary>
    public async Task<IEnumerable<OrderStatusCount>> GetOrdersByStatusAsync(bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<OrderStatusCount>(@"
            SELECT
                CAST(Status AS int) AS Status,
                COUNT(SalesOrderID) AS OrderCount
            FROM Sales.SalesOrderHeader
            WHERE (@ChannelFlag IS NULL OR OnlineOrderFlag = @ChannelFlag)
            GROUP BY Status
            ORDER BY Status", new { ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    /// <summary>
    /// Total revenue and order count grouped by sales territory.
    /// </summary>
    public async Task<IEnumerable<TerritoryRevenue>> GetRevenueByTerritoryAsync(bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<TerritoryRevenue>(@"
            SELECT
                t.Name AS TerritoryName,
                t.CountryRegionCode,
                CAST(SUM(soh.TotalDue) AS decimal(18,2)) AS Revenue,
                COUNT(soh.SalesOrderID) AS OrderCount
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.SalesTerritory t ON soh.TerritoryID = t.TerritoryID
            WHERE (@ChannelFlag IS NULL OR soh.OnlineOrderFlag = @ChannelFlag)
            GROUP BY t.TerritoryID, t.Name, t.CountryRegionCode
            ORDER BY Revenue DESC", new { ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    /// <summary>
    /// Current inventory quantity and distinct product count per top-level category.
    /// </summary>
    public async Task<IEnumerable<CategoryInventory>> GetInventoryByCategoryAsync()
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<CategoryInventory>(@"
            SELECT
                pc.Name AS CategoryName,
                SUM(pi.Quantity) AS TotalQuantity,
                COUNT(DISTINCT p.ProductID) AS ProductCount
            FROM Production.ProductInventory pi
            INNER JOIN Production.Product p ON pi.ProductID = p.ProductID
            INNER JOIN Production.ProductSubcategory sc ON p.ProductSubcategoryID = sc.ProductSubcategoryID
            INNER JOIN Production.ProductCategory pc ON sc.ProductCategoryID = pc.ProductCategoryID
                AND RTRIM(pc.CultureID) = 'en'
            GROUP BY pc.ProductCategoryID, pc.Name
            ORDER BY TotalQuantity DESC");
    }

    /// <summary>
    /// Returns exact row-counts for the home page KPI cards.
    /// A single SQL round-trip; no DAB pagination limit applies.
    /// </summary>
    public async Task<DashboardCounts> GetDashboardCountsAsync()
    {
        using var connection = await GetConnectionAsync();
        return await connection.QuerySingleAsync<DashboardCounts>(@"
            SELECT
                (SELECT COUNT(*) FROM Production.Product
                 WHERE FinishedGoodsFlag = 1)           AS TotalProducts,
                (SELECT COUNT(*) FROM Sales.Customer)   AS TotalCustomers,
                (SELECT COUNT(*) FROM Sales.SalesOrderHeader) AS TotalOrders,
                (SELECT COUNT(*) FROM Sales.SalesOrderHeader
                 WHERE Status IN (1, 2))                AS PendingOrders,
                (SELECT COUNT(*) FROM Production.ProductReview
                 WHERE IsModerated = 0)                 AS ReviewsToModerate");
    }

    /// <summary>
    /// Top N finished goods by total profit (revenue minus standard cost).
    /// Excludes Rejected (4) and Cancelled (6) orders.
    /// </summary>
    public async Task<IEnumerable<ProductProfit>> GetProductProfitabilityAsync(int limit = 20, bool sortAscending = false, bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        var orderDir = sortAscending ? "ASC" : "DESC";
        var sql = $@"
            SELECT TOP (@Limit)
                p.Name AS ProductName,
                CAST(SUM(od.LineTotal) AS decimal(18,2)) AS Revenue,
                CAST(SUM(p.StandardCost * od.OrderQty) AS decimal(18,2)) AS TotalCost,
                CAST(SUM(od.LineTotal - p.StandardCost * od.OrderQty) AS decimal(18,2)) AS Profit,
                CAST(
                    CASE WHEN SUM(od.LineTotal) > 0
                         THEN (SUM(od.LineTotal) - SUM(p.StandardCost * od.OrderQty)) / SUM(od.LineTotal)
                         ELSE 0 END
                AS decimal(8,4)) AS MarginPct,
                SUM(od.OrderQty) AS UnitsSold
            FROM Sales.SalesOrderDetail od
            INNER JOIN Sales.SalesOrderHeader soh ON od.SalesOrderID = soh.SalesOrderID
            INNER JOIN Production.Product p ON od.ProductID = p.ProductID
            WHERE soh.Status NOT IN (4, 6)
              AND p.FinishedGoodsFlag = 1
              AND (@ChannelFlag IS NULL OR soh.OnlineOrderFlag = @ChannelFlag)
            GROUP BY p.ProductID, p.Name
            ORDER BY Profit {orderDir}";
        return await connection.QueryAsync<ProductProfit>(sql, new { Limit = limit, ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    /// <summary>
    /// All finished goods with profit, margin, current stock, active orders, and active promotions.
    /// Used by the Product Profitability detail page. Includes products never sold (zero aggregates).
    /// </summary>
    public async Task<IEnumerable<ProductProfitDetail>> GetProductProfitabilityDetailAsync(bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<ProductProfitDetail>(@"
            SELECT
                p.ProductID,
                p.Name                                                          AS ProductName,
                ISNULL(pc.Name, 'Uncategorised')                                AS CategoryName,
                CAST(p.ListPrice   AS decimal(18,2))                            AS CurrentListPrice,
                CAST(p.StandardCost AS decimal(18,2))                           AS CurrentCost,
                ISNULL(CAST(SUM(od.LineTotal)                          AS decimal(18,2)), 0) AS Revenue,
                ISNULL(CAST(SUM(p.StandardCost * od.OrderQty)          AS decimal(18,2)), 0) AS TotalCost,
                ISNULL(CAST(SUM(od.LineTotal - p.StandardCost * od.OrderQty) AS decimal(18,2)), 0) AS Profit,
                CAST(
                    CASE WHEN ISNULL(SUM(od.LineTotal), 0) > 0
                         THEN (ISNULL(SUM(od.LineTotal), 0) - ISNULL(SUM(p.StandardCost * od.OrderQty), 0))
                              / SUM(od.LineTotal)
                         ELSE 0 END
                AS decimal(8,4))                                                AS MarginPct,
                ISNULL(SUM(od.OrderQty), 0)                                     AS UnitsSold,
                ISNULL((
                    SELECT SUM(pi.Quantity)
                    FROM Production.ProductInventory pi
                    WHERE pi.ProductID = p.ProductID
                ), 0)                                                            AS CurrentStock,
                ISNULL((
                    SELECT COUNT(DISTINCT sod2.SalesOrderID)
                    FROM Sales.SalesOrderDetail sod2
                    INNER JOIN Sales.SalesOrderHeader soh2
                        ON sod2.SalesOrderID = soh2.SalesOrderID
                    WHERE sod2.ProductID = p.ProductID
                      AND soh2.Status IN (1, 2, 3)
                ), 0)                                                            AS CurrentOrders,
                ISNULL((
                    SELECT COUNT(*)
                    FROM Sales.SpecialOfferProduct sop
                    INNER JOIN Sales.SpecialOffer so
                        ON sop.SpecialOfferID = so.SpecialOfferID
                    WHERE sop.ProductID = p.ProductID
                      AND so.SpecialOfferID <> 1
                      AND so.EndDate >= GETDATE()
                ), 0)                                                            AS ActiveDiscounts
            FROM Production.Product p
            LEFT JOIN Sales.SalesOrderDetail od
                ON p.ProductID = od.ProductID
            LEFT JOIN Sales.SalesOrderHeader soh
                ON od.SalesOrderID = soh.SalesOrderID
               AND soh.Status NOT IN (4, 6)
               AND (@ChannelFlag IS NULL OR soh.OnlineOrderFlag = @ChannelFlag)
            LEFT JOIN Production.ProductSubcategory sc
                ON p.ProductSubcategoryID = sc.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc
                ON sc.ProductCategoryID = pc.ProductCategoryID
               AND RTRIM(pc.CultureID) = 'en'
            WHERE p.FinishedGoodsFlag = 1
            GROUP BY p.ProductID, p.Name, p.ListPrice, p.StandardCost, pc.Name
            ORDER BY Profit DESC", new { ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    /// <summary>
    /// Revenue, cost, profit and gross margin % aggregated by top-level product category.
    /// Excludes Rejected (4) and Cancelled (6) orders.
    /// </summary>
    public async Task<IEnumerable<CategoryProfit>> GetProfitabilityByCategoryAsync(bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<CategoryProfit>(@"
            SELECT
                pc.Name AS CategoryName,
                CAST(SUM(od.LineTotal) AS decimal(18,2)) AS Revenue,
                CAST(SUM(p.StandardCost * od.OrderQty) AS decimal(18,2)) AS TotalCost,
                CAST(SUM(od.LineTotal - p.StandardCost * od.OrderQty) AS decimal(18,2)) AS Profit,
                CAST(
                    CASE WHEN SUM(od.LineTotal) > 0
                         THEN (SUM(od.LineTotal) - SUM(p.StandardCost * od.OrderQty)) / SUM(od.LineTotal)
                         ELSE 0 END
                AS decimal(8,4)) AS MarginPct
            FROM Sales.SalesOrderDetail od
            INNER JOIN Sales.SalesOrderHeader soh ON od.SalesOrderID = soh.SalesOrderID
            INNER JOIN Production.Product p ON od.ProductID = p.ProductID
            INNER JOIN Production.ProductSubcategory sc ON p.ProductSubcategoryID = sc.ProductSubcategoryID
            INNER JOIN Production.ProductCategory pc ON sc.ProductCategoryID = pc.ProductCategoryID
                AND RTRIM(pc.CultureID) = 'en'
            WHERE soh.Status NOT IN (4, 6)
              AND p.FinishedGoodsFlag = 1
              AND (@ChannelFlag IS NULL OR soh.OnlineOrderFlag = @ChannelFlag)
            GROUP BY pc.ProductCategoryID, pc.Name
            ORDER BY Profit DESC", new { ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    /// <summary>
    /// Actual revenue received vs. discount amount forfeited, grouped by special offer type.
    /// SpecialOfferID = 1 represents full-price (No Discount) sales.
    /// Excludes Rejected (4) and Cancelled (6) orders.
    /// </summary>
    public async Task<IEnumerable<DiscountTypeRevenue>> GetDiscountImpactAsync(bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<DiscountTypeRevenue>(@"
            SELECT
                so.Type AS OfferType,
                CAST(SUM(od.LineTotal) AS decimal(18,2)) AS TotalRevenue,
                CAST(SUM(od.UnitPrice * od.UnitPriceDiscount * od.OrderQty) AS decimal(18,2)) AS TotalDiscount,
                COUNT(DISTINCT od.SalesOrderID) AS OrderCount
            FROM Sales.SalesOrderDetail od
            INNER JOIN Sales.SalesOrderHeader soh ON od.SalesOrderID = soh.SalesOrderID
            INNER JOIN Sales.SpecialOffer so ON od.SpecialOfferID = so.SpecialOfferID
                AND RTRIM(so.CultureID) = 'en'
            WHERE soh.Status NOT IN (4, 6)
              AND (@ChannelFlag IS NULL OR soh.OnlineOrderFlag = @ChannelFlag)
            GROUP BY so.Type
            ORDER BY TotalRevenue DESC", new { ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    /// <summary>
    /// Identifies slow-moving products: finished goods with stock on hand that have sold
    /// fewer than the given threshold units in the trailing 12 months.
    /// Returns records sorted by DaysSinceLastSale descending (longest idle first).
    /// </summary>
    public async Task<IEnumerable<SlowMover>> GetSlowMoversAsync(int unitThreshold = 10, bool? onlineOrderFlag = null)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<SlowMover>(@"
            WITH RecentSales AS (
                SELECT
                    sod.ProductID,
                    SUM(sod.OrderQty) AS UnitsSoldLast12Months,
                    MAX(soh.OrderDate)  AS LastSaleDate
                FROM Sales.SalesOrderDetail sod
                INNER JOIN Sales.SalesOrderHeader soh
                    ON sod.SalesOrderID = soh.SalesOrderID
                WHERE soh.OrderDate >= DATEADD(MONTH, -12, GETDATE())
                  AND soh.Status NOT IN (4, 6)
                  AND (@ChannelFlag IS NULL OR soh.OnlineOrderFlag = @ChannelFlag)
                GROUP BY sod.ProductID
            ),
            AllSales AS (
                SELECT sod2.ProductID, MAX(soh2.OrderDate) AS EverLastSaleDate
                FROM Sales.SalesOrderDetail sod2
                INNER JOIN Sales.SalesOrderHeader soh2
                    ON sod2.SalesOrderID = soh2.SalesOrderID
                WHERE soh2.Status NOT IN (4, 6)
                  AND (@ChannelFlag IS NULL OR soh2.OnlineOrderFlag = @ChannelFlag)
                GROUP BY sod2.ProductID
            )
            SELECT
                p.ProductID,
                p.Name                                                          AS ProductName,
                pc.Name                                                         AS CategoryName,
                CAST(p.ListPrice  AS decimal(18,2))                            AS CurrentListPrice,
                CAST(p.StandardCost AS decimal(18,2))                          AS CurrentCost,
                ISNULL((
                    SELECT SUM(pi2.Quantity)
                    FROM Production.ProductInventory pi2
                    WHERE pi2.ProductID = p.ProductID
                ), 0)                                                           AS CurrentStock,
                CAST(ISNULL((
                    SELECT SUM(pi3.Quantity)
                    FROM Production.ProductInventory pi3
                    WHERE pi3.ProductID = p.ProductID
                ), 0) * p.StandardCost AS decimal(18,2))                       AS StockValue,
                ISNULL(rs.UnitsSoldLast12Months, 0)                           AS UnitsSoldLast12Months,
                CASE WHEN als.EverLastSaleDate IS NULL THEN NULL
                     ELSE DATEDIFF(DAY, als.EverLastSaleDate, GETDATE()) END  AS DaysSinceLastSale,
                CAST(
                    CASE WHEN p.ListPrice > 0
                         THEN (p.ListPrice - p.StandardCost) / p.ListPrice
                         ELSE 0 END
                AS decimal(8,4))                                               AS MarginPct,
                ISNULL((
                    SELECT COUNT(*)
                    FROM Sales.SpecialOfferProduct sop
                    INNER JOIN Sales.SpecialOffer so2
                        ON sop.SpecialOfferID = so2.SpecialOfferID
                    WHERE sop.ProductID = p.ProductID
                      AND so2.SpecialOfferID <> 1
                      AND so2.EndDate >= GETDATE()
                ), 0)                                                          AS ActiveDiscounts
            FROM Production.Product p
            LEFT JOIN RecentSales rs        ON p.ProductID = rs.ProductID
            LEFT JOIN AllSales als           ON p.ProductID = als.ProductID
            LEFT JOIN Production.ProductSubcategory sc
                ON p.ProductSubcategoryID = sc.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc
                ON sc.ProductCategoryID = pc.ProductCategoryID
               AND RTRIM(pc.CultureID) = 'en'
            WHERE p.FinishedGoodsFlag = 1
              AND p.DiscontinuedDate IS NULL
              AND ISNULL((
                    SELECT SUM(pi4.Quantity)
                    FROM Production.ProductInventory pi4
                    WHERE pi4.ProductID = p.ProductID
                  ), 0) > 0
              AND ISNULL(rs.UnitsSoldLast12Months, 0) < @UnitThreshold
            ORDER BY DaysSinceLastSale DESC, CurrentStock DESC", new { UnitThreshold = unitThreshold, ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    public async Task<IEnumerable<SalesTrendMonth>> GetSalesTrendsAsync(int productId, bool? onlineOrderFlag = null)
    {
        using var conn = new SqlConnection(_connectionString);
        return await conn.QueryAsync<SalesTrendMonth>(@"
            SELECT
                YEAR(soh.OrderDate)  AS Year,
                MONTH(soh.OrderDate) AS Month,
                SUM(sod.OrderQty)    AS UnitsSold,
                SUM(sod.LineTotal)   AS Revenue
            FROM Sales.SalesOrderDetail sod
            INNER JOIN Sales.SalesOrderHeader soh ON sod.SalesOrderID = soh.SalesOrderID
            WHERE sod.ProductID = @ProductId
              AND soh.OrderDate >= DATEADD(MONTH, -12, GETDATE())
              AND (@ChannelFlag IS NULL OR soh.OnlineOrderFlag = @ChannelFlag)
            GROUP BY YEAR(soh.OrderDate), MONTH(soh.OrderDate)
            ORDER BY Year, Month", new { ProductId = productId, ChannelFlag = ToChannelInt(onlineOrderFlag) });
    }

    public async Task<IEnumerable<ProductPriceHistory>> GetProductPriceHistoryAsync(int productId)
    {
        using var conn = new SqlConnection(_connectionString);
        return await conn.QueryAsync<ProductPriceHistory>(@"
            SELECT
                StartDate,
                EndDate,
                ListPrice
            FROM Production.ProductListPriceHistory
            WHERE ProductID = @ProductId
            ORDER BY StartDate", new { ProductId = productId });
    }

    public async Task<IEnumerable<ProductCostHistory>> GetProductCostHistoryAsync(int productId)
    {
        using var conn = new SqlConnection(_connectionString);
        return await conn.QueryAsync<ProductCostHistory>(@"
            SELECT
                StartDate,
                EndDate,
                StandardCost
            FROM Production.ProductCostHistory
            WHERE ProductID = @ProductId
            ORDER BY StartDate", new { ProductId = productId });
    }
}
