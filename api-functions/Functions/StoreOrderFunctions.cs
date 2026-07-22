using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using api_functions.Services;
using System.Net;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.AspNetCore.WebUtilities;

namespace api_functions.Functions;

/// <summary>
/// Azure Functions for B2B store order management.
/// Lets admin users place orders on behalf of stores (phone/email orders).
/// </summary>
public class StoreOrderFunctions
{
    private readonly ILogger<StoreOrderFunctions> _logger;
    private readonly OrderGenerationService _orderService;
    private readonly WebPubSubService _webPubSub;
    private readonly string _connectionString;

    public StoreOrderFunctions(
        ILogger<StoreOrderFunctions> logger,
        OrderGenerationService orderService,
        WebPubSubService webPubSub,
        IConfiguration configuration)
    {
        _logger = logger;
        _orderService = orderService;
        _webPubSub = webPubSub;
        _connectionString = configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not set");
    }

    /// <summary>
    /// GET /api/stores — returns all B2B stores with customer stats
    /// </summary>
    [Function("GetStores")]
    public async Task<HttpResponseData> GetStores(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "stores")] HttpRequestData req)
    {
        _logger.LogInformation("GetStores called");
        try
        {
            var queryParams = QueryHelpers.ParseQuery(req.Url.Query);
            var search = queryParams.TryGetValue("search", out var s) ? s.ToString() : null;
            int? territoryId = queryParams.TryGetValue("territoryId", out var t) && int.TryParse(t, out var tv) ? (int?)tv : null;
            var sortBy = queryParams.TryGetValue("sortBy", out var sb) ? sb.ToString() : null;
            var limit = queryParams.TryGetValue("limit", out var l) && int.TryParse(l, out var lv) ? lv : 100;
            var offset = queryParams.TryGetValue("offset", out var o) && int.TryParse(o, out var ov) ? ov : 0;

            using var connection = new SqlConnection(_connectionString);
            await connection.OpenAsync();

            // CTEs aggregate across ALL Customer records per store so each store
            // appears exactly once even when Sales.Customer has multiple rows per store.
            var sql = @"
                WITH StoreAddr AS (
                    -- One address row per store (pick the first by AddressID)
                    SELECT bea.BusinessEntityID,
                           bea.AddressID,
                           addr.AddressLine1,
                           addr.City,
                           sp.Name             AS StateProvince,
                           cr.Name             AS Country,
                           sp.CountryRegionCode AS CountryCode,
                           ROW_NUMBER() OVER (PARTITION BY bea.BusinessEntityID ORDER BY bea.AddressID) AS rn
                    FROM Person.BusinessEntityAddress bea
                    INNER JOIN Person.Address       addr ON addr.AddressID        = bea.AddressID
                    INNER JOIN Person.StateProvince sp   ON sp.StateProvinceID    = addr.StateProvinceID
                    INNER JOIN Person.CountryRegion cr   ON cr.CountryRegionCode  = sp.CountryRegionCode
                ),
                StorePrimaryCustomer AS (
                    -- Pick one representative CustomerID per store (lowest = most stable)
                    SELECT StoreID,
                           MIN(CustomerID) AS CustomerID,
                           MIN(TerritoryID) AS TerritoryID
                    FROM Sales.Customer
                    WHERE StoreID IS NOT NULL
                    GROUP BY StoreID
                ),
                StoreOrderStats AS (
                    -- Aggregate orders across ALL customer records for each store
                    SELECT c.StoreID,
                           COUNT(*)         AS OrderCount,
                           SUM(soh.TotalDue) AS TotalRevenue,
                           MAX(soh.OrderDate) AS LastOrderDate
                    FROM Sales.SalesOrderHeader soh
                    INNER JOIN Sales.Customer c ON c.CustomerID = soh.CustomerID
                    WHERE c.StoreID IS NOT NULL
                    GROUP BY c.StoreID
                )
                SELECT
                    s.BusinessEntityID  AS StoreBusinessEntityId,
                    s.Name              AS StoreName,
                    s.SalesPersonID,
                    p.FirstName         AS SalesRepFirstName,
                    p.LastName          AS SalesRepLastName,
                    pc.CustomerID,
                    pc.TerritoryID,
                    st.Name             AS TerritoryName,
                    sa.AddressID,
                    sa.AddressLine1,
                    sa.City,
                    sa.StateProvince,
                    sa.Country,
                    sa.CountryCode,
                    ISNULL(ords.OrderCount, 0)   AS OrderCount,
                    ISNULL(ords.TotalRevenue, 0) AS TotalRevenue,
                    ords.LastOrderDate
                FROM Sales.Store s
                INNER JOIN StorePrimaryCustomer pc  ON pc.StoreID          = s.BusinessEntityID
                LEFT  JOIN Sales.SalesPerson salp   ON salp.BusinessEntityID = s.SalesPersonID
                LEFT  JOIN Person.Person p           ON p.BusinessEntityID   = salp.BusinessEntityID
                LEFT  JOIN Sales.SalesTerritory st   ON st.TerritoryID       = pc.TerritoryID
                LEFT  JOIN StoreAddr sa              ON sa.BusinessEntityID  = s.BusinessEntityID AND sa.rn = 1
                LEFT  JOIN StoreOrderStats ords      ON ords.StoreID         = s.BusinessEntityID
                WHERE (@Search IS NULL OR s.Name LIKE '%' + @Search + '%')
                  AND (@TerritoryId IS NULL OR pc.TerritoryID = @TerritoryId)
                ORDER BY
                    CASE WHEN @SortBy = 'revenue'   OR @SortBy IS NULL THEN ISNULL(ords.TotalRevenue, 0) END DESC,
                    CASE WHEN @SortBy = 'orders'    THEN ISNULL(ords.OrderCount, 0) END DESC,
                    CASE WHEN @SortBy = 'lastOrder' THEN ords.LastOrderDate         END DESC,
                    CASE WHEN @SortBy = 'name'      THEN s.Name                     END ASC
                OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY";

            var rows = await connection.QueryAsync<StoreListItem>(sql, new { Search = search, TerritoryId = territoryId, SortBy = sortBy, Limit = limit, Offset = offset });

            // Count: one row per Store (not per Customer)
            var totalSql = @"
                SELECT COUNT(DISTINCT s.BusinessEntityID)
                FROM Sales.Store s
                INNER JOIN Sales.Customer c ON c.StoreID = s.BusinessEntityID
                WHERE (@Search IS NULL OR s.Name LIKE '%' + @Search + '%')
                  AND (@TerritoryId IS NULL OR c.TerritoryID = @TerritoryId)";
            var totalCount = await connection.ExecuteScalarAsync<int>(totalSql, new { Search = search, TerritoryId = territoryId });

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new { items = rows, totalCount, hasMore = offset + limit < totalCount });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GetStores");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.Message });
            return err;
        }
    }

    /// <summary>
    /// GET /api/stores/{storeId} — returns a single store with full details
    /// </summary>
    [Function("GetStoreById")]
    public async Task<HttpResponseData> GetStoreById(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "stores/{storeId:int}")] HttpRequestData req,
        int storeId)
    {
        _logger.LogInformation("GetStoreById called for {StoreId}", storeId);
        try
        {
            using var connection = new SqlConnection(_connectionString);
            await connection.OpenAsync();

            var store = await connection.QueryFirstOrDefaultAsync<StoreDetail>(@"
                SELECT
                    s.BusinessEntityID AS StoreBusinessEntityId,
                    s.Name AS StoreName,
                    s.SalesPersonID,
                    p.FirstName AS SalesRepFirstName,
                    p.LastName  AS SalesRepLastName,
                    ea.EmailAddress AS SalesRepEmail,
                    c.CustomerID,
                    c.TerritoryID,
                    st.Name AS TerritoryName,
                    st.CountryRegionCode AS TerritoryCountry,
                    bea.AddressID,
                    addr.AddressLine1,
                    addr.AddressLine2,
                    addr.City,
                    addr.PostalCode,
                    sp.Name AS StateProvince,
                    cr.Name AS Country
                FROM Sales.Store s
                INNER JOIN Sales.Customer c ON c.StoreID = s.BusinessEntityID
                LEFT  JOIN Sales.SalesPerson salp ON salp.BusinessEntityID = s.SalesPersonID
                LEFT  JOIN Person.Person p ON p.BusinessEntityID = salp.BusinessEntityID
                LEFT  JOIN Person.EmailAddress ea ON ea.BusinessEntityID = salp.BusinessEntityID
                LEFT  JOIN Sales.SalesTerritory st ON st.TerritoryID = c.TerritoryID
                LEFT  JOIN Person.BusinessEntityAddress bea ON bea.BusinessEntityID = s.BusinessEntityID
                LEFT  JOIN Person.Address addr ON addr.AddressID = bea.AddressID
                LEFT  JOIN Person.StateProvince sp ON sp.StateProvinceID = addr.StateProvinceID
                LEFT  JOIN Person.CountryRegion cr ON cr.CountryRegionCode = sp.CountryRegionCode
                WHERE s.BusinessEntityID = @StoreId",
                new { StoreId = storeId });

            if (store == null)
            {
                var notFound = req.CreateResponse(HttpStatusCode.NotFound);
                await notFound.WriteAsJsonAsync(new { error = $"Store {storeId} not found" });
                return notFound;
            }

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(store);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GetStoreById for {StoreId}", storeId);
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.Message });
            return err;
        }
    }

    /// <summary>
    /// GET /api/stores/{storeId}/orders — returns order history for a store
    /// </summary>
    [Function("GetStoreOrders")]
    public async Task<HttpResponseData> GetStoreOrders(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "stores/{storeId:int}/orders")] HttpRequestData req,
        int storeId)
    {
        _logger.LogInformation("GetStoreOrders for {StoreId}", storeId);
        try
        {
            using var connection = new SqlConnection(_connectionString);
            await connection.OpenAsync();

            // Join through ALL Customer records for this store so we pick up every order
            // regardless of which CustomerID it was placed against.
            var orders = await connection.QueryAsync<StoreOrderSummary>(@"
                SELECT
                    soh.SalesOrderID,
                    soh.OrderDate,
                    soh.DueDate,
                    soh.ShipDate,
                    soh.Status,
                    soh.PurchaseOrderNumber,
                    soh.SubTotal,
                    soh.TaxAmt,
                    soh.Freight,
                    soh.TotalDue,
                    soh.OnlineOrderFlag,
                    soh.Comment,
                    sm.Name AS ShipMethodName,
                    COUNT(sod.SalesOrderDetailID) AS LineItemCount
                FROM Sales.SalesOrderHeader soh
                INNER JOIN Sales.Customer c  ON c.CustomerID   = soh.CustomerID
                                           AND c.StoreID       = @StoreId
                LEFT  JOIN Purchasing.ShipMethod sm  ON sm.ShipMethodID  = soh.ShipMethodID
                LEFT  JOIN Sales.SalesOrderDetail sod ON sod.SalesOrderID = soh.SalesOrderID
                GROUP BY soh.SalesOrderID, soh.OrderDate, soh.DueDate, soh.ShipDate, soh.Status,
                         soh.PurchaseOrderNumber, soh.SubTotal, soh.TaxAmt, soh.Freight, soh.TotalDue,
                         soh.OnlineOrderFlag, soh.Comment, sm.Name
                ORDER BY soh.OrderDate DESC",
                new { StoreId = storeId });

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(orders);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GetStoreOrders for {StoreId}", storeId);
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.Message });
            return err;
        }
    }

    /// <summary>
    /// POST /api/store-orders — places a new B2B order on behalf of a store
    /// </summary>
    [Function("PlaceStoreOrder")]
    public async Task<HttpResponseData> PlaceStoreOrder(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "store-orders")] HttpRequestData req)
    {
        _logger.LogInformation("PlaceStoreOrder called");
        try
        {
            var body = await req.ReadAsStringAsync();
            if (string.IsNullOrEmpty(body))
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "Request body is required" });
                return bad;
            }

            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var request = JsonSerializer.Deserialize<PlaceStoreOrderRequest>(body, options);

            if (request == null || request.StoreBusinessEntityId <= 0 || request.Items == null || request.Items.Count == 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "storeBusinessEntityId and at least one item are required" });
                return bad;
            }

            var createReq = new CreateStoreOrderRequest
            {
                StoreBusinessEntityId = request.StoreBusinessEntityId,
                ShipMethodId = request.ShipMethodId,
                PurchaseOrderNumber = request.PurchaseOrderNumber,
                DueDate = request.DueDate,
                Comment = request.Comment,
                Items = request.Items.Select(i => new StoreOrderLineItem
                {
                    ProductId = i.ProductId,
                    Quantity = (short)Math.Max(1, i.Quantity),
                    UnitPrice = i.UnitPrice,
                    DiscountPct = i.DiscountPct
                }).ToList()
            };

            var salesOrderId = await _orderService.CreateStoreOrderAsync(createReq);

            await _webPubSub.SendToGroupAsync("orders", new { @event = "order-placed", salesOrderId });

            var response = req.CreateResponse(HttpStatusCode.Created);
            await response.WriteAsJsonAsync(new
            {
                success = true,
                salesOrderId,
                message = $"Store order #{salesOrderId} created successfully"
            });
            return response;
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Invalid operation in PlaceStoreOrder");
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new { error = ex.Message });
            return bad;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in PlaceStoreOrder");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.Message });
            return err;
        }
    }

    /// <summary>
    /// GET /api/store-products — returns products available for store ordering with inventory info
    /// </summary>
    [Function("GetStoreProducts")]
    public async Task<HttpResponseData> GetStoreProducts(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "store-products")] HttpRequestData req)
    {
        _logger.LogInformation("GetStoreProducts called");
        try
        {
            var queryParams = QueryHelpers.ParseQuery(req.Url.Query);
            var search = queryParams.TryGetValue("search", out var s) ? s.ToString() : null;
            var categoryId = queryParams.TryGetValue("categoryId", out var c) && int.TryParse(c, out var cv) ? (int?)cv : null;
            var subcategoryId = queryParams.TryGetValue("subcategoryId", out var sc) && int.TryParse(sc, out var scv) ? (int?)scv : null;
            var limit = queryParams.TryGetValue("limit", out var l) && int.TryParse(l, out var lv) ? lv : 50;

            using var connection = new SqlConnection(_connectionString);
            await connection.OpenAsync();

            var sql = @"
                SELECT TOP (@Limit)
                    p.ProductID,
                    p.Name AS ProductName,
                    p.ProductNumber,
                    p.Color,
                    p.Size,
                    p.ListPrice AS UnitPrice,
                    p.StandardCost,
                    pc.Name AS CategoryName,
                    sc.Name AS SubcategoryName,
                    ISNULL(SUM(pi.Quantity), 0) AS StockQty,
                    CASE WHEN p.SellEndDate IS NOT NULL AND p.SellEndDate < GETDATE() THEN 1 ELSE 0 END AS IsDiscontinued
                FROM Production.Product p
                LEFT JOIN Production.ProductSubcategory sc ON sc.ProductSubcategoryID = p.ProductSubcategoryID AND sc.CultureID = 'en'
                LEFT JOIN Production.ProductCategory pc    ON pc.ProductCategoryID    = sc.ProductCategoryID AND pc.CultureID = 'en'
                LEFT JOIN Production.ProductInventory pi ON pi.ProductID = p.ProductID
                WHERE p.ListPrice > 0
                  AND p.FinishedGoodsFlag = 1
                  AND (@Search IS NULL OR p.Name LIKE '%' + @Search + '%' OR p.ProductNumber LIKE '%' + @Search + '%')
                  AND (@CategoryId IS NULL OR sc.ProductCategoryID = @CategoryId)
                  AND (@SubcategoryId IS NULL OR sc.ProductSubcategoryID = @SubcategoryId)
                GROUP BY p.ProductID, p.Name, p.ProductNumber, p.Color, p.Size, p.ListPrice,
                         p.StandardCost, pc.Name, sc.Name, p.SellEndDate
                ORDER BY pc.Name, sc.Name, p.Name";

            var products = await connection.QueryAsync<StoreProductInfo>(sql,
                new { Search = search, CategoryId = categoryId, SubcategoryId = subcategoryId, Limit = limit });

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(products);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GetStoreProducts");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.Message });
            return err;
        }
    }

    /// <summary>
    /// GET /api/orders/{orderId}/lines — returns line items for a specific order (for Reorder)
    /// </summary>
    [Function("GetOrderLines")]
    public async Task<HttpResponseData> GetOrderLines(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/{orderId:int}/lines")] HttpRequestData req,
        int orderId)
    {
        _logger.LogInformation("GetOrderLines for {OrderId}", orderId);
        try
        {
            using var connection = new SqlConnection(_connectionString);
            await connection.OpenAsync();

            var lines = await connection.QueryAsync<OrderLineDetail>(@"
                SELECT
                    sod.SalesOrderDetailID,
                    sod.ProductID,
                    p.Name          AS ProductName,
                    p.ProductNumber AS ProductNumber,
                    sod.OrderQty,
                    sod.UnitPrice,
                    sod.UnitPriceDiscount,
                    sod.LineTotal,
                    ISNULL(SUM(pi.Quantity), 0) AS StockQty
                FROM Sales.SalesOrderDetail sod
                INNER JOIN Production.Product p ON p.ProductID = sod.ProductID
                LEFT  JOIN Production.ProductInventory pi ON pi.ProductID = p.ProductID
                WHERE sod.SalesOrderID = @OrderId
                GROUP BY sod.SalesOrderDetailID, sod.ProductID, p.Name, p.ProductNumber,
                         sod.OrderQty, sod.UnitPrice, sod.UnitPriceDiscount, sod.LineTotal
                ORDER BY sod.SalesOrderDetailID",
                new { OrderId = orderId });

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(lines);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GetOrderLines for {OrderId}", orderId);
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.Message });
            return err;
        }
    }

    /// <summary>
    /// GET /api/product-catalog — returns product categories with their subcategories and counts
    /// </summary>
    [Function("GetProductCatalog")]
    public async Task<HttpResponseData> GetProductCatalog(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "product-catalog")] HttpRequestData req)
    {
        _logger.LogInformation("GetProductCatalog called");
        try
        {
            using var connection = new SqlConnection(_connectionString);
            await connection.OpenAsync();

            var rows = await connection.QueryAsync<ProductCatalogRow>(@"
                SELECT
                    c.ProductCategoryID     AS CategoryID,
                    c.Name                  AS CategoryName,
                    sc.ProductSubcategoryID AS SubcategoryID,
                    sc.Name                 AS SubcategoryName,
                    COUNT(p.ProductID)      AS ProductCount
                FROM Production.ProductCategory c
                INNER JOIN Production.ProductSubcategory sc
                    ON sc.ProductCategoryID = c.ProductCategoryID
                    AND sc.CultureID = 'en'
                LEFT JOIN Production.Product p
                    ON p.ProductSubcategoryID = sc.ProductSubcategoryID
                    AND p.ListPrice > 0 AND p.FinishedGoodsFlag = 1
                WHERE c.CultureID = 'en'
                GROUP BY c.ProductCategoryID, c.Name, sc.ProductSubcategoryID, sc.Name
                ORDER BY c.Name, sc.Name");

            // Build hierarchy
            var categories = rows
                .GroupBy(r => new { r.CategoryID, r.CategoryName })
                .Select(g => new
                {
                    categoryID   = g.Key.CategoryID,
                    categoryName = g.Key.CategoryName,
                    productCount = g.Sum(r => r.ProductCount),
                    subcategories = g
                        .Where(r => r.SubcategoryID > 0)
                        .Select(r => new
                        {
                            subcategoryID   = r.SubcategoryID,
                            subcategoryName = r.SubcategoryName,
                            productCount    = r.ProductCount,
                        })
                        .ToList()
                })
                .OrderBy(c => c.categoryName)
                .ToList();

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(categories);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GetProductCatalog");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.Message });
            return err;
        }
    }

    /// <summary>
    /// GET /api/store-territories — returns territory summaries for B2B stores, sorted by revenue
    /// </summary>
    [Function("GetStoreTerritories")]
    public async Task<HttpResponseData> GetStoreTerritories(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "store-territories")] HttpRequestData req)
    {
        _logger.LogInformation("GetStoreTerritories called");
        try
        {
            using var connection = new SqlConnection(_connectionString);
            await connection.OpenAsync();

            var territories = await connection.QueryAsync<TerritoryStoreSummary>(@"
                SELECT
                    st.TerritoryID,
                    st.Name AS TerritoryName,
                    st.CountryRegionCode AS CountryCode,
                    cr.Name AS CountryName,
                    COUNT(DISTINCT s.BusinessEntityID) AS StoreCount,
                    COUNT(DISTINCT CASE WHEN ords.OrderCount IS NOT NULL THEN s.BusinessEntityID END) AS ActiveStoreCount,
                    ISNULL(SUM(ords.TotalRevenue), 0) AS TotalRevenue,
                    ISNULL(SUM(ords.OrderCount), 0) AS TotalOrders,
                    CASE WHEN COUNT(DISTINCT s.BusinessEntityID) = 0
                         THEN 0
                         ELSE ISNULL(SUM(ords.TotalRevenue), 0) / COUNT(DISTINCT s.BusinessEntityID)
                    END AS AvgRevenuePerStore,
                    MAX(ords.LastOrderDate) AS LastOrderDate
                FROM Sales.SalesTerritory st
                INNER JOIN Person.CountryRegion cr ON cr.CountryRegionCode = st.CountryRegionCode
                LEFT  JOIN Sales.Customer c ON c.TerritoryID = st.TerritoryID AND c.StoreID IS NOT NULL
                LEFT  JOIN Sales.Store s ON s.BusinessEntityID = c.StoreID
                LEFT  JOIN (
                    SELECT CustomerID, COUNT(*) AS OrderCount, SUM(TotalDue) AS TotalRevenue, MAX(OrderDate) AS LastOrderDate
                    FROM Sales.SalesOrderHeader
                    GROUP BY CustomerID
                ) ords ON ords.CustomerID = c.CustomerID
                GROUP BY st.TerritoryID, st.Name, st.CountryRegionCode, cr.Name
                ORDER BY TotalRevenue DESC");

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(territories);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GetStoreTerritories");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.Message });
            return err;
        }
    }
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

public class PlaceStoreOrderRequest
{
    public int StoreBusinessEntityId { get; set; }
    public List<PlaceStoreOrderItem> Items { get; set; } = new();
    public int ShipMethodId { get; set; } = 0;
    public string? PurchaseOrderNumber { get; set; }
    public DateTime? DueDate { get; set; }
    public string? Comment { get; set; }
}

public class PlaceStoreOrderItem
{
    public int ProductId { get; set; }
    public int Quantity { get; set; } = 1;
    public decimal UnitPrice { get; set; } = 0;
    public decimal DiscountPct { get; set; } = 0;
}

public class StoreListItem
{
    public int StoreBusinessEntityId { get; set; }
    public string StoreName { get; set; } = string.Empty;
    public int? SalesPersonID { get; set; }
    public string? SalesRepFirstName { get; set; }
    public string? SalesRepLastName { get; set; }
    public int CustomerID { get; set; }
    public int? TerritoryID { get; set; }
    public string? TerritoryName { get; set; }
    public int? AddressID { get; set; }
    public string? AddressLine1 { get; set; }
    public string? City { get; set; }
    public string? StateProvince { get; set; }
    public string? Country { get; set; }
    public string? CountryCode { get; set; }
    public int OrderCount { get; set; }
    public decimal TotalRevenue { get; set; }
    public DateTime? LastOrderDate { get; set; }
}

public class StoreDetail : StoreListItem
{
    public string? SalesRepEmail { get; set; }
    public string? AddressLine2 { get; set; }
    public string? PostalCode { get; set; }
    public string? TerritoryCountry { get; set; }
}

public class StoreOrderSummary
{
    public int SalesOrderID { get; set; }
    public DateTime OrderDate { get; set; }
    public DateTime DueDate { get; set; }
    public DateTime? ShipDate { get; set; }
    public int Status { get; set; }
    public string? PurchaseOrderNumber { get; set; }
    public decimal SubTotal { get; set; }
    public decimal TaxAmt { get; set; }
    public decimal Freight { get; set; }
    public decimal TotalDue { get; set; }
    public bool OnlineOrderFlag { get; set; }
    public string? Comment { get; set; }
    public string? ShipMethodName { get; set; }
    public int LineItemCount { get; set; }
}

public class StoreProductInfo
{
    public int ProductID { get; set; }
    public string ProductName { get; set; } = string.Empty;
    public string? ProductNumber { get; set; }
    public string? Color { get; set; }
    public string? Size { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal StandardCost { get; set; }
    public string? CategoryName { get; set; }
    public string? SubcategoryName { get; set; }
    public int StockQty { get; set; }
    public bool IsDiscontinued { get; set; }
}

public class TerritoryStoreSummary
{
    public int TerritoryID { get; set; }
    public string TerritoryName { get; set; } = string.Empty;
    public string CountryCode { get; set; } = string.Empty;
    public string CountryName { get; set; } = string.Empty;
    public int StoreCount { get; set; }
    public int ActiveStoreCount { get; set; }
    public decimal TotalRevenue { get; set; }
    public int TotalOrders { get; set; }
    public decimal AvgRevenuePerStore { get; set; }
    public DateTime? LastOrderDate { get; set; }
}

public class OrderLineDetail
{
    public int SalesOrderDetailID { get; set; }
    public int ProductID { get; set; }
    public string ProductName { get; set; } = string.Empty;
    public string? ProductNumber { get; set; }
    public short OrderQty { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal UnitPriceDiscount { get; set; }
    public decimal LineTotal { get; set; }
    public int StockQty { get; set; }
}

public class ProductCatalogRow
{
    public int CategoryID { get; set; }
    public string CategoryName { get; set; } = string.Empty;
    public int SubcategoryID { get; set; }
    public string SubcategoryName { get; set; } = string.Empty;
    public int ProductCount { get; set; }
}
