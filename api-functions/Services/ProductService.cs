using System.Data;
using Azure.Identity;
using Dapper;
using Microsoft.Data.SqlClient;
using api_functions.Models;

namespace api_functions.Services;

public class ProductService
{
    private readonly string _connectionString;

    public ProductService(string connectionString)
    {
        _connectionString = connectionString;
    }

    private async Task<IDbConnection> GetConnectionAsync()
    {
        var connection = new SqlConnection(_connectionString);
        var credential = new DefaultAzureCredential();
        var token = await credential.GetTokenAsync(new Azure.Core.TokenRequestContext(new[] { "https://database.windows.net/.default" }));
        connection.AccessToken = token.Token;
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

    public async Task UpdateProductAsync(EnhancedProductData enhancedProduct)
    {
        using var connection = await GetConnectionAsync();

        // Update Product table with new color, size, weight if they were missing
        var updateProductSql = @"
            UPDATE Production.Product
            SET 
                Color = COALESCE(@Color, Color),
                Size = COALESCE(@Size, Size),
                SizeUnitMeasureCode = COALESCE(@SizeUnitMeasureCode, SizeUnitMeasureCode),
                Weight = COALESCE(@Weight, Weight),
                WeightUnitMeasureCode = COALESCE(@WeightUnitMeasureCode, WeightUnitMeasureCode),
                ModifiedDate = GETDATE()
            WHERE ProductID = @ProductID";

        await connection.ExecuteAsync(updateProductSql, new
        {
            enhancedProduct.ProductID,
            enhancedProduct.Color,
            enhancedProduct.Size,
            enhancedProduct.SizeUnitMeasureCode,
            enhancedProduct.Weight,
            enhancedProduct.WeightUnitMeasureCode
        });

        // Update ProductDescription table with enhanced description
        if (enhancedProduct.ProductDescriptionID.HasValue)
        {
            var updateDescriptionSql = @"
                UPDATE Production.ProductDescription
                SET 
                    Description = @EnhancedDescription,
                    ModifiedDate = GETDATE()
                WHERE ProductDescriptionID = @ProductDescriptionID";

            await connection.ExecuteAsync(updateDescriptionSql, new
            {
                enhancedProduct.ProductDescriptionID,
                enhancedProduct.EnhancedDescription
            });
        }
    }

    public async Task<List<CultureInfo>> GetSupportedCulturesAsync()
    {
        using var connection = await GetConnectionAsync();

        var sql = "SELECT CultureID, Name FROM Production.Culture WHERE CultureID != 'en'";
        var cultures = await connection.QueryAsync<CultureInfo>(sql);
        return cultures.ToList();
    }

    public async Task<List<TranslationRequest>> GetProductsByModelIdsAsync(List<int> productModelIds)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT DISTINCT
                pm.ProductModelID,
                pd.ProductDescriptionID AS EnglishDescriptionID,
                pd.Description AS EnglishDescription,
                pm.Name AS ProductName
            FROM Production.ProductDescription pd
            INNER JOIN Production.ProductModelProductDescriptionCulture pmpdc 
                ON pd.ProductDescriptionID = pmpdc.ProductDescriptionID
            INNER JOIN Production.ProductModel pm 
                ON pmpdc.ProductModelID = pm.ProductModelID
            WHERE pmpdc.CultureID = 'en'
            AND pm.ProductModelID IN @ProductModelIds
            ORDER BY pm.ProductModelID";

        var products = await connection.QueryAsync<TranslationRequest>(sql, new { ProductModelIds = productModelIds });
        return products.ToList();
    }

    public async Task<List<TranslationRequest>> GetRecentlyEnhancedProductsAsync()
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT DISTINCT
                pm.ProductModelID,
                pd.ProductDescriptionID AS EnglishDescriptionID,
                pd.Description AS EnglishDescription,
                pm.Name AS ProductName
            FROM Production.ProductDescription pd
            INNER JOIN Production.ProductModelProductDescriptionCulture pmpdc 
                ON pd.ProductDescriptionID = pmpdc.ProductDescriptionID
            INNER JOIN Production.ProductModel pm 
                ON pmpdc.ProductModelID = pm.ProductModelID
            WHERE pmpdc.CultureID = 'en'
            AND pd.ModifiedDate > DATEADD(MINUTE, -5, GETDATE())
            ORDER BY pm.ProductModelID";

        var products = await connection.QueryAsync<TranslationRequest>(sql);
        return products.ToList();
    }

    public async Task SaveTranslationsAsync(List<TranslatedDescription> translations)
    {
        using var connection = await GetConnectionAsync();

        foreach (var translation in translations)
        {
            // Check if a description already exists for this ProductModel + Culture
            var existingDescriptionSql = @"
                SELECT pd.ProductDescriptionID
                FROM Production.ProductDescription pd
                INNER JOIN Production.ProductModelProductDescriptionCulture pmpdc
                    ON pd.ProductDescriptionID = pmpdc.ProductDescriptionID
                WHERE pmpdc.ProductModelID = @ProductModelID
                AND pmpdc.CultureID = @CultureID";

            var existingDescriptionId = await connection.QueryFirstOrDefaultAsync<int?>(
                existingDescriptionSql,
                new { translation.ProductModelID, translation.CultureID });

            if (existingDescriptionId.HasValue)
            {
                // Update existing description
                var updateSql = @"
                    UPDATE Production.ProductDescription
                    SET Description = @TranslatedText,
                        ModifiedDate = GETDATE()
                    WHERE ProductDescriptionID = @ProductDescriptionID";

                await connection.ExecuteAsync(updateSql, new
                {
                    ProductDescriptionID = existingDescriptionId.Value,
                    translation.TranslatedText
                });
            }
            else
            {
                // Create new description and link it
                var insertDescriptionSql = @"
                    INSERT INTO Production.ProductDescription (Description, ModifiedDate)
                    VALUES (@TranslatedText, GETDATE());
                    SELECT CAST(SCOPE_IDENTITY() as int)";

                var newDescriptionId = await connection.QuerySingleAsync<int>(
                    insertDescriptionSql,
                    new { translation.TranslatedText });

                // Link the new description to the ProductModel and Culture
                var insertLinkSql = @"
                    INSERT INTO Production.ProductModelProductDescriptionCulture 
                    (ProductModelID, ProductDescriptionID, CultureID, ModifiedDate)
                    VALUES (@ProductModelID, @ProductDescriptionID, @CultureID, GETDATE())";

                await connection.ExecuteAsync(insertLinkSql, new
                {
                    translation.ProductModelID,
                    ProductDescriptionID = newDescriptionId,
                    translation.CultureID
                });
            }
        }
    }

    public async Task<List<ProductDescriptionData>> GetProductDescriptionsForEmbeddingAsync()
    {
        using var connection = await GetConnectionAsync();

        // Get all product descriptions (all languages) with variant information
        // Include all product variants (colors, sizes, styles) for richer semantic search
        var sql = @"
            SELECT 
                pd.ProductDescriptionID,
                pd.Description,
                pmx.CultureID,
                pmx.ProductModelID,
                -- Aggregate all variant information from products in this model
                STRING_AGG(DISTINCT p.Name, ', ') WITHIN GROUP (ORDER BY p.Name) AS ProductNames,
                STRING_AGG(DISTINCT p.Color, ', ') WITHIN GROUP (ORDER BY p.Color) AS Colors,
                STRING_AGG(DISTINCT CASE WHEN p.Size IS NOT NULL THEN p.Size + COALESCE(' ' + p.SizeUnitMeasureCode, '') END, ', ') WITHIN GROUP (ORDER BY p.Size) AS Sizes,
                STRING_AGG(DISTINCT p.Style, ', ') WITHIN GROUP (ORDER BY p.Style) AS Styles,
                STRING_AGG(DISTINCT p.Class, ', ') WITHIN GROUP (ORDER BY p.Class) AS Classes,
                MAX(pc.Name) AS ProductCategoryName,
                MAX(ps.Name) AS ProductSubcategoryName
            FROM Production.ProductDescription pd
            INNER JOIN Production.ProductModelProductDescriptionCulture pmx
                ON pd.ProductDescriptionID = pmx.ProductDescriptionID
            LEFT JOIN Production.Product p ON p.ProductModelID = pmx.ProductModelID
            LEFT JOIN Production.ProductSubcategory ps ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON ps.ProductCategoryID = pc.ProductCategoryID
            WHERE pd.DescriptionEmbedding IS NULL
              AND p.FinishedGoodsFlag = 1
            GROUP BY pd.ProductDescriptionID, pd.Description, pmx.CultureID, pmx.ProductModelID
            ORDER BY pmx.ProductModelID, pmx.CultureID";

        var descriptions = await connection.QueryAsync<ProductDescriptionData>(sql);
        return descriptions.ToList();
    }

    public async Task SaveEmbeddingAsync(ProductDescriptionEmbedding embedding)
    {
        using var connection = await GetConnectionAsync();

        // Save embedding to ProductDescription table
        // Embeddings stored per language for multi-language semantic search
        // Convert float array to JSON array format for VECTOR column
        var embeddingJson = System.Text.Json.JsonSerializer.Serialize(embedding.Embedding);

        var updateDescriptionSql = @"
            UPDATE Production.ProductDescription
            SET 
                DescriptionEmbedding = CAST(@EmbeddingJson AS VECTOR(1536)),
                ModifiedDate = GETDATE()
            WHERE ProductDescriptionID = @ProductDescriptionID";

        await connection.ExecuteAsync(updateDescriptionSql, new
        {
            embedding.ProductDescriptionID,
            EmbeddingJson = embeddingJson
        });
    }

    public async Task<List<ProductImageData>> GetProductsForImageGenerationAsync()
    {
        using var connection = await GetConnectionAsync();

        // Get products with less than 4 photos (idempotent)
        // Using English descriptions for image generation
        var sql = @"
            SELECT 
                p.ProductID,
                p.Name,
                pc.Name AS ProductCategoryName,
                pd.Description,
                COUNT(DISTINCT ppp.ProductPhotoID) AS ExistingPhotoCount
            FROM Production.Product p
            LEFT JOIN Production.ProductSubcategory ps ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON ps.ProductCategoryID = pc.ProductCategoryID
            LEFT JOIN Production.ProductModel pm ON p.ProductModelID = pm.ProductModelID
            LEFT JOIN Production.ProductModelProductDescriptionCulture pmx 
                ON pm.ProductModelID = pmx.ProductModelID AND pmx.CultureID = 'en'
            LEFT JOIN Production.ProductDescription pd ON pmx.ProductDescriptionID = pd.ProductDescriptionID
            LEFT JOIN Production.ProductProductPhoto ppp ON p.ProductID = ppp.ProductID
            WHERE p.FinishedGoodsFlag = 1
            GROUP BY p.ProductID, p.Name, pc.Name, pd.Description
            HAVING COUNT(DISTINCT ppp.ProductPhotoID) < 4
            ORDER BY p.ProductID";

        var products = await connection.QueryAsync<ProductImageData>(sql);
        return products.ToList();
    }

    public async Task<int> SaveProductPhotoAsync(ProductPhotoData photo)
    {
        using var connection = await GetConnectionAsync();

        // Insert into ProductPhoto table
        var insertPhotoSql = @"
            INSERT INTO Production.ProductPhoto 
                (LargePhoto, LargePhotoFileName, ModifiedDate)
            OUTPUT INSERTED.ProductPhotoID
            VALUES 
                (@ImageData, @FileName, GETDATE())";

        var productPhotoId = await connection.ExecuteScalarAsync<int>(insertPhotoSql, new
        {
            photo.ImageData,
            photo.FileName
        });

        // Link photo to product in ProductProductPhoto table
        var insertLinkSql = @"
            INSERT INTO Production.ProductProductPhoto 
                (ProductID, ProductPhotoID, [Primary], ModifiedDate)
            VALUES 
                (@ProductID, @ProductPhotoID, @IsPrimary, GETDATE())";

        await connection.ExecuteAsync(insertLinkSql, new
        {
            photo.ProductID,
            ProductPhotoID = productPhotoId,
            IsPrimary = photo.IsPrimary
        });

        return productPhotoId;
    }

    public async Task<ProductPhotoThumbnailData?> GetProductPhotoAsync(int productPhotoId)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT 
                ProductPhotoID,
                LargePhoto,
                LargePhotoFileName,
                ThumbNailPhoto
            FROM Production.ProductPhoto
            WHERE ProductPhotoID = @ProductPhotoID";

        var photo = await connection.QueryFirstOrDefaultAsync<ProductPhotoThumbnailData>(sql, new
        {
            ProductPhotoID = productPhotoId
        });

        return photo;
    }

    public async Task<List<ProductPhotoThumbnailData>> GetPhotosNeedingThumbnailsAsync()
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT 
                ProductPhotoID,
                LargePhoto,
                LargePhotoFileName
            FROM Production.ProductPhoto
            WHERE LargePhoto IS NOT NULL 
            AND (ThumbNailPhoto IS NULL OR DATALENGTH(ThumbNailPhoto) = 0)
            ORDER BY ProductPhotoID";

        var photos = await connection.QueryAsync<ProductPhotoThumbnailData>(sql);
        return photos.ToList();
    }

    public async Task<List<ProductPhotoThumbnailData>> GetProductPhotosWithoutThumbnailsAsync()
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT 
                ProductPhotoID,
                LargePhoto,
                LargePhotoFileName
            FROM Production.ProductPhoto
            WHERE LargePhoto IS NOT NULL 
            AND (
                ThumbNailPhoto IS NULL 
                OR DATALENGTH(ThumbNailPhoto) = 0
                OR ThumbnailPhotoFileName IS NULL
            )
            ORDER BY ProductPhotoID";

        var photos = await connection.QueryAsync<ProductPhotoThumbnailData>(sql);
        return photos.ToList();
    }

    public async Task SaveProductThumbnailAsync(int productPhotoId, byte[] thumbnailData, string? thumbnailFileName = null)
    {
        using var connection = await GetConnectionAsync();

        // Update thumbnail data and filename without touching ModifiedDate
        var updateSql = @"
            UPDATE Production.ProductPhoto
            SET ThumbNailPhoto = @ThumbnailData,
                ThumbnailPhotoFileName = @ThumbnailFileName
            WHERE ProductPhotoID = @ProductPhotoID";

        await connection.ExecuteAsync(updateSql, new
        {
            ProductPhotoID = productPhotoId,
            ThumbnailData = thumbnailData,
            ThumbnailFileName = thumbnailFileName
        });
    }

    public async Task<List<SemanticSearchResult>> SearchProductsByDescriptionEmbeddingAsync(float[] queryEmbedding, int topN = 20)
    {
        using var connection = await GetConnectionAsync();

        // Use VECTOR_DISTANCE for semantic similarity search with native VECTOR columns
        // Returns products with the most similar descriptions to the query
        // Convert float array to JSON for CAST to VECTOR
        var embeddingJson = System.Text.Json.JsonSerializer.Serialize(queryEmbedding);

        var sql = @"
            SELECT TOP (@TopN)
                p.ProductID,
                p.Name,
                pd.Description,
                p.ListPrice,
                p.Color,
                VECTOR_DISTANCE('cosine', pd.DescriptionEmbedding, CAST(@QueryEmbedding AS VECTOR(1536))) AS SimilarityScore,
                'Description' AS MatchSource,
                pd.Description AS MatchText
            FROM Production.Product p
            INNER JOIN Production.ProductModel pm ON p.ProductModelID = pm.ProductModelID
            INNER JOIN Production.ProductModelProductDescriptionCulture pmpdc 
                ON pm.ProductModelID = pmpdc.ProductModelID
            INNER JOIN Production.ProductDescription pd 
                ON pmpdc.ProductDescriptionID = pd.ProductDescriptionID
            WHERE p.FinishedGoodsFlag = 1
              AND pd.DescriptionEmbedding IS NOT NULL
              AND pmpdc.CultureID = 'en'
            ORDER BY VECTOR_DISTANCE('cosine', pd.DescriptionEmbedding, CAST(@QueryEmbedding AS VECTOR(1536)))";

        var results = await connection.QueryAsync<SemanticSearchResult>(sql, new
        {
            TopN = topN,
            QueryEmbedding = embeddingJson
        });

        return results.ToList();
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
