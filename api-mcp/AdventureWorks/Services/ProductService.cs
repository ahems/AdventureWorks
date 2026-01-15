using System.Data;
using System.Text.Json;
using System.Globalization;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Localization;
using AdventureWorks.Models;

namespace AdventureWorks.Services;

public class ProductService
{
    private readonly string _connectionString;
    private readonly IStringLocalizer<ProductService> _localizer;

    public ProductService(string connectionString, IStringLocalizer<ProductService> localizer)
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
                p.StandardCost,
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
            return _localizer["ProductNotFound", productId];
        }

        // Get inventory across all locations (only for finished goods)
        var inventory = await connection.QueryAsync<dynamic>(@"
            SELECT 
                pi.LocationID,
                l.Name as LocationName,
                pi.Quantity,
                pi.Shelf,
                pi.Bin
            FROM Production.ProductInventory pi
            INNER JOIN Production.Product p ON pi.ProductID = p.ProductID
            INNER JOIN Production.Location l ON pi.LocationID = l.LocationID
            WHERE pi.ProductID = @ProductId
            AND p.FinishedGoodsFlag = 1
            AND pi.Quantity > 0
            ORDER BY pi.Quantity DESC",
            new { ProductId = productId });

        var inventoryList = inventory.ToList();

        var result = new System.Text.StringBuilder();
        result.AppendLine(_localizer["InventoryAvailability", productName]);
        result.AppendLine(_localizer["ProductId", productId]);
        result.AppendLine();

        if (!inventoryList.Any())
        {
            result.AppendLine(_localizer["OutOfStock"]);
            result.AppendLine(_localizer["OutOfStockMessage"]);
        }
        else
        {
            var totalStock = inventoryList.Sum(i => (int)i.Quantity);
            result.AppendLine(_localizer["InStock", totalStock]);
            result.AppendLine();
            result.AppendLine(_localizer["AvailableAt"]);

            foreach (var location in inventoryList)
            {
                result.AppendLine($"  {_localizer["LocationIcon", location.LocationName]}");
                result.AppendLine($"     {_localizer["Quantity", location.Quantity]}");
                result.AppendLine($"     {_localizer["Location", location.Shelf, location.Bin]}");
                result.AppendLine();
            }

            // Suggest best location (highest stock)
            var bestLocation = inventoryList.First();
            result.AppendLine(_localizer["Recommended", bestLocation.LocationName, bestLocation.Quantity]);
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
