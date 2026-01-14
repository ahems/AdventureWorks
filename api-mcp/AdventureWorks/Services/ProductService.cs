using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;
using AdventureWorks.Models;

namespace AdventureWorks.Services;

public class ProductService
{
    private readonly string _connectionString;

    public ProductService(string connectionString)
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

    public async Task<string> CheckInventoryAvailabilityAsync(int productId)
    {
        using var connection = await GetConnectionAsync();

        // Get product name
        var productName = await connection.QueryFirstOrDefaultAsync<string>(
            "SELECT Name FROM Production.Product WHERE ProductID = @ProductId",
            new { ProductId = productId });

        if (string.IsNullOrEmpty(productName))
        {
            return $"Product #{productId} not found.";
        }

        // Get inventory across all locations
        var inventory = await connection.QueryAsync<dynamic>(@"
            SELECT 
                pi.LocationID,
                l.Name as LocationName,
                pi.Quantity,
                pi.Shelf,
                pi.Bin
            FROM Production.ProductInventory pi
            INNER JOIN Production.Location l ON pi.LocationID = l.LocationID
            WHERE pi.ProductID = @ProductId
            AND pi.Quantity > 0
            ORDER BY pi.Quantity DESC",
            new { ProductId = productId });

        var inventoryList = inventory.ToList();

        var result = new System.Text.StringBuilder();
        result.AppendLine($"📦 Inventory Availability for: {productName}");
        result.AppendLine($"Product ID: {productId}");
        result.AppendLine();

        if (!inventoryList.Any())
        {
            result.AppendLine("❌ OUT OF STOCK at all locations");
            result.AppendLine("This product is currently unavailable. Please check back later or contact support.");
        }
        else
        {
            var totalStock = inventoryList.Sum(i => (int)i.Quantity);
            result.AppendLine($"✅ IN STOCK - Total Available: {totalStock} units");
            result.AppendLine();
            result.AppendLine("Available at:");

            foreach (var location in inventoryList)
            {
                result.AppendLine($"  📍 {location.LocationName}");
                result.AppendLine($"     Quantity: {location.Quantity} units");
                result.AppendLine($"     Location: Shelf {location.Shelf}, Bin {location.Bin}");
                result.AppendLine();
            }

            // Suggest best location (highest stock)
            var bestLocation = inventoryList.First();
            result.AppendLine($"💡 Recommended: Order from {bestLocation.LocationName} ({bestLocation.Quantity} units available)");
        }

        return result.ToString();
    }
}
