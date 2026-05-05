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
    int TotalReviews);

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

    /// <summary>
    /// Total revenue grouped by top-level product category (Bikes, Components, Clothing, Accessories).
    /// </summary>
    public async Task<IEnumerable<CategoryRevenue>> GetRevenueByCategoryAsync()
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<CategoryRevenue>(@"
            SELECT
                pc.Name AS CategoryName,
                CAST(SUM(od.LineTotal) AS decimal(18,2)) AS Revenue
            FROM Sales.SalesOrderDetail od
            INNER JOIN Production.Product p ON od.ProductID = p.ProductID
            INNER JOIN Production.ProductSubcategory sc ON p.ProductSubcategoryID = sc.ProductSubcategoryID
            INNER JOIN Production.ProductCategory pc ON sc.ProductCategoryID = pc.ProductCategoryID
                AND RTRIM(pc.CultureID) = 'en'
            GROUP BY pc.ProductCategoryID, pc.Name
            ORDER BY Revenue DESC");
    }

    /// <summary>
    /// Monthly revenue and order count for the last 12 months, ordered chronologically.
    /// </summary>
    public async Task<IEnumerable<MonthlyRevenue>> GetMonthlyRevenueTrendAsync()
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
            GROUP BY YEAR(OrderDate), MONTH(OrderDate)
            ORDER BY Year, Month");
    }

    /// <summary>
    /// Top N products by total revenue across all orders.
    /// </summary>
    public async Task<IEnumerable<TopProduct>> GetTopProductsByRevenueAsync(int limit = 10)
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<TopProduct>(@"
            SELECT TOP (@Limit)
                p.Name AS ProductName,
                CAST(SUM(od.LineTotal) AS decimal(18,2)) AS Revenue,
                SUM(od.OrderQty) AS UnitsSold
            FROM Sales.SalesOrderDetail od
            INNER JOIN Production.Product p ON od.ProductID = p.ProductID
            GROUP BY p.ProductID, p.Name
            ORDER BY Revenue DESC",
            new { Limit = limit });
    }

    /// <summary>
    /// Order count per status code.
    /// Status: 1=In Process, 2=Approved, 3=Backordered, 4=Rejected, 5=Shipped, 6=Cancelled
    /// </summary>
    public async Task<IEnumerable<OrderStatusCount>> GetOrdersByStatusAsync()
    {
        using var connection = await GetConnectionAsync();
        return await connection.QueryAsync<OrderStatusCount>(@"
            SELECT
                CAST(Status AS int) AS Status,
                COUNT(SalesOrderID) AS OrderCount
            FROM Sales.SalesOrderHeader
            GROUP BY Status
            ORDER BY Status");
    }

    /// <summary>
    /// Total revenue and order count grouped by sales territory.
    /// </summary>
    public async Task<IEnumerable<TerritoryRevenue>> GetRevenueByTerritoryAsync()
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
            GROUP BY t.TerritoryID, t.Name, t.CountryRegionCode
            ORDER BY Revenue DESC");
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
                (SELECT COUNT(*) FROM Production.ProductReview) AS TotalReviews");
    }
}
