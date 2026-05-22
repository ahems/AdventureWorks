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

    /// <summary>
    /// Returns the most recently registered customers who have never placed an order.
    /// Used by admin agents for proactive outreach and conversion tracking.
    /// </summary>
    public async Task<string> GetRecentCustomersWithoutOrdersAsync(int limit = 10)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT TOP (@Limit)
                cust.CustomerID,
                p.FirstName,
                p.LastName,
                ea.EmailAddress,
                addr.City,
                sp.StateProvinceCode,
                cr.Name AS Country,
                cust.CustomerID AS RegistrationRank
            FROM Sales.Customer cust
            INNER JOIN Person.Person p
                ON cust.PersonID = p.BusinessEntityID
                AND p.PersonType = 'IN'
            LEFT JOIN Person.EmailAddress ea
                ON p.BusinessEntityID = ea.BusinessEntityID
            LEFT JOIN Person.BusinessEntityAddress bea
                ON p.BusinessEntityID = bea.BusinessEntityID
                AND bea.AddressTypeID = 2
            LEFT JOIN Person.Address addr
                ON bea.AddressID = addr.AddressID
            LEFT JOIN Person.StateProvince sp
                ON addr.StateProvinceID = sp.StateProvinceID
            LEFT JOIN Person.CountryRegion cr
                ON sp.CountryRegionCode = cr.CountryRegionCode
            WHERE NOT EXISTS (
                SELECT 1 FROM Sales.SalesOrderHeader soh
                WHERE soh.CustomerID = cust.CustomerID
            )
            ORDER BY cust.CustomerID DESC";

        var rows = await connection.QueryAsync(sql, new { Limit = limit });

        if (!rows.Any())
            return "No customers without orders found.";

        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"Most recent {rows.Count()} customer(s) who have not yet placed any order:");
        sb.AppendLine();

        foreach (var row in rows)
        {
            var location = new List<string?> { (string?)row.City, (string?)row.StateProvinceCode, (string?)row.Country }
                .Where(s => !string.IsNullOrEmpty(s));
            sb.AppendLine($"CustomerID={row.CustomerID}: {row.FirstName} {row.LastName}");
            sb.AppendLine($"  Email: {row.EmailAddress ?? "(none)"}");
            sb.AppendLine($"  Location: {string.Join(", ", location.Any() ? location : new[] { "Unknown" })}");
            sb.AppendLine($"  Orders: 0");
            sb.AppendLine();
        }

        return sb.ToString();
    }

    /// <summary>
    /// Search existing customers by first/last name fragment, returning basic profile info
    /// and a short order history summary. Used by the AI order generation wizard.
    /// </summary>
    public async Task<string> SearchCustomersAsync(string? nameFilter = null, int limit = 20)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT TOP (@Limit)
                cust.CustomerID,
                p.FirstName,
                p.LastName,
                p.Suffix,
                ea.EmailAddress,
                addr.City,
                sp.StateProvinceCode,
                cr.Name AS Country,
                COUNT(DISTINCT soh.SalesOrderID) AS OrderCount,
                MAX(soh.OrderDate) AS LastOrderDate,
                ISNULL(SUM(soh.TotalDue), 0) AS TotalSpend
            FROM Sales.Customer cust
            INNER JOIN Person.Person p ON cust.PersonID = p.BusinessEntityID
            LEFT JOIN Person.EmailAddress ea ON p.BusinessEntityID = ea.BusinessEntityID
            LEFT JOIN Person.BusinessEntityAddress bea ON p.BusinessEntityID = bea.BusinessEntityID AND bea.AddressTypeID = 2
            LEFT JOIN Person.Address addr ON bea.AddressID = addr.AddressID
            LEFT JOIN Person.StateProvince sp ON addr.StateProvinceID = sp.StateProvinceID
            LEFT JOIN Person.CountryRegion cr ON sp.CountryRegionCode = cr.CountryRegionCode
            LEFT JOIN Sales.SalesOrderHeader soh ON cust.CustomerID = soh.CustomerID
            WHERE (@NameFilter IS NULL
                   OR p.FirstName LIKE '%' + @NameFilter + '%'
                   OR p.LastName LIKE '%' + @NameFilter + '%')
            GROUP BY cust.CustomerID, p.FirstName, p.LastName, p.Suffix,
                     ea.EmailAddress, addr.City, sp.StateProvinceCode, cr.Name
            ORDER BY LastOrderDate DESC, cust.CustomerID";

        var rows = await connection.QueryAsync(sql, new { Limit = limit, NameFilter = nameFilter });

        if (!rows.Any())
            return "No customers found matching the search criteria.";

        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"Customers (up to {limit} results{(nameFilter != null ? $", filter: '{nameFilter}'" : "")}):");
        sb.AppendLine();

        foreach (var row in rows)
        {
            var location = new List<string?> { (string?)row.City, (string?)row.StateProvinceCode, (string?)row.Country }
                .Where(s => !string.IsNullOrEmpty(s));
            sb.AppendLine($"CustomerID={row.CustomerID}: {row.FirstName} {row.LastName}");
            sb.AppendLine($"  Email: {row.EmailAddress ?? "(none)"}");
            sb.AppendLine($"  Location: {string.Join(", ", location.Any() ? location : new[] { "Unknown" })}");
            sb.AppendLine($"  Orders: {row.OrderCount} | Total Spend: ${row.TotalSpend:N2} | Last Order: {(row.LastOrderDate != null ? ((DateTime)row.LastOrderDate).ToString("yyyy-MM-dd") : "never")}");
            sb.AppendLine();
        }

        return sb.ToString();
    }

    /// <summary>
    /// Returns high-level business KPIs: customer count, order counts/revenue by status,
    /// top 5 product categories by revenue, and overall totals.
    /// </summary>
    public async Task<string> GetBusinessStatsAsync()
    {
        using var connection = await GetConnectionAsync();

        var customerCountSql = @"
            SELECT COUNT(*) AS TotalCustomers
            FROM Sales.Customer c WITH (NOLOCK)
            INNER JOIN Person.Person p WITH (NOLOCK) ON c.PersonID = p.BusinessEntityID";

        var orderStatsSql = @"
            SELECT
                CASE soh.Status
                    WHEN 1 THEN 'In Process'
                    WHEN 2 THEN 'Approved'
                    WHEN 3 THEN 'Backordered'
                    WHEN 4 THEN 'Rejected'
                    WHEN 5 THEN 'Shipped'
                    WHEN 6 THEN 'Cancelled'
                    ELSE 'Unknown'
                END AS StatusText,
                COUNT(*) AS OrderCount,
                SUM(soh.TotalDue) AS Revenue
            FROM Sales.SalesOrderHeader soh WITH (NOLOCK)
            GROUP BY soh.Status
            ORDER BY soh.Status";

        // Pre-aggregate at subcategory level, then map to category using DISTINCT
        // to handle multi-language rows in ProductSubcategory/ProductCategory tables.
        var topCategoriesSql = @"
            WITH CategoryRevenue AS (
                SELECT pcm.ProductCategoryID,
                       SUM(sub.TotalOrders)  AS TotalOrders,
                       SUM(sub.TotalRevenue) AS TotalRevenue
                FROM (
                    SELECT p.ProductSubcategoryID,
                           COUNT(DISTINCT sod.SalesOrderID) AS TotalOrders,
                           SUM(sod.LineTotal)               AS TotalRevenue
                    FROM Sales.SalesOrderDetail sod WITH (NOLOCK)
                    INNER JOIN Production.Product p WITH (NOLOCK)
                        ON sod.ProductID = p.ProductID
                    WHERE p.ProductSubcategoryID IS NOT NULL
                    GROUP BY p.ProductSubcategoryID
                ) sub
                INNER JOIN (
                    SELECT DISTINCT ProductSubcategoryID, ProductCategoryID
                    FROM Production.ProductSubcategory WITH (NOLOCK)
                ) pcm ON sub.ProductSubcategoryID = pcm.ProductSubcategoryID
                GROUP BY pcm.ProductCategoryID
            )
            SELECT TOP 5
                MIN(pc.Name)    AS Category,
                cr.TotalOrders  AS Orders,
                cr.TotalRevenue AS Revenue
            FROM CategoryRevenue cr
            INNER JOIN Production.ProductCategory pc WITH (NOLOCK)
                ON cr.ProductCategoryID = pc.ProductCategoryID
            GROUP BY cr.ProductCategoryID, cr.TotalOrders, cr.TotalRevenue
            ORDER BY cr.TotalRevenue DESC";

        var totalRevenueSql = @"
            SELECT
                COUNT(*) AS TotalOrders,
                SUM(TotalDue) AS TotalRevenue,
                AVG(TotalDue) AS AvgOrderValue,
                MIN(OrderDate) AS FirstOrderDate,
                MAX(OrderDate) AS LastOrderDate
            FROM Sales.SalesOrderHeader WITH (NOLOCK)";

        var customerCount = await connection.ExecuteScalarAsync<int>(customerCountSql, commandTimeout: 60);
        var orderStats = (await connection.QueryAsync(orderStatsSql, commandTimeout: 60)).AsList();
        var topCategories = (await connection.QueryAsync(topCategoriesSql, commandTimeout: 60)).AsList();
        var totals = await connection.QuerySingleAsync(totalRevenueSql, commandTimeout: 60);

        var sb = new StringBuilder();
        sb.AppendLine("=== AdventureWorks Business Dashboard ===");
        sb.AppendLine();
        sb.AppendLine($"Total Customers: {customerCount:N0}");
        sb.AppendLine($"Total Orders: {totals.TotalOrders:N0}");
        sb.AppendLine($"Total Revenue: ${totals.TotalRevenue:N2}");
        sb.AppendLine($"Average Order Value: ${totals.AvgOrderValue:N2}");
        sb.AppendLine($"Order Period: {((DateTime)totals.FirstOrderDate):yyyy-MM-dd} to {((DateTime)totals.LastOrderDate):yyyy-MM-dd}");
        sb.AppendLine();
        sb.AppendLine("Orders by Status:");
        foreach (var row in orderStats)
        {
            sb.AppendLine($"  {row.StatusText}: {row.OrderCount:N0} orders, ${row.Revenue:N2} revenue");
        }
        sb.AppendLine();
        sb.AppendLine("Top 5 Categories by Revenue:");
        int rank = 1;
        foreach (var cat in topCategories)
        {
            sb.AppendLine($"  {rank++}. {cat.Category}: ${cat.Revenue:N2} ({cat.Orders:N0} orders)");
        }
        return sb.ToString();
    }

    /// <summary>
    /// Returns the top customers ranked by total spend (lifetime order value).
    /// </summary>
    public async Task<string> GetTopCustomersAsync(int topN = 10)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT TOP (@TopN)
                cust.CustomerID,
                p.FirstName,
                p.LastName,
                ea.EmailAddress,
                addr.City,
                sp.StateProvinceCode,
                cr.Name AS Country,
                COUNT(DISTINCT soh.SalesOrderID) AS OrderCount,
                SUM(soh.TotalDue) AS TotalSpend,
                MAX(soh.OrderDate) AS LastOrderDate
            FROM Sales.Customer cust WITH (NOLOCK)
            INNER JOIN Person.Person p WITH (NOLOCK) ON cust.PersonID = p.BusinessEntityID
            LEFT JOIN Person.EmailAddress ea WITH (NOLOCK) ON p.BusinessEntityID = ea.BusinessEntityID
            LEFT JOIN Person.BusinessEntityAddress bea WITH (NOLOCK) ON p.BusinessEntityID = bea.BusinessEntityID AND bea.AddressTypeID = 2
            LEFT JOIN Person.Address addr WITH (NOLOCK) ON bea.AddressID = addr.AddressID
            LEFT JOIN Person.StateProvince sp WITH (NOLOCK) ON addr.StateProvinceID = sp.StateProvinceID
            LEFT JOIN Person.CountryRegion cr WITH (NOLOCK) ON sp.CountryRegionCode = cr.CountryRegionCode
            INNER JOIN Sales.SalesOrderHeader soh WITH (NOLOCK) ON cust.CustomerID = soh.CustomerID
            GROUP BY cust.CustomerID, p.FirstName, p.LastName, ea.EmailAddress,
                     addr.City, sp.StateProvinceCode, cr.Name
            ORDER BY TotalSpend DESC";

        var rows = (await connection.QueryAsync(sql, new { TopN = topN }, commandTimeout: 60)).AsList();

        if (!rows.Any())
            return "No customers with orders found.";

        var sb = new StringBuilder();
        sb.AppendLine($"Top {rows.Count()} Customers by Total Spend:");
        sb.AppendLine();
        int rank = 1;
        foreach (var row in rows)
        {
            var location = new List<string?> { (string?)row.City, (string?)row.StateProvinceCode, (string?)row.Country }
                .Where(s => !string.IsNullOrEmpty(s));
            sb.AppendLine($"#{rank++} CustomerID={row.CustomerID}: {row.FirstName} {row.LastName}");
            sb.AppendLine($"  Email: {row.EmailAddress ?? "(none)"}");
            sb.AppendLine($"  Location: {string.Join(", ", location.Any() ? location : new[] { "Unknown" })}");
            sb.AppendLine($"  Orders: {row.OrderCount} | Total Spend: ${row.TotalSpend:N2} | Last Order: {((DateTime)row.LastOrderDate):yyyy-MM-dd}");
            sb.AppendLine();
        }
        return sb.ToString();
    }

    /// <summary>
    /// Returns orders filtered by status. Accepts plain-English status names
    /// ("pending", "shipped", "cancelled", etc.) or returns all orders if null.
    /// </summary>
    public async Task<string> GetOrdersByStatusAsync(string? statusFilter = null, int limit = 50)
    {
        using var connection = await GetConnectionAsync();

        // Map plain-English names to AdventureWorks status codes
        int? statusCode = statusFilter?.Trim().ToLowerInvariant() switch
        {
            "in process" or "pending" or "processing" or "open" => 1,
            "approved" => 2,
            "backordered" or "backorder" => 3,
            "rejected" => 4,
            "shipped" or "complete" or "completed" or "fulfilled" => 5,
            "cancelled" or "canceled" => 6,
            _ => null
        };

        var sql = @"
            SELECT TOP (@Limit)
                soh.SalesOrderID,
                soh.OrderDate,
                soh.DueDate,
                soh.ShipDate,
                soh.TotalDue,
                CASE soh.Status
                    WHEN 1 THEN 'In Process'
                    WHEN 2 THEN 'Approved'
                    WHEN 3 THEN 'Backordered'
                    WHEN 4 THEN 'Rejected'
                    WHEN 5 THEN 'Shipped'
                    WHEN 6 THEN 'Cancelled'
                    ELSE 'Unknown'
                END AS StatusText,
                p.FirstName + ' ' + p.LastName AS CustomerName,
                cust.CustomerID
            FROM Sales.SalesOrderHeader soh WITH (NOLOCK)
            INNER JOIN Sales.Customer cust WITH (NOLOCK) ON soh.CustomerID = cust.CustomerID
            INNER JOIN Person.Person p WITH (NOLOCK) ON cust.PersonID = p.BusinessEntityID
            WHERE @StatusCode IS NULL OR soh.Status = @StatusCode
            ORDER BY soh.OrderDate DESC";

        var rows = (await connection.QueryAsync(sql, new { Limit = limit, StatusCode = statusCode }, commandTimeout: 60)).AsList();

        if (!rows.Any())
        {
            var label = statusFilter != null ? $"status '{statusFilter}'" : "any status";
            return $"No orders found for {label}.";
        }

        var displayStatus = statusFilter != null
            ? rows.First().StatusText
            : "All";

        var sb = new StringBuilder();
        sb.AppendLine($"Orders (Status: {displayStatus}) — showing up to {limit} most recent:");
        sb.AppendLine();
        foreach (var row in rows)
        {
            sb.AppendLine($"Order #{row.SalesOrderID} | {row.StatusText} | {((DateTime)row.OrderDate):yyyy-MM-dd} | ${row.TotalDue:N2}");
            sb.AppendLine($"  Customer: {row.CustomerName} (ID {row.CustomerID})");
            if (row.ShipDate != null)
                sb.AppendLine($"  Shipped: {((DateTime)row.ShipDate):yyyy-MM-dd}");
            sb.AppendLine();
        }
        return sb.ToString();
    }

    /// <summary>
    /// Aggregates all orders by status, returning count and total revenue per status.
    /// </summary>
    public async Task<string> GetSalesReportByStatusAsync()
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT
                CASE soh.Status
                    WHEN 1 THEN 'In Process'
                    WHEN 2 THEN 'Approved'
                    WHEN 3 THEN 'Backordered'
                    WHEN 4 THEN 'Rejected'
                    WHEN 5 THEN 'Shipped'
                    WHEN 6 THEN 'Cancelled'
                    ELSE 'Unknown'
                END AS StatusText,
                COUNT(*) AS OrderCount,
                SUM(soh.TotalDue) AS TotalRevenue,
                AVG(soh.TotalDue) AS AvgOrderValue,
                MIN(soh.OrderDate) AS OldestOrder,
                MAX(soh.OrderDate) AS NewestOrder
            FROM Sales.SalesOrderHeader soh WITH (NOLOCK)
            GROUP BY soh.Status
            ORDER BY soh.Status";

        var grandTotalSql = @"
            SELECT COUNT(*) AS TotalOrders, SUM(TotalDue) AS GrandTotal
            FROM Sales.SalesOrderHeader WITH (NOLOCK)";

        var rows = (await connection.QueryAsync(sql, commandTimeout: 60)).AsList();
        var grand = await connection.QuerySingleAsync(grandTotalSql, commandTimeout: 60);

        var sb = new StringBuilder();
        sb.AppendLine("=== Sales Report by Order Status ===");
        sb.AppendLine();
        foreach (var row in rows)
        {
            sb.AppendLine($"Status: {row.StatusText}");
            sb.AppendLine($"  Orders: {row.OrderCount:N0}");
            sb.AppendLine($"  Total Revenue: ${row.TotalRevenue:N2}");
            sb.AppendLine($"  Avg Order Value: ${row.AvgOrderValue:N2}");
            sb.AppendLine($"  Date Range: {((DateTime)row.OldestOrder):yyyy-MM-dd} → {((DateTime)row.NewestOrder):yyyy-MM-dd}");
            sb.AppendLine();
        }
        sb.AppendLine($"Grand Total: {grand.TotalOrders:N0} orders | ${grand.GrandTotal:N2} revenue");
        return sb.ToString();
    }

    /// <summary>
    /// Returns a combined performance summary for a single product:
    /// sales volume, revenue, margin estimate, sales rank, review rating, and stock level.
    /// </summary>
    public async Task<string> GetProductPerformanceSummaryAsync(int productId)
    {
        using var connection = await GetConnectionAsync();

        var productSql = @"
            SELECT
                p.ProductID,
                p.Name,
                p.ProductNumber,
                p.StandardCost,
                p.ListPrice,
                p.Color,
                ISNULL(SUM(inv.Quantity), 0) AS CurrentStock,
                COUNT(DISTINCT sod.SalesOrderID) AS TotalOrders,
                ISNULL(SUM(sod.OrderQty), 0) AS TotalUnitsSold,
                ISNULL(SUM(sod.LineTotal), 0) AS TotalRevenue,
                ISNULL(AVG(sod.UnitPrice), p.ListPrice) AS AvgSalePrice
            FROM Production.Product p
            LEFT JOIN Production.ProductInventory inv ON p.ProductID = inv.ProductID
            LEFT JOIN Sales.SalesOrderDetail sod ON p.ProductID = sod.ProductID
            WHERE p.ProductID = @ProductId
            GROUP BY p.ProductID, p.Name, p.ProductNumber, p.StandardCost, p.ListPrice, p.Color";

        var rankSql = @"
            SELECT COUNT(*) + 1 AS SalesRank
            FROM (
                SELECT ProductID, SUM(LineTotal) AS Rev
                FROM Sales.SalesOrderDetail
                GROUP BY ProductID
                HAVING SUM(LineTotal) > (
                    SELECT ISNULL(SUM(LineTotal), 0)
                    FROM Sales.SalesOrderDetail
                    WHERE ProductID = @ProductId
                )
            ) t";

        var reviewSql = @"
            SELECT COUNT(*) AS ReviewCount, AVG(CAST(Rating AS FLOAT)) AS AvgRating
            FROM Production.ProductReview
            WHERE ProductID = @ProductId";

        var product = await connection.QuerySingleOrDefaultAsync(productSql, new { ProductId = productId });
        if (product == null)
            return $"Product {productId} not found.";

        var rank = await connection.QuerySingleAsync(rankSql, new { ProductId = productId });
        var reviews = await connection.QuerySingleAsync(reviewSql, new { ProductId = productId });

        double margin = product.ListPrice > 0
            ? ((double)(product.ListPrice - product.StandardCost) / (double)product.ListPrice) * 100.0
            : 0;

        var sb = new StringBuilder();
        sb.AppendLine($"=== Product Performance: {product.Name} (#{product.ProductNumber}) ===");
        sb.AppendLine();
        sb.AppendLine("Pricing & Margin:");
        sb.AppendLine($"  List Price: ${product.ListPrice:N2}");
        sb.AppendLine($"  Standard Cost: ${product.StandardCost:N2}");
        sb.AppendLine($"  Gross Margin: {margin:N1}%");
        sb.AppendLine($"  Avg Sale Price: ${product.AvgSalePrice:N2}");
        sb.AppendLine();
        sb.AppendLine("Sales Performance:");
        sb.AppendLine($"  Total Units Sold: {product.TotalUnitsSold:N0}");
        sb.AppendLine($"  Total Revenue: ${product.TotalRevenue:N2}");
        sb.AppendLine($"  Total Orders Containing This Product: {product.TotalOrders:N0}");
        sb.AppendLine($"  Sales Rank (by revenue): #{rank.SalesRank}");
        sb.AppendLine();
        sb.AppendLine("Inventory:");
        sb.AppendLine($"  Current Stock: {product.CurrentStock:N0} units");
        if (product.Color != null)
            sb.AppendLine($"  Color: {product.Color}");
        sb.AppendLine();
        sb.AppendLine("Customer Reviews:");
        if (reviews.ReviewCount > 0)
        {
            sb.AppendLine($"  Reviews: {reviews.ReviewCount}");
            sb.AppendLine($"  Average Rating: {reviews.AvgRating:N1} / 5.0");
        }
        else
        {
            sb.AppendLine("  No customer reviews on record.");
        }
        return sb.ToString();
    }
}
