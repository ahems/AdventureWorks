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
                pm.Name AS ProductName,
                MIN(p.ProductID) AS ProductID
            FROM Production.ProductDescription pd
            INNER JOIN Production.ProductModelProductDescriptionCulture pmpdc 
                ON pd.ProductDescriptionID = pmpdc.ProductDescriptionID
            INNER JOIN Production.ProductModel pm 
                ON pmpdc.ProductModelID = pm.ProductModelID
            LEFT JOIN Production.Product p ON p.ProductModelID = pm.ProductModelID
            WHERE pmpdc.CultureID = 'en'
            AND pm.ProductModelID IN @ProductModelIds
            GROUP BY pm.ProductModelID, pd.ProductDescriptionID, pd.Description, pm.Name
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

    public async Task<List<SavedDescriptionResult>> SaveTranslationsAsync(List<TranslatedDescription> translations)
    {
        using var connection = await GetConnectionAsync();
        var results = new List<SavedDescriptionResult>();

        foreach (var translation in translations)
        {
            // Guard: if the ProductModel was deleted while translations were in-flight, skip.
            var modelExists = await connection.QueryFirstOrDefaultAsync<bool>(
                "SELECT CAST(1 AS BIT) FROM Production.ProductModel WHERE ProductModelID = @ProductModelID",
                new { translation.ProductModelID });

            if (!modelExists)
                continue;

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

            int savedId;
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
                savedId = existingDescriptionId.Value;
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
                savedId = newDescriptionId;
            }

            results.Add(new SavedDescriptionResult
            {
                ProductDescriptionID = savedId,
                Description = translation.TranslatedText,
                CultureID = translation.CultureID,
                ProductModelID = translation.ProductModelID,
            });
        }

        return results;
    }

    public async Task<List<ProductDescriptionData>> GetProductDescriptionsForEmbeddingAsync()
    {
        using var connection = await GetConnectionAsync();

        // Get all product descriptions (all languages) with variant information
        // Include all product variants (colors, sizes, styles) for richer semantic search  
        // Note: Using simpler aggregation without DISTINCT for SQL Server compatibility
        var sql = @"
            SELECT 
                pd.ProductDescriptionID,
                pd.Description,
                pmx.CultureID,
                pmx.ProductModelID,
                -- Aggregate all variant information from products in this model
                STRING_AGG(p.Name, ', ') AS ProductNames,
                STRING_AGG(p.Color, ', ') AS Colors,
                STRING_AGG(CASE WHEN p.Size IS NOT NULL THEN p.Size + COALESCE(' ' + p.SizeUnitMeasureCode, '') END, ', ') AS Sizes,
                STRING_AGG(p.Style, ', ') AS Styles,
                STRING_AGG(p.Class, ', ') AS Classes,
                MAX(pc.Name) AS ProductCategoryName,
                MAX(ps.Name) AS ProductSubcategoryName
            FROM Production.ProductDescription pd
            INNER JOIN Production.ProductModelProductDescriptionCulture pmx
                ON pd.ProductDescriptionID = pmx.ProductDescriptionID
            LEFT JOIN Production.Product p ON p.ProductModelID = pmx.ProductModelID
            LEFT JOIN Production.ProductSubcategory ps ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON ps.ProductCategoryID = pc.ProductCategoryID
            WHERE pd.DescriptionEmbedding IS NULL
              AND (p.FinishedGoodsFlag = 1 OR p.FinishedGoodsFlag IS NULL)
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

        // Get products with less than 4 photos (5 for Universal style) — idempotent
        // Using English descriptions for image generation
        var sql = @"
            SELECT 
                p.ProductID,
                p.Name,
                pc.Name AS ProductCategoryName,
                ps.Name AS ProductSubcategoryName,
                pd.Description,
                p.Color,
                p.ProductLine,
                p.Style,
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
            GROUP BY p.ProductID, p.Name, pc.Name, ps.Name, pd.Description, p.Color, p.ProductLine, p.Style
            HAVING COUNT(DISTINCT ppp.ProductPhotoID) < CASE WHEN p.Style = 'U' THEN 5 ELSE 4 END
            ORDER BY p.ProductID";

        var products = await connection.QueryAsync<ProductImageData>(sql);
        return products.ToList();
    }

    public async Task<ProductImageData?> GetProductForImageGenerationAsync(int productId)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT 
                p.ProductID,
                p.Name,
                p.ProductModelID,
                pc.Name AS ProductCategoryName,
                ps.Name AS ProductSubcategoryName,
                pd.Description,
                p.Color,
                p.ProductLine,
                p.Style,
                COUNT(DISTINCT ppp.ProductPhotoID) AS ExistingPhotoCount
            FROM Production.Product p
            LEFT JOIN Production.ProductSubcategory ps ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON ps.ProductCategoryID = pc.ProductCategoryID
            LEFT JOIN Production.ProductModel pm ON p.ProductModelID = pm.ProductModelID
            LEFT JOIN Production.ProductModelProductDescriptionCulture pmx 
                ON pm.ProductModelID = pmx.ProductModelID AND pmx.CultureID = 'en'
            LEFT JOIN Production.ProductDescription pd ON pmx.ProductDescriptionID = pd.ProductDescriptionID
            LEFT JOIN Production.ProductProductPhoto ppp ON p.ProductID = ppp.ProductID
            WHERE p.FinishedGoodsFlag = 1 AND p.ProductID = @ProductID
            GROUP BY p.ProductID, p.Name, p.ProductModelID, pc.Name, ps.Name, pd.Description, p.Color, p.ProductLine, p.Style";

        return await connection.QueryFirstOrDefaultAsync<ProductImageData>(sql, new { ProductID = productId });
    }

    /// <summary>
    /// Returns photo IDs from a sibling product in the same model that shares the same
    /// Color and Style (the visually-significant dimensions). Returns empty if none found.
    /// </summary>
    public async Task<List<int>> GetSiblingPhotoIdsAsync(int productId, int productModelId, string? color, string? style)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT DISTINCT ppp.ProductPhotoID
            FROM Production.ProductProductPhoto ppp
            INNER JOIN Production.Product p ON p.ProductID = ppp.ProductID
            WHERE p.ProductModelID = @ProductModelID
              AND p.ProductID <> @ProductID
              AND ((@Color IS NULL AND p.Color IS NULL) OR p.Color = @Color)
              AND ((@Style IS NULL AND p.Style IS NULL) OR p.Style = @Style)";

        var ids = await connection.QueryAsync<int>(sql, new
        {
            ProductModelID = productModelId,
            ProductID = productId,
            Color = color,
            Style = style
        });
        return ids.AsList();
    }

    /// <summary>
    /// Links existing photos (already in ProductPhoto) to a product that doesn't have them yet.
    /// Silently skips photos already linked.
    /// </summary>
    public async Task LinkPhotosToProductAsync(int productId, IEnumerable<int> photoIds)
    {
        using var connection = await GetConnectionAsync();

        // Guard on both product existence and duplicate to survive concurrent deletes.
        var sql = @"
            IF EXISTS (SELECT 1 FROM Production.Product WHERE ProductID = @ProductID)
              AND NOT EXISTS (SELECT 1 FROM Production.ProductProductPhoto WHERE ProductID = @ProductID AND ProductPhotoID = @ProductPhotoID)
            BEGIN
                INSERT INTO Production.ProductProductPhoto (ProductID, ProductPhotoID, [Primary], ModifiedDate)
                VALUES (@ProductID, @ProductPhotoID, 0, GETDATE())
            END";

        foreach (var photoId in photoIds)
        {
            await connection.ExecuteAsync(sql, new { ProductID = productId, ProductPhotoID = photoId });
        }
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

        // Link photo to product — guarded so a concurrent delete doesn't cause an FK violation.
        var insertLinkSql = @"
            IF EXISTS (SELECT 1 FROM Production.Product WHERE ProductID = @ProductID)
            BEGIN
                INSERT INTO Production.ProductProductPhoto 
                    (ProductID, ProductPhotoID, [Primary], ModifiedDate)
                VALUES 
                    (@ProductID, @ProductPhotoID, @IsPrimary, GETDATE())
            END";

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

    public async Task<List<SemanticSearchResult>> SearchProductsByDescriptionEmbeddingAsync(float[] queryEmbedding, int topN = 20, string cultureId = "en")
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
                pp.ThumbNailPhoto,
                VECTOR_DISTANCE('cosine', pd.DescriptionEmbedding, CAST(@QueryEmbedding AS VECTOR(1536))) AS SimilarityScore,
                'Description' AS MatchSource,
                pd.Description AS MatchText
            FROM Production.Product p
            INNER JOIN Production.ProductModel pm ON p.ProductModelID = pm.ProductModelID
            INNER JOIN Production.ProductModelProductDescriptionCulture pmpdc 
                ON pm.ProductModelID = pmpdc.ProductModelID
            INNER JOIN Production.ProductDescription pd 
                ON pmpdc.ProductDescriptionID = pd.ProductDescriptionID
            LEFT JOIN Production.ProductProductPhoto ppp ON p.ProductID = ppp.ProductID AND ppp.[Primary] = 1
            LEFT JOIN Production.ProductPhoto pp ON ppp.ProductPhotoID = pp.ProductPhotoID
            WHERE p.FinishedGoodsFlag = 1
              AND pd.DescriptionEmbedding IS NOT NULL
              AND pmpdc.CultureID = @CultureId
            ORDER BY VECTOR_DISTANCE('cosine', pd.DescriptionEmbedding, CAST(@QueryEmbedding AS VECTOR(1536)))";

        var results = await connection.QueryAsync<SemanticSearchResult>(sql, new
        {
            TopN = topN,
            QueryEmbedding = embeddingJson,
            CultureId = cultureId
        });

        return results.ToList();
    }

    public async Task<List<SemanticSearchResult>> SearchProductsByNameEmbeddingAsync(float[] queryEmbedding, int topN = 20, string cultureId = "en")
    {
        using var connection = await GetConnectionAsync();

        var embeddingJson = System.Text.Json.JsonSerializer.Serialize(queryEmbedding);

        var sql = @"
            SELECT TOP (@TopN)
                pn.ProductID,
                p.Name,
                NULL AS Description,
                p.ListPrice,
                p.Color,
                pp.ThumbNailPhoto,
                VECTOR_DISTANCE('cosine', pn.ProductNameEmbedding, CAST(@QueryEmbedding AS VECTOR(1536))) AS SimilarityScore,
                'ProductName' AS MatchSource,
                pn.Name AS MatchText
            FROM Production.ProductName pn
            INNER JOIN Production.Product p ON pn.ProductID = p.ProductID
            LEFT JOIN Production.ProductProductPhoto ppp ON p.ProductID = ppp.ProductID AND ppp.[Primary] = 1
            LEFT JOIN Production.ProductPhoto pp ON ppp.ProductPhotoID = pp.ProductPhotoID
            WHERE p.FinishedGoodsFlag = 1
              AND pn.ProductNameEmbedding IS NOT NULL
              AND pn.CultureID = @CultureId
            ORDER BY VECTOR_DISTANCE('cosine', pn.ProductNameEmbedding, CAST(@QueryEmbedding AS VECTOR(1536)))";

        var results = await connection.QueryAsync<SemanticSearchResult>(sql, new
        {
            TopN = topN,
            QueryEmbedding = embeddingJson,
            CultureId = cultureId
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

    // ── Product Name Translations ──────────────────────────────────────────
    // Upserts translated product names into Production.ProductName per culture.

    public async Task SaveProductNamesAsync(List<TranslatedProductName> names)
    {
        if (names == null || names.Count == 0) return;
        using var connection = await GetConnectionAsync();

        foreach (var item in names)
        {
            // Guard on product existence so a concurrent delete cannot cause an FK violation.
            var upsertSql = @"
                IF EXISTS (SELECT 1 FROM Production.Product WHERE ProductID = @ProductID)
                BEGIN
                    IF EXISTS (SELECT 1 FROM Production.ProductName WHERE ProductID = @ProductID AND CultureID = @CultureID)
                        UPDATE Production.ProductName
                        SET Name = @Name, ModifiedDate = GETDATE()
                        WHERE ProductID = @ProductID AND CultureID = @CultureID
                    ELSE
                        INSERT INTO Production.ProductName (ProductID, CultureID, Name, ModifiedDate)
                        VALUES (@ProductID, @CultureID, @Name, GETDATE())
                END";

            await connection.ExecuteAsync(upsertSql, new
            {
                item.ProductID,
                CultureID = item.CultureID.PadRight(6),
                item.Name
            });
        }
    }

    // ── Category / Subcategory Management ─────────────────────────────────

    public async Task<int> GetNextCategoryIdAsync()
    {
        using var connection = await GetConnectionAsync();
        var maxId = await connection.QueryFirstOrDefaultAsync<int?>("SELECT MAX(ProductCategoryID) FROM Production.ProductCategory") ?? 0;
        return maxId + 1;
    }

    public async Task<int> GetNextSubcategoryIdAsync()
    {
        using var connection = await GetConnectionAsync();
        var maxId = await connection.QueryFirstOrDefaultAsync<int?>("SELECT MAX(ProductSubcategoryID) FROM Production.ProductSubcategory") ?? 0;
        return maxId + 1;
    }

    public async Task InsertCategoryRowAsync(int categoryId, string cultureId, string name)
    {
        using var connection = await GetConnectionAsync();
        var sql = @"
            IF NOT EXISTS (SELECT 1 FROM Production.ProductCategory WHERE ProductCategoryID = @CategoryId AND CultureID = @CultureID)
                INSERT INTO Production.ProductCategory (ProductCategoryID, CultureID, Name, ModifiedDate)
                VALUES (@CategoryId, @CultureID, @Name, GETDATE())
            ELSE
                UPDATE Production.ProductCategory SET Name = @Name, ModifiedDate = GETDATE()
                WHERE ProductCategoryID = @CategoryId AND CultureID = @CultureID";
        await connection.ExecuteAsync(sql, new { CategoryId = categoryId, CultureID = cultureId.PadRight(6), Name = name });
    }

    public async Task InsertSubcategoryRowAsync(int subcategoryId, int categoryId, string cultureId, string name)
    {
        using var connection = await GetConnectionAsync();
        var sql = @"
            IF NOT EXISTS (SELECT 1 FROM Production.ProductSubcategory WHERE ProductSubcategoryID = @SubcategoryId AND CultureID = @CultureID)
                INSERT INTO Production.ProductSubcategory (ProductSubcategoryID, ProductCategoryID, CultureID, Name, ModifiedDate)
                VALUES (@SubcategoryId, @CategoryId, @CultureID, @Name, GETDATE())
            ELSE
                UPDATE Production.ProductSubcategory SET Name = @Name, ModifiedDate = GETDATE()
                WHERE ProductSubcategoryID = @SubcategoryId AND CultureID = @CultureID";
        await connection.ExecuteAsync(sql, new { SubcategoryId = subcategoryId, CategoryId = categoryId, CultureID = cultureId.PadRight(6), Name = name });
    }

    public async Task<bool> CategoryHasSubcategoriesAsync(int categoryId)
    {
        using var connection = await GetConnectionAsync();
        var count = await connection.QueryFirstOrDefaultAsync<int>(
            "SELECT COUNT(DISTINCT ProductSubcategoryID) FROM Production.ProductSubcategory WHERE ProductCategoryID = @CategoryId",
            new { CategoryId = categoryId });
        return count > 0;
    }

    public async Task<bool> SubcategoryHasProductsAsync(int subcategoryId)
    {
        using var connection = await GetConnectionAsync();
        var count = await connection.QueryFirstOrDefaultAsync<int>(
            "SELECT COUNT(*) FROM Production.Product WHERE ProductSubcategoryID = @SubcategoryId",
            new { SubcategoryId = subcategoryId });
        return count > 0;
    }

    public async Task DeleteCategoryAsync(int categoryId)
    {
        using var connection = await GetConnectionAsync();
        await connection.ExecuteAsync(
            "DELETE FROM Production.ProductCategory WHERE ProductCategoryID = @CategoryId",
            new { CategoryId = categoryId });
    }

    public async Task DeleteSubcategoryAsync(int subcategoryId)
    {
        using var connection = await GetConnectionAsync();
        await connection.ExecuteAsync(
            "DELETE FROM Production.ProductSubcategory WHERE ProductSubcategoryID = @SubcategoryId",
            new { SubcategoryId = subcategoryId });
    }

    public async Task<SubcategoryProductInfo> GetSubcategoryProductInfoAsync(int subcategoryId)
    {
        using var connection = await GetConnectionAsync();

        var totalProducts = await connection.QueryFirstOrDefaultAsync<int>(
            "SELECT COUNT(*) FROM Production.Product WHERE ProductSubcategoryID = @Id",
            new { Id = subcategoryId });

        var modelGroupCount = await connection.QueryFirstOrDefaultAsync<int>(@"
            SELECT COUNT(*) FROM (
                SELECT ProductModelID
                FROM Production.Product
                WHERE ProductSubcategoryID = @Id
                  AND ProductModelID IS NOT NULL
                GROUP BY ProductModelID
                HAVING COUNT(*) > 1
            ) AS grp",
            new { Id = subcategoryId });

        return new SubcategoryProductInfo
        {
            TotalProducts = totalProducts,
            ModelGroupCount = modelGroupCount
        };
    }

    /// <summary>
    /// Cascade-deletes all products in a subcategory (and all their related data),
    /// then deletes the subcategory rows themselves.  Runs inside a single transaction.
    /// </summary>
    public async Task<DeleteSubcategoryCascadeResult> DeleteSubcategoryCascadeAsync(int subcategoryId)
    {
        var sqlConn = new Microsoft.Data.SqlClient.SqlConnection(_connectionString);
        await sqlConn.OpenAsync();
        await using var _ = sqlConn;

        using var transaction = sqlConn.BeginTransaction();
        try
        {
            // 1. Collect product IDs to delete
            var productIds = (await sqlConn.QueryAsync<int>(
                "SELECT ProductID FROM Production.Product WHERE ProductSubcategoryID = @Id",
                new { Id = subcategoryId }, transaction)).ToList();

            int productsDeleted = 0;

            if (productIds.Count > 0)
            {
                // 2. Shopping cart items
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Sales.ShoppingCartItem WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 3. Review replies → reviews
                await sqlConn.ExecuteAsync(@"
                    DELETE FROM Production.ProductReviewReply
                    WHERE ProductReviewID IN (
                        SELECT ProductReviewID FROM Production.ProductReview WHERE ProductID IN @Ids)",
                    new { Ids = productIds }, transaction);
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Production.ProductReview WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 4. Photo links (join table only — shared photo rows stay)
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Production.ProductProductPhoto WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 5. Inventory
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Production.ProductInventory WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 6. Special offer products
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Sales.SpecialOfferProduct WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 7. Price / cost history
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Production.ProductCostHistory WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Production.ProductListPriceHistory WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 8. Work order routing → work orders
                await sqlConn.ExecuteAsync(@"
                    DELETE FROM Production.WorkOrderRouting
                    WHERE WorkOrderID IN (
                        SELECT WorkOrderID FROM Production.WorkOrder WHERE ProductID IN @Ids)",
                    new { Ids = productIds }, transaction);
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Production.WorkOrder WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 9. Transaction history
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Production.TransactionHistory WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 10. Product vendor
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Purchasing.ProductVendor WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 11. Purchase order details
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Purchasing.PurchaseOrderDetail WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 12. Product name translations
                await sqlConn.ExecuteAsync(
                    "DELETE FROM Production.ProductName WHERE ProductID IN @Ids",
                    new { Ids = productIds }, transaction);

                // 13. Capture model IDs before deleting products
                var modelIds = (await sqlConn.QueryAsync<int?>(@"
                    SELECT DISTINCT ProductModelID FROM Production.Product
                    WHERE ProductSubcategoryID = @Id AND ProductModelID IS NOT NULL",
                    new { Id = subcategoryId }, transaction))
                    .Where(id => id.HasValue).Select(id => id!.Value).ToList();

                // 14. Delete products
                productsDeleted = await sqlConn.ExecuteAsync(
                    "DELETE FROM Production.Product WHERE ProductSubcategoryID = @Id",
                    new { Id = subcategoryId }, transaction);

                // 15. Clean up orphaned ProductModels
                if (modelIds.Count > 0)
                {
                    var orphanedModels = new List<int>();
                    foreach (var modelId in modelIds)
                    {
                        var remaining = await sqlConn.QueryFirstOrDefaultAsync<int>(
                            "SELECT COUNT(*) FROM Production.Product WHERE ProductModelID = @ModelId",
                            new { ModelId = modelId }, transaction);
                        if (remaining == 0) orphanedModels.Add(modelId);
                    }

                    if (orphanedModels.Count > 0)
                    {
                        var descIds = (await sqlConn.QueryAsync<int>(@"
                            SELECT DISTINCT ProductDescriptionID
                            FROM Production.ProductModelProductDescriptionCulture
                            WHERE ProductModelID IN @ModelIds",
                            new { ModelIds = orphanedModels }, transaction)).ToList();

                        await sqlConn.ExecuteAsync(@"
                            DELETE FROM Production.ProductModelProductDescriptionCulture
                            WHERE ProductModelID IN @ModelIds",
                            new { ModelIds = orphanedModels }, transaction);

                        if (descIds.Count > 0)
                        {
                            // Only delete descriptions no longer linked to any model
                            await sqlConn.ExecuteAsync(@"
                                DELETE FROM Production.ProductDescription
                                WHERE ProductDescriptionID IN @DescIds
                                  AND NOT EXISTS (
                                      SELECT 1 FROM Production.ProductModelProductDescriptionCulture
                                      WHERE ProductDescriptionID = Production.ProductDescription.ProductDescriptionID)",
                                new { DescIds = descIds }, transaction);
                        }

                        await sqlConn.ExecuteAsync(
                            "DELETE FROM Production.ProductModelIllustration WHERE ProductModelID IN @ModelIds",
                            new { ModelIds = orphanedModels }, transaction);

                        await sqlConn.ExecuteAsync(
                            "DELETE FROM Production.ProductModel WHERE ProductModelID IN @ModelIds",
                            new { ModelIds = orphanedModels }, transaction);
                    }
                }
            }

            // 16. Delete subcategory rows (all culture variants)
            await sqlConn.ExecuteAsync(
                "DELETE FROM Production.ProductSubcategory WHERE ProductSubcategoryID = @Id",
                new { Id = subcategoryId }, transaction);

            transaction.Commit();
            return new DeleteSubcategoryCascadeResult { Success = true, ProductsDeleted = productsDeleted };
        }
        catch
        {
            transaction.Rollback();
            throw;
        }
    }

    public async Task<List<CultureInfo>> GetAllCulturesAsync()
    {
        using var connection = await GetConnectionAsync();
        var sql = "SELECT CultureID, Name FROM Production.Culture";
        var cultures = await connection.QueryAsync<CultureInfo>(sql);
        return cultures.ToList();
    }

    // Returns ProductID values for all products in a model (to enable name translation per product)
    public async Task<List<int>> GetProductIdsByModelIdAsync(int productModelId)
    {
        using var connection = await GetConnectionAsync();
        var ids = await connection.QueryAsync<int>(
            "SELECT ProductID FROM Production.Product WHERE ProductModelID = @ModelId",
            new { ModelId = productModelId });
        return ids.ToList();
    }

}
