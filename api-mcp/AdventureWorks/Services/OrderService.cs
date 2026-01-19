using System.Data;
using System.Text;
using System.Globalization;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Localization;
using AdventureWorks.Resources;

namespace AdventureWorks.Services;

/// <summary>
/// Service for querying sales orders and order details from AdventureWorks database
/// </summary>
public class OrderService
{
    private readonly string _connectionString;
    private readonly IStringLocalizer<Strings> _localizer;

    public OrderService(string connectionString, IStringLocalizer<Strings> localizer)
    {
        _connectionString = connectionString;
        _localizer = localizer;
    }

    private async Task<IDbConnection> GetConnectionAsync()
    {
        // Connection string contains Authentication=Active Directory Default
        // which handles credential acquisition automatically
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>
    /// Get order status for a specific customer by CustomerID
    /// </summary>
    public async Task<string> GetCustomerOrderStatusAsync(int customerId, string cultureId = "en")
    {
        CultureInfo.CurrentUICulture = new CultureInfo(cultureId);

        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT TOP 10
                soh.SalesOrderID,
                soh.OrderDate,
                soh.Status,
                soh.TotalDue,
                soh.ShipDate,
                sm.Name AS ShipMethod,
                CASE 
                    WHEN soh.Status = 1 THEN 'In Process'
                    WHEN soh.Status = 2 THEN 'Approved'
                    WHEN soh.Status = 3 THEN 'Backordered'
                    WHEN soh.Status = 4 THEN 'Rejected'
                    WHEN soh.Status = 5 THEN 'Shipped'
                    WHEN soh.Status = 6 THEN 'Cancelled'
                    ELSE 'Unknown'
                END AS StatusText,
                c.FirstName,
                c.LastName,
                (SELECT TOP 1 EmailAddress FROM Person.EmailAddress WHERE BusinessEntityID = c.BusinessEntityID) AS EmailAddress
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.Customer cust ON soh.CustomerID = cust.CustomerID
            INNER JOIN Person.Person c ON cust.PersonID = c.BusinessEntityID
            LEFT JOIN Purchasing.ShipMethod sm ON soh.ShipMethodID = sm.ShipMethodID
            WHERE cust.CustomerID = @CustomerId
            ORDER BY soh.OrderDate DESC";

        var orders = await connection.QueryAsync(sql, new { CustomerId = customerId });

        if (!orders.Any())
        {
            return _localizer["NoOrdersFound", customerId].Value;
        }

        var result = new StringBuilder();
        result.AppendLine(_localizer["OrderHistory", customerId].Value);
        result.AppendLine(_localizer["RecentOrders", orders.Count()].Value);
        result.AppendLine();

        foreach (var order in orders)
        {
            result.AppendLine(_localizer["OrderNumber", order.SalesOrderID].Value);
            result.AppendLine($"  {_localizer["OrderDate", order.OrderDate].Value}");
            result.AppendLine($"  {_localizer["Status", order.StatusText].Value}");
            result.AppendLine($"  {_localizer["Total", order.TotalDue].Value}");
            if (order.ShipDate != null)
            {
                result.AppendLine($"  {_localizer["ShipDate", order.ShipDate].Value}");
            }
            result.AppendLine();
        }

        return result.ToString();
    }

    /// <summary>
    /// Get detailed information about a specific order
    /// Optionally validates that the order belongs to the specified customer ID
    /// </summary>
    public async Task<string> GetOrderDetailsAsync(int orderId, int? customerId = null, string cultureId = "en")
    {
        CultureInfo.CurrentUICulture = new CultureInfo(cultureId);

        using var connection = await GetConnectionAsync();

        // Get order header (with optional customer validation)
        var headerSql = @"
            SELECT 
                soh.SalesOrderID,
                soh.OrderDate,
                soh.Status,
                soh.SubTotal,
                soh.TaxAmt,
                soh.Freight,
                soh.TotalDue,
                soh.ShipDate,
                sm.Name AS ShipMethod,
                CASE 
                    WHEN soh.Status = 1 THEN 'In Process'
                    WHEN soh.Status = 2 THEN 'Approved'
                    WHEN soh.Status = 3 THEN 'Backordered'
                    WHEN soh.Status = 4 THEN 'Rejected'
                    WHEN soh.Status = 5 THEN 'Shipped'
                    WHEN soh.Status = 6 THEN 'Cancelled'
                    ELSE 'Unknown'
                END AS StatusText,
                c.FirstName + ' ' + c.LastName AS CustomerName,
                (SELECT TOP 1 EmailAddress FROM Person.EmailAddress WHERE BusinessEntityID = c.BusinessEntityID) AS EmailAddress
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.Customer cust ON soh.CustomerID = cust.CustomerID
            INNER JOIN Person.Person c ON cust.PersonID = c.BusinessEntityID
            LEFT JOIN Purchasing.ShipMethod sm ON soh.ShipMethodID = sm.ShipMethodID
            WHERE soh.SalesOrderID = @OrderId
                AND (@CustomerId IS NULL OR cust.CustomerID = @CustomerId)";

        var header = await connection.QuerySingleOrDefaultAsync(headerSql, new { OrderId = orderId, CustomerId = customerId });

        if (header == null)
        {
            if (customerId.HasValue)
            {
                return _localizer["OrderDoesNotBelongToCustomer", orderId, customerId.Value].Value;
            }
            return _localizer["OrderNotFound", orderId].Value;
        }

        // Get order details
        var detailsSql = @"
            SELECT 
                sod.SalesOrderDetailID,
                sod.OrderQty,
                sod.UnitPrice,
                sod.LineTotal,
                p.Name AS ProductName,
                p.ProductNumber
            FROM Sales.SalesOrderDetail sod
            INNER JOIN Production.Product p ON sod.ProductID = p.ProductID
            WHERE sod.SalesOrderID = @OrderId
            ORDER BY sod.SalesOrderDetailID";

        var details = await connection.QueryAsync(detailsSql, new { OrderId = orderId });

        var result = new StringBuilder();
        result.AppendLine(_localizer["OrderDetails", header.SalesOrderID].Value);
        result.AppendLine($"{_localizer["Status", header.StatusText].Value}");
        result.AppendLine($"{_localizer["OrderDate", header.OrderDate].Value}");
        if (header.ShipDate != null)
        {
            result.AppendLine($"{_localizer["ShipDate", header.ShipDate].Value}");
        }
        result.AppendLine();
        result.AppendLine(_localizer["OrderItems"].Value);

        foreach (var item in details)
        {
            result.AppendLine($"  {item.ProductName}");
            result.AppendLine($"    {_localizer["Qty", item.OrderQty].Value} - {_localizer["UnitPrice", item.UnitPrice].Value} - {_localizer["LineTotal", item.LineTotal].Value}");
        }

        result.AppendLine();
        result.AppendLine(_localizer["Subtotal", header.SubTotal].Value);
        result.AppendLine(_localizer["Tax", header.TaxAmt].Value);
        result.AppendLine(_localizer["Shipping", header.Freight].Value);
        result.AppendLine(_localizer["Total", header.TotalDue].Value);

        return result.ToString();
    }

    /// <summary>
    /// Find complementary products based on what other customers bought together
    /// </summary>
    public async Task<string> FindComplementaryProductsAsync(int productId, int limit = 5, string cultureId = "en")
    {
        CultureInfo.CurrentUICulture = new CultureInfo(cultureId);

        using var connection = await GetConnectionAsync();

        var sql = @"
            WITH ProductOrders AS (
                -- Get all orders that include the specified product
                SELECT DISTINCT sod.SalesOrderID
                FROM Sales.SalesOrderDetail sod
                WHERE sod.ProductID = @ProductId
            ),
            ComplementaryProducts AS (
                -- Find other products in those same orders
                SELECT 
                    p.ProductID,
                    p.Name AS ProductName,
                    p.ProductNumber,
                    p.ListPrice,
                    COUNT(DISTINCT sod.SalesOrderID) AS TimesOrderedTogether
                FROM Sales.SalesOrderDetail sod
                INNER JOIN Production.Product p ON sod.ProductID = p.ProductID
                INNER JOIN ProductOrders po ON sod.SalesOrderID = po.SalesOrderID
                WHERE sod.ProductID != @ProductId  -- Exclude the original product
                    AND p.FinishedGoodsFlag = 1     -- Only finished goods
                GROUP BY p.ProductID, p.Name, p.ProductNumber, p.ListPrice
            )
            SELECT TOP (@Limit)
                cp.ProductID,
                cp.ProductName,
                cp.ProductNumber,
                cp.ListPrice,
                cp.TimesOrderedTogether,
                CAST(ROUND((CAST(cp.TimesOrderedTogether AS FLOAT) / 
                    (SELECT COUNT(DISTINCT SalesOrderID) FROM ProductOrders)) * 100, 1) AS DECIMAL(5,1)) AS PercentageOfOrders
            FROM ComplementaryProducts cp
            ORDER BY cp.TimesOrderedTogether DESC";

        var products = await connection.QueryAsync(sql, new { ProductId = productId, Limit = limit });

        if (!products.Any())
        {
            return _localizer["NoComplementaryProducts", productId].Value;
        }

        // Get the original product name
        var originalProductSql = "SELECT Name FROM Production.Product WHERE ProductID = @ProductId";
        var originalProduct = await connection.QuerySingleOrDefaultAsync<string>(originalProductSql, new { ProductId = productId });

        var result = new StringBuilder();
        result.AppendLine(_localizer["ComplementaryProducts"].Value);
        result.AppendLine();

        foreach (var product in products)
        {
            result.AppendLine($"  {product.ProductName}");
            result.AppendLine($"    {_localizer["Price", product.ListPrice].Value}");
            result.AppendLine($"    {_localizer["PurchasedTogether", product.TimesOrderedTogether].Value}");
            result.AppendLine();
        }

        return result.ToString();
    }

    public async Task<string> GetPersonalizedRecommendationsAsync(int customerId, int limit = 5, string cultureId = "en")
    {
        CultureInfo.CurrentUICulture = new CultureInfo(cultureId);

        using var connection = await GetConnectionAsync();

        // Find product categories the customer has purchased from
        var purchasedCategories = await connection.QueryAsync<dynamic>(@"
            SELECT DISTINCT TOP 5 pc.ProductCategoryID, pc.Name as CategoryName, COUNT(*) as PurchaseCount
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.SalesOrderDetail sod ON soh.SalesOrderID = sod.SalesOrderID
            INNER JOIN Production.Product p ON sod.ProductID = p.ProductID
            LEFT JOIN Production.ProductSubcategory psc ON p.ProductSubcategoryID = psc.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON psc.ProductCategoryID = pc.ProductCategoryID
            WHERE soh.CustomerID = @CustomerId
            AND pc.ProductCategoryID IS NOT NULL
            GROUP BY pc.ProductCategoryID, pc.Name
            ORDER BY COUNT(*) DESC",
            new { CustomerId = customerId });

        if (!purchasedCategories.Any())
        {
            return _localizer["NoRecommendations", customerId].Value;
        }

        // Get products from same categories that customer hasn't purchased yet
        var recommendations = await connection.QueryAsync<dynamic>($@"
            SELECT TOP {limit} p.ProductID, p.Name, p.ListPrice, pc.Name as CategoryName,
                   COALESCE(p.Color, 'N/A') as Color
            FROM Production.Product p
            LEFT JOIN Production.ProductSubcategory psc ON p.ProductSubcategoryID = psc.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON psc.ProductCategoryID = pc.ProductCategoryID
            WHERE pc.ProductCategoryID IN @CategoryIds
            AND p.ProductID NOT IN (
                SELECT DISTINCT sod.ProductID
                FROM Sales.SalesOrderHeader soh
                INNER JOIN Sales.SalesOrderDetail sod ON soh.SalesOrderID = sod.SalesOrderID
                WHERE soh.CustomerID = @CustomerId
            )
            AND p.SellEndDate IS NULL
            AND p.ListPrice > 0
            ORDER BY NEWID()",
            new
            {
                CategoryIds = purchasedCategories.Select(c => (int)c.ProductCategoryID).ToList(),
                CustomerId = customerId
            });

        var result = new StringBuilder();
        result.AppendLine(_localizer["PersonalizedRecommendations", customerId].Value);
        result.AppendLine();
        result.AppendLine(_localizer["BasedOnPurchaseHistory"].Value);
        foreach (var category in purchasedCategories)
        {
            result.AppendLine($"  • {category.CategoryName}");
        }
        result.AppendLine();

        if (!recommendations.Any())
        {
            result.AppendLine(_localizer["NoRecommendations", customerId].Value);
        }
        else
        {
            foreach (var product in recommendations)
            {
                result.AppendLine($"  {product.Name}");
                result.AppendLine($"    {_localizer["Category", product.CategoryName].Value} - {_localizer["Price", product.ListPrice].Value}");
            }
        }

        return result.ToString();
    }
}
