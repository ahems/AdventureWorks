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
