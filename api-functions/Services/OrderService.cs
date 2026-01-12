using System.Data;
using System.Text;
using Azure.Core;
using Azure.Identity;
using Dapper;
using Microsoft.Data.SqlClient;

namespace api_functions.Services;

/// <summary>
/// Service for querying sales orders and order details from AdventureWorks database
/// </summary>
public class OrderService
{
    private readonly string _connectionString;

    public OrderService(string connectionString)
    {
        _connectionString = connectionString;
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
    public async Task<string> GetCustomerOrderStatusAsync(int customerId)
    {
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
                ea.EmailAddress
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.Customer cust ON soh.CustomerID = cust.CustomerID
            INNER JOIN Person.Person c ON cust.PersonID = c.BusinessEntityID
            LEFT JOIN Person.EmailAddress ea ON c.BusinessEntityID = ea.BusinessEntityID
            LEFT JOIN Purchasing.ShipMethod sm ON soh.ShipMethodID = sm.ShipMethodID
            WHERE cust.CustomerID = @CustomerId
            ORDER BY soh.OrderDate DESC";

        var orders = await connection.QueryAsync(sql, new { CustomerId = customerId });

        if (!orders.Any())
        {
            return $"No orders found for customer ID: {customerId}";
        }

        var result = new StringBuilder();
        result.AppendLine($"Orders for Customer ID: {customerId}");
        result.AppendLine();

        foreach (var order in orders)
        {
            result.AppendLine($"Order #{order.SalesOrderID}");
            result.AppendLine($"  Order Date: {order.OrderDate:yyyy-MM-dd}");
            result.AppendLine($"  Status: {order.StatusText}");
            result.AppendLine($"  Total: ${order.TotalDue:N2}");
            if (order.ShipDate != null)
            {
                result.AppendLine($"  Ship Date: {order.ShipDate:yyyy-MM-dd}");
                result.AppendLine($"  Ship Method: {order.ShipMethod}");
            }
            else
            {
                result.AppendLine($"  Not yet shipped");
            }
            result.AppendLine();
        }

        return result.ToString();
    }

    /// <summary>
    /// Get detailed information about a specific order
    /// Optionally validates that the order belongs to the specified customer ID
    /// </summary>
    public async Task<string> GetOrderDetailsAsync(int orderId, int? customerId = null)
    {
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
                ea.EmailAddress
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.Customer cust ON soh.CustomerID = cust.CustomerID
            INNER JOIN Person.Person c ON cust.PersonID = c.BusinessEntityID
            LEFT JOIN Person.EmailAddress ea ON c.BusinessEntityID = ea.BusinessEntityID
            LEFT JOIN Purchasing.ShipMethod sm ON soh.ShipMethodID = sm.ShipMethodID
            WHERE soh.SalesOrderID = @OrderId
                AND (@CustomerId IS NULL OR cust.CustomerID = @CustomerId)";

        var header = await connection.QuerySingleOrDefaultAsync(headerSql, new { OrderId = orderId, CustomerId = customerId });

        if (header == null)
        {
            return $"Order #{orderId} not found.";
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
        result.AppendLine($"Order #{header.SalesOrderID} - {header.StatusText}");
        result.AppendLine($"Customer: {header.CustomerName} ({header.EmailAddress})");
        result.AppendLine($"Order Date: {header.OrderDate:yyyy-MM-dd}");
        if (header.ShipDate != null)
        {
            result.AppendLine($"Ship Date: {header.ShipDate:yyyy-MM-dd}");
            result.AppendLine($"Ship Method: {header.ShipMethod}");
        }
        result.AppendLine();
        result.AppendLine("Order Items:");

        foreach (var item in details)
        {
            result.AppendLine($"  - {item.ProductName} ({item.ProductNumber})");
            result.AppendLine($"    Quantity: {item.OrderQty}, Unit Price: ${item.UnitPrice:N2}, Total: ${item.LineTotal:N2}");
        }

        result.AppendLine();
        result.AppendLine($"Subtotal: ${header.SubTotal:N2}");
        result.AppendLine($"Tax: ${header.TaxAmt:N2}");
        result.AppendLine($"Freight: ${header.Freight:N2}");
        result.AppendLine($"Total: ${header.TotalDue:N2}");

        return result.ToString();
    }

    /// <summary>
    /// Find complementary products based on what other customers bought together
    /// </summary>
    public async Task<string> FindComplementaryProductsAsync(int productId, int limit = 5)
    {
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
            return $"No complementary products found for product ID {productId}. This product may not have sufficient order history.";
        }

        // Get the original product name
        var originalProductSql = "SELECT Name FROM Production.Product WHERE ProductID = @ProductId";
        var originalProduct = await connection.QuerySingleOrDefaultAsync<string>(originalProductSql, new { ProductId = productId });

        var result = new StringBuilder();
        result.AppendLine($"Customers who bought '{originalProduct}' also frequently purchased:");
        result.AppendLine();

        foreach (var product in products)
        {
            result.AppendLine($"  {product.ProductName}");
            result.AppendLine($"    Product #: {product.ProductNumber}");
            result.AppendLine($"    Price: ${product.ListPrice:N2}");
            result.AppendLine($"    Ordered together {product.TimesOrderedTogether} times ({product.PercentageOfOrders}% of orders)");
            result.AppendLine();
        }

        return result.ToString();
    }

    /// <summary>
    /// Search for orders within a date range
    /// </summary>
    public async Task<string> SearchOrdersByDateAsync(DateTime startDate, DateTime endDate, int limit = 20)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT TOP (@Limit)
                soh.SalesOrderID,
                soh.OrderDate,
                soh.Status,
                soh.TotalDue,
                CASE 
                    WHEN soh.Status = 1 THEN 'In Process'
                    WHEN soh.Status = 2 THEN 'Approved'
                    WHEN soh.Status = 3 THEN 'Backordered'
                    WHEN soh.Status = 4 THEN 'Rejected'
                    WHEN soh.Status = 5 THEN 'Shipped'
                    WHEN soh.Status = 6 THEN 'Cancelled'
                    ELSE 'Unknown'
                END AS StatusText,
                c.FirstName + ' ' + c.LastName AS CustomerName
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.Customer cust ON soh.CustomerID = cust.CustomerID
            INNER JOIN Person.Person c ON cust.PersonID = c.BusinessEntityID
            WHERE soh.OrderDate BETWEEN @StartDate AND @EndDate
            ORDER BY soh.OrderDate DESC";

        var orders = await connection.QueryAsync(sql, new { StartDate = startDate, EndDate = endDate, Limit = limit });

        if (!orders.Any())
        {
            return $"No orders found between {startDate:yyyy-MM-dd} and {endDate:yyyy-MM-dd}.";
        }

        var result = new StringBuilder();
        result.AppendLine($"Orders from {startDate:yyyy-MM-dd} to {endDate:yyyy-MM-dd}:");
        result.AppendLine();

        foreach (var order in orders)
        {
            result.AppendLine($"Order #{order.SalesOrderID} - {order.CustomerName}");
            result.AppendLine($"  Date: {order.OrderDate:yyyy-MM-dd}, Status: {order.StatusText}, Total: ${order.TotalDue:N2}");
        }

        return result.ToString();
    }

    public async Task<string> GetPersonalizedRecommendationsAsync(int customerId, int limit = 5)
    {
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
            return "No purchase history found. Unable to generate personalized recommendations.";
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
        result.AppendLine($"🎯 Personalized Recommendations for Customer #{customerId}");
        result.AppendLine();
        result.AppendLine("Based on your purchase history in:");
        foreach (var category in purchasedCategories)
        {
            result.AppendLine($"  • {category.CategoryName} ({category.PurchaseCount} purchases)");
        }
        result.AppendLine();
        result.AppendLine("We recommend:");

        if (!recommendations.Any())
        {
            result.AppendLine("  (No new products available in your preferred categories)");
        }
        else
        {
            foreach (var product in recommendations)
            {
                result.AppendLine($"  • {product.Name}");
                result.AppendLine($"    Category: {product.CategoryName}, Price: ${product.ListPrice:N2}, Color: {product.Color}");
                result.AppendLine($"    ProductID: {product.ProductID}");
            }
        }

        return result.ToString();
    }
}
