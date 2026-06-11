using System.Data;
using System.Text.Json;
using System.Globalization;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Localization;
using AdventureWorks.Models;
using AdventureWorks.Resources;

namespace AdventureWorks.Services;

public class ProductService
{
    private readonly string _connectionString;
    private readonly IStringLocalizer<Strings> _localizer;

    public ProductService(string connectionString, IStringLocalizer<Strings> localizer)
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

    public async Task<List<ProductData>> GetFinishedGoodsProductsAsync(List<int>? productIds = null)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT 
                p.ProductID,
                p.Name,
                p.ProductNumber,
                p.Color,
                p.ListPrice,
                p.Size,
                p.SizeUnitMeasureCode,
                p.Weight,
                p.WeightUnitMeasureCode,
                p.Class,
                p.Style,
                p.ProductSubcategoryID,
                ps.Name AS ProductSubcategoryName,
                pc.ProductCategoryID,
                pc.Name AS ProductCategoryName,
                p.ProductModelID,
                pm.Name AS ProductModelName,
                pm.CatalogDescription,
                pd.ProductDescriptionID,
                pd.Description,
                p.ModifiedDate
            FROM Production.Product p
            LEFT JOIN Production.ProductSubcategory ps ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON ps.ProductCategoryID = pc.ProductCategoryID
            LEFT JOIN Production.ProductModel pm ON p.ProductModelID = pm.ProductModelID
            LEFT JOIN Production.ProductModelProductDescriptionCulture pmpdc ON pm.ProductModelID = pmpdc.ProductModelID AND pmpdc.CultureID = 'en'
            LEFT JOIN Production.ProductDescription pd ON pmpdc.ProductDescriptionID = pd.ProductDescriptionID
            WHERE p.FinishedGoodsFlag = 1";

        if (productIds != null && productIds.Count > 0)
        {
            sql += " AND p.ProductID IN @ProductIds";
        }

        sql += " ORDER BY p.ProductID";

        var products = await connection.QueryAsync<ProductData>(sql, new { ProductIds = productIds });
        return products.ToList();
    }

    public async Task<string> CheckInventoryAvailabilityAsync(int productId, string cultureId = "en")
    {
        // Set culture for localization
        CultureInfo.CurrentUICulture = new CultureInfo(cultureId);

        using var connection = await GetConnectionAsync();

        // Get product name (only for finished goods)
        var productName = await connection.QueryFirstOrDefaultAsync<string>(
            "SELECT Name FROM Production.Product WHERE ProductID = @ProductId AND FinishedGoodsFlag = 1",
            new { ProductId = productId });

        if (string.IsNullOrEmpty(productName))
        {
            return _localizer["ProductNotFound", productId].Value;
        }

        // Get total inventory from finished goods locations only
        var totalStock = await connection.QueryFirstOrDefaultAsync<int?>(@"
            SELECT SUM(pi.Quantity)
            FROM Production.ProductInventory pi
            INNER JOIN Production.Product p ON pi.ProductID = p.ProductID
            INNER JOIN Production.Location l ON pi.LocationID = l.LocationID
            WHERE pi.ProductID = @ProductId
            AND p.FinishedGoodsFlag = 1
            AND l.Name LIKE 'Finished Goods%'
            AND pi.Quantity > 0",
            new { ProductId = productId });

        var result = new System.Text.StringBuilder();
        result.AppendLine(_localizer["InventoryAvailability", productName].Value);
        result.AppendLine(_localizer["ProductId", productId].Value);
        result.AppendLine();

        if (!totalStock.HasValue || totalStock.Value == 0)
        {
            result.AppendLine(_localizer["OutOfStock"].Value);
            result.AppendLine(_localizer["OutOfStockMessage"].Value);
        }
        else
        {
            result.AppendLine(_localizer["InStock", totalStock.Value].Value);
        }

        return result.ToString();
    }

    public async Task<string> GetProductsWithPromotionDataAsync(
        string promotionType,
        int? categoryId = null,
        int? subcategoryId = null,
        int topN = 20)
    {
        using var connection = await GetConnectionAsync();

        // Ordering strategy based on promotion type
        // Clearance / Excess Inventory: high stock, low recent sales
        // Volume Discount: high recent sales (popular items)
        // Others: ordered by name, optionally filtered by category/subcategory
        var isExcessInventory = promotionType.Equals("Clearance", StringComparison.OrdinalIgnoreCase)
            || promotionType.Equals("Excess Inventory", StringComparison.OrdinalIgnoreCase);
        var isVolumeDiscount = promotionType.Equals("Volume Discount", StringComparison.OrdinalIgnoreCase);

        var categoryFilter = subcategoryId.HasValue
            ? "AND p.ProductSubcategoryID = @SubcategoryId"
            : categoryId.HasValue
                ? "AND ps.ProductCategoryID = @CategoryId"
                : "";

        var orderBy = isExcessInventory
            ? "ORDER BY TotalInventory DESC, RecentSalesCount ASC"
            : isVolumeDiscount
                ? "ORDER BY RecentSalesCount DESC, TotalInventory ASC"
                : "ORDER BY p.Name ASC";

        var sql = $@"
            SELECT TOP (@TopN)
                p.ProductID,
                p.Name AS ProductName,
                p.ListPrice,
                p.StandardCost,
                pc.Name AS CategoryName,
                ps.Name AS SubcategoryName,
                ISNULL(inv.TotalInventory, 0) AS TotalInventory,
                ISNULL(sales.RecentSalesCount, 0) AS RecentSalesCount,
                ISNULL(sales.RecentRevenue, 0) AS RecentRevenue,
                ISNULL(discounts.ActiveDiscounts, 0) AS ActiveDiscounts
            FROM Production.Product p
            LEFT JOIN Production.ProductSubcategory ps ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON ps.ProductCategoryID = pc.ProductCategoryID
            LEFT JOIN (
                SELECT pi.ProductID, SUM(pi.Quantity) AS TotalInventory
                FROM Production.ProductInventory pi
                INNER JOIN Production.Location l ON pi.LocationID = l.LocationID
                WHERE l.Name LIKE 'Finished Goods%'
                GROUP BY pi.ProductID
            ) inv ON p.ProductID = inv.ProductID
            LEFT JOIN (
                SELECT sod.ProductID,
                       COUNT(DISTINCT sod.SalesOrderID) AS RecentSalesCount,
                       SUM(sod.LineTotal) AS RecentRevenue
                FROM Sales.SalesOrderDetail sod
                INNER JOIN Sales.SalesOrderHeader soh ON sod.SalesOrderID = soh.SalesOrderID
                WHERE soh.OrderDate >= DATEADD(DAY, -90, GETDATE())
                GROUP BY sod.ProductID
            ) sales ON p.ProductID = sales.ProductID
            LEFT JOIN (
                SELECT sop.ProductID, COUNT(*) AS ActiveDiscounts
                FROM Sales.SpecialOfferProduct sop
                INNER JOIN Sales.SpecialOffer so ON sop.SpecialOfferID = so.SpecialOfferID
                WHERE so.EndDate >= GETDATE() AND so.DiscountPct > 0
                GROUP BY sop.ProductID
            ) discounts ON p.ProductID = discounts.ProductID
            WHERE p.FinishedGoodsFlag = 1
              AND p.ListPrice > 0
              {categoryFilter}
            {orderBy}";

        var products = await connection.QueryAsync(sql, new
        {
            TopN = topN,
            CategoryId = categoryId,
            SubcategoryId = subcategoryId
        });

        var productList = products.ToList();

        if (!productList.Any())
        {
            return "No products found matching the specified criteria.";
        }

        var result = new System.Text.StringBuilder();
        result.AppendLine($"Products suitable for '{promotionType}' promotion ({productList.Count} results):");
        result.AppendLine();

        foreach (var p in productList)
        {
            result.AppendLine($"ProductID: {p.ProductID} | {p.ProductName}");
            result.AppendLine($"  Category: {p.CategoryName ?? "N/A"} > {p.SubcategoryName ?? "N/A"}");
            result.AppendLine($"  List Price: ${p.ListPrice:N2}");
            result.AppendLine($"  Standard Cost: ${p.StandardCost:N2}");
            result.AppendLine($"  Gross Margin at List Price: {(p.ListPrice > 0 ? ((p.ListPrice - p.StandardCost) / p.ListPrice * 100) : 0):N1}%");
            result.AppendLine($"  Inventory (Finished Goods): {p.TotalInventory} units");
            result.AppendLine($"  Sales last 90 days: {p.RecentSalesCount} orders | Revenue: ${p.RecentRevenue:N2}");
            result.AppendLine($"  Active discounts: {p.ActiveDiscounts}");
            result.AppendLine();
        }

        return result.ToString();
    }

    private static readonly HashSet<string> SupportedCultures = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ar", "en", "es", "fr", "he", "th", "zh-cht",
        "en-gb", "en-ca", "en-au", "ja", "ko", "de"
    };

    /// <summary>
    /// Get a compact view of all product categories, subcategories, and in-stock products
    /// suitable for powering the AI order generation wizard.
    /// </summary>
    public async Task<string> GetCategoriesWithProductsAsync(int maxProductsPerSubcategory = 10)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT
                pc.ProductCategoryID,
                pc.Name AS CategoryName,
                ps.ProductSubcategoryID,
                ps.Name AS SubcategoryName,
                p.ProductID,
                p.Name AS ProductName,
                p.ListPrice,
                p.Color,
                p.Size,
                ISNULL((
                    SELECT SUM(pi2.Quantity)
                    FROM Production.ProductInventory pi2
                    INNER JOIN Production.Location l2 ON pi2.LocationID = l2.LocationID
                    WHERE pi2.ProductID = p.ProductID
                      AND l2.Name LIKE 'Finished Goods%'
                ), 0) AS StockQty,
                ROW_NUMBER() OVER (PARTITION BY ps.ProductSubcategoryID ORDER BY p.ListPrice DESC) AS rn
            FROM Production.ProductCategory pc
            INNER JOIN Production.ProductSubcategory ps ON ps.ProductCategoryID = pc.ProductCategoryID
            INNER JOIN Production.Product p ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            WHERE p.FinishedGoodsFlag = 1 AND p.ListPrice > 0";

        var rows = await connection.QueryAsync(sql, new { MaxProducts = maxProductsPerSubcategory });

        // Group into hierarchy
        var categories = new Dictionary<int, (string Name, Dictionary<int, (string Name, List<string> Products)> Subs)>();

        foreach (var row in rows)
        {
            if ((int)row.rn > maxProductsPerSubcategory) continue;

            int catId = (int)row.ProductCategoryID;
            int subId = (int)row.ProductSubcategoryID;
            int stock = (int)row.StockQty;

            if (stock == 0) continue; // skip out-of-stock

            if (!categories.ContainsKey(catId))
                categories[catId] = ((string)row.CategoryName, new Dictionary<int, (string, List<string>)>());

            var (_, subs) = categories[catId];
            if (!subs.ContainsKey(subId))
                subs[subId] = ((string)row.SubcategoryName, new List<string>());

            var (_, products) = subs[subId];
            var color = string.IsNullOrEmpty((string?)row.Color) ? "" : $" ({row.Color})";
            var size = string.IsNullOrEmpty((string?)row.Size) ? "" : $" [{row.Size}]";
            products.Add($"  ProductID={row.ProductID}: {row.ProductName}{color}{size} — ${row.ListPrice:N2} — Stock:{stock}");
        }

        var sb = new System.Text.StringBuilder();
        sb.AppendLine("AdventureWorks Product Catalogue (in-stock finished goods only):");
        sb.AppendLine();

        foreach (var (catId, (catName, subs)) in categories.OrderBy(c => c.Value.Name))
        {
            sb.AppendLine($"CATEGORY: {catName} (ID={catId})");
            foreach (var (subId, (subName, products)) in subs.OrderBy(s => s.Value.Name))
            {
                sb.AppendLine($"  Subcategory: {subName} (ID={subId})");
                foreach (var p in products)
                    sb.AppendLine(p);
            }
            sb.AppendLine();
        }

        return sb.ToString();
    }

    /// <summary>
    /// Get currently active special offer promotions with associated products.
    /// </summary>
    public async Task<string> GetActivePromotionsAsync()
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT
                so.SpecialOfferID,
                so.Description,
                so.DiscountPct,
                so.Type,
                so.Category,
                so.StartDate,
                so.EndDate,
                so.MinQty,
                so.MaxQty,
                p.ProductID,
                p.Name AS ProductName,
                p.ListPrice
            FROM Sales.SpecialOffer so
            INNER JOIN Sales.SpecialOfferProduct sop ON so.SpecialOfferID = sop.SpecialOfferID
            INNER JOIN Production.Product p ON sop.ProductID = p.ProductID
            WHERE so.EndDate >= GETDATE()
              AND so.StartDate <= GETDATE()
              AND so.DiscountPct > 0
              AND so.CultureID = 'en    '
              AND p.FinishedGoodsFlag = 1
            ORDER BY so.DiscountPct DESC, so.SpecialOfferID, p.ProductID";

        var rows = await connection.QueryAsync(sql);

        var offers = new Dictionary<int, (string Desc, decimal Pct, string Type, DateTime End, int MinQty, List<string> Products)>();

        foreach (var row in rows)
        {
            int offerId = (int)row.SpecialOfferID;
            if (!offers.ContainsKey(offerId))
            {
                offers[offerId] = (
                    (string)row.Description,
                    (decimal)row.DiscountPct,
                    (string)row.Type,
                    (DateTime)row.EndDate,
                    (int)row.MinQty,
                    new List<string>()
                );
            }
            var (_, _, _, _, _, products) = offers[offerId];
            products.Add($"    ProductID={row.ProductID}: {row.ProductName} — ${row.ListPrice:N2}");
        }

        if (!offers.Any())
            return "No active promotions currently available.";

        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"Active Promotions (as of {DateTime.UtcNow:yyyy-MM-dd}):");
        sb.AppendLine();

        foreach (var (offerId, (desc, pct, type, end, minQty, products)) in offers)
        {
            sb.AppendLine($"Promotion ID={offerId}: {desc}");
            sb.AppendLine($"  Type: {type} | Discount: {pct:P0} | Expires: {end:yyyy-MM-dd} | Min Qty: {minQty}");
            sb.AppendLine($"  Eligible products ({products.Count}):");
            foreach (var p in products.Take(10))
                sb.AppendLine(p);
            if (products.Count > 10)
                sb.AppendLine($"    ... and {products.Count - 10} more");
            sb.AppendLine();
        }

        return sb.ToString();
    }

    public async Task<string> GetTopSellingProductsAsync(int topN = 10, int? dateRangeMonths = null)
    {
        topN = Math.Max(1, Math.Min(50, topN));

        using var connection = await GetConnectionAsync();

        string sql;

        if (dateRangeMonths.HasValue && dateRangeMonths.Value > 0)
        {
            // Aggregate SalesOrderDetail filtered by date via SalesOrderHeader.
            // Use NOLOCK to avoid shared-lock contention and a pre-aggregating subquery
            // so the outer join works on a small result set.
            // MIN(pc.Name) deduplicates when ProductCategory has multi-language rows.
            sql = @"
                SELECT TOP (@TopN)
                    agg.ProductID,
                    p.Name          AS ProductName,
                    MIN(pc.Name)    AS CategoryName,
                    agg.TotalQtySold,
                    agg.TotalOrders,
                    agg.TotalRevenue
                FROM (
                    SELECT sod.ProductID,
                           SUM(sod.OrderQty)             AS TotalQtySold,
                           COUNT(DISTINCT sod.SalesOrderID) AS TotalOrders,
                           SUM(sod.LineTotal)             AS TotalRevenue
                    FROM   Sales.SalesOrderDetail sod WITH (NOLOCK)
                    INNER JOIN Sales.SalesOrderHeader soh WITH (NOLOCK)
                           ON sod.SalesOrderID = soh.SalesOrderID
                    WHERE  soh.OrderDate >= DATEADD(MONTH, -@DateRangeMonths, GETDATE())
                    GROUP BY sod.ProductID
                ) AS agg
                INNER JOIN Production.Product p WITH (NOLOCK)
                        ON agg.ProductID = p.ProductID
                LEFT  JOIN Production.ProductSubcategory ps WITH (NOLOCK)
                        ON p.ProductSubcategoryID = ps.ProductSubcategoryID
                LEFT  JOIN Production.ProductCategory pc WITH (NOLOCK)
                        ON ps.ProductCategoryID = pc.ProductCategoryID
                WHERE p.FinishedGoodsFlag = 1
                GROUP BY agg.ProductID, p.Name, agg.TotalQtySold, agg.TotalOrders, agg.TotalRevenue
                ORDER BY agg.TotalRevenue DESC";
        }
        else
        {
            // All-time ranking — pre-aggregate SalesOrderDetail first (single-table scan),
            // then join the small result set to Product/Category.  NOLOCK avoids lock waits.
            // MIN(pc.Name) deduplicates when ProductCategory has multi-language rows.
            sql = @"
                SELECT TOP (@TopN)
                    agg.ProductID,
                    p.Name          AS ProductName,
                    MIN(pc.Name)    AS CategoryName,
                    agg.TotalQtySold,
                    agg.TotalOrders,
                    agg.TotalRevenue
                FROM (
                    SELECT ProductID,
                           SUM(OrderQty)              AS TotalQtySold,
                           COUNT(DISTINCT SalesOrderID) AS TotalOrders,
                           SUM(LineTotal)              AS TotalRevenue
                    FROM   Sales.SalesOrderDetail WITH (NOLOCK)
                    GROUP BY ProductID
                ) AS agg
                INNER JOIN Production.Product p WITH (NOLOCK)
                        ON agg.ProductID = p.ProductID
                LEFT  JOIN Production.ProductSubcategory ps WITH (NOLOCK)
                        ON p.ProductSubcategoryID = ps.ProductSubcategoryID
                LEFT  JOIN Production.ProductCategory pc WITH (NOLOCK)
                        ON ps.ProductCategoryID = pc.ProductCategoryID
                WHERE p.FinishedGoodsFlag = 1
                GROUP BY agg.ProductID, p.Name, agg.TotalQtySold, agg.TotalOrders, agg.TotalRevenue
                ORDER BY agg.TotalRevenue DESC";
        }

        var param = dateRangeMonths.HasValue && dateRangeMonths.Value > 0
            ? (object)new { TopN = topN, DateRangeMonths = dateRangeMonths.Value }
            : new { TopN = topN };

        var rows = await connection.QueryAsync(sql, param, commandTimeout: 120);
        var list = rows.ToList();

        if (!list.Any())
            return "No sales data found for the specified period.";

        var sb = new System.Text.StringBuilder();
        var period = (dateRangeMonths.HasValue && dateRangeMonths.Value > 0)
            ? $"last {dateRangeMonths.Value} month(s)"
            : "all time";
        sb.AppendLine($"Top {list.Count} best-selling products ({period}):");
        sb.AppendLine();

        int rank = 1;
        foreach (var row in list)
        {
            var category = string.IsNullOrEmpty((string?)row.CategoryName) ? "Uncategorized" : (string)row.CategoryName;
            sb.AppendLine($"{rank}. {row.ProductName} (ID: {row.ProductID}) — {category}");
            sb.AppendLine($"   Revenue: ${(decimal)row.TotalRevenue:N2} | Units sold: {(int)row.TotalQtySold:N0} | Orders: {(int)row.TotalOrders:N0}");
            rank++;
        }

        return sb.ToString();
    }

    public async Task<List<ProductSearchResult>> SearchProductsByDescriptionEmbeddingAsync(float[] queryEmbedding, int topN = 10, string cultureId = "en")
    {
        // Validate culture ID
        if (!SupportedCultures.Contains(cultureId))
        {
            throw new ArgumentException($"Unsupported culture '{cultureId}'. Supported cultures: {string.Join(", ", SupportedCultures)}", nameof(cultureId));
        }

        using var connection = await GetConnectionAsync();

        // Use VECTOR_DISTANCE for semantic similarity search with native VECTOR columns
        // Returns products with the most similar descriptions to the query
        // Convert float array to JSON for CAST to VECTOR
        var embeddingJson = JsonSerializer.Serialize(queryEmbedding);

        var sql = @"
            SELECT TOP (@TopN)
                p.ProductID,
                p.Name,
                pd.Description,
                p.ListPrice,
                p.Color,
                p.Size,
                pc.Name AS ProductCategoryName,
                ps.Name AS ProductSubcategoryName,
                VECTOR_DISTANCE('cosine', pd.DescriptionEmbedding, CAST(@QueryEmbedding AS VECTOR(1536))) AS SimilarityScore
            FROM Production.Product p
            INNER JOIN Production.ProductModel pm ON p.ProductModelID = pm.ProductModelID
            INNER JOIN Production.ProductModelProductDescriptionCulture pmpdc 
                ON pm.ProductModelID = pmpdc.ProductModelID
            INNER JOIN Production.ProductDescription pd 
                ON pmpdc.ProductDescriptionID = pd.ProductDescriptionID
            LEFT JOIN Production.ProductSubcategory ps ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON ps.ProductCategoryID = pc.ProductCategoryID
            WHERE p.FinishedGoodsFlag = 1
              AND pd.DescriptionEmbedding IS NOT NULL
              AND pmpdc.CultureID = @CultureId
            ORDER BY VECTOR_DISTANCE('cosine', pd.DescriptionEmbedding, CAST(@QueryEmbedding AS VECTOR(1536)))";

        var results = await connection.QueryAsync<ProductSearchResult>(sql, new
        {
            TopN = topN,
            QueryEmbedding = embeddingJson,
            CultureId = cultureId
        });

        return results.ToList();
    }
}
