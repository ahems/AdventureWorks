using System.Data;
using Azure.Identity;
using Dapper;
using Microsoft.Data.SqlClient;
using api_functions.Models;

namespace api_functions.Services;

public class ReviewService
{
    private readonly string _connectionString;
    private readonly string _tableServiceUri;

    public ReviewService(string connectionString, string tableServiceUri)
    {
        _connectionString = connectionString;
        _tableServiceUri = tableServiceUri;
    }

    private async Task<IDbConnection> GetConnectionAsync()
    {
        // Connection string contains Authentication=Active Directory Default
        // which handles credential acquisition automatically
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    public async Task<List<ProductReviewData>> GetProductReviewsForEmbeddingAsync()
    {
        using var connection = await GetConnectionAsync();

        // Get all product reviews that have comments and don't have embeddings yet
        var sql = @"
            SELECT 
                ProductReviewID,
                ProductID,
                ReviewerName,
                ReviewDate,
                Rating,
                Comments,
                ModifiedDate
            FROM Production.ProductReview
            WHERE Comments IS NOT NULL
              AND CommentsEmbedding IS NULL
            ORDER BY ProductID, ProductReviewID";

        var reviews = await connection.QueryAsync<ProductReviewData>(sql);
        return reviews.ToList();
    }

    public async Task SaveEmbeddingAsync(ProductReviewEmbedding embedding)
    {
        using var connection = await GetConnectionAsync();

        // Save embedding to ProductReview table
        // Convert float array to JSON array format for VECTOR column
        var embeddingJson = System.Text.Json.JsonSerializer.Serialize(embedding.Embedding);

        var updateSql = @"
            UPDATE Production.ProductReview
            SET 
                CommentsEmbedding = CAST(@EmbeddingJson AS VECTOR(1536)),
                ModifiedDate = GETDATE()
            WHERE ProductReviewID = @ProductReviewID";

        await connection.ExecuteAsync(updateSql, new
        {
            embedding.ProductReviewID,
            EmbeddingJson = embeddingJson
        });
    }

    public async Task<List<ProductForReviewGeneration>> GetProductsForReviewGenerationAsync(List<int>? productIds = null)
    {
        using var connection = await GetConnectionAsync();

        // Get finished goods products with their English descriptions and review counts
        var sql = @"
            SELECT 
                p.ProductID,
                p.Name,
                pd.Description,
                COUNT(pr.ProductReviewID) AS ExistingReviewCount,
                p.SellStartDate
            FROM Production.Product p
            LEFT JOIN Production.ProductModel pm ON p.ProductModelID = pm.ProductModelID
            LEFT JOIN Production.ProductModelProductDescriptionCulture pmx 
                ON pm.ProductModelID = pmx.ProductModelID AND pmx.CultureID = 'en'
            LEFT JOIN Production.ProductDescription pd ON pmx.ProductDescriptionID = pd.ProductDescriptionID
            LEFT JOIN Production.ProductReview pr ON p.ProductID = pr.ProductID
            WHERE p.FinishedGoodsFlag = 1
            AND (@FilterByIds = 0 OR p.ProductID IN @ProductIds)
            GROUP BY p.ProductID, p.Name, pd.Description, p.SellStartDate
            ORDER BY p.ProductID";

        var products = await connection.QueryAsync<ProductForReviewGeneration>(sql, new
        {
            FilterByIds = (productIds?.Count > 0) ? 1 : 0,
            ProductIds = (productIds?.Count > 0) ? productIds : new List<int> { -1 }
        });
        return products.ToList();
    }

    public async Task SaveGeneratedReviewAsync(GeneratedReview review)
    {
        using var connection = await GetConnectionAsync();

        // Insert new review into database
        var insertSql = @"
            INSERT INTO Production.ProductReview 
            (ProductID, ReviewerName, ReviewDate, EmailAddress, Rating, Comments, ModifiedDate)
            VALUES 
            (@ProductID, @ReviewerName, @ReviewDate, @EmailAddress, @Rating, @Comments, GETDATE())";

        await connection.ExecuteAsync(insertSql, new
        {
            review.ProductID,
            review.ReviewerName,
            review.ReviewDate,
            review.EmailAddress,
            review.Rating,
            review.Comments
        });
    }

    /// <summary>
    /// Inserts a generated review and returns its new ProductReviewID.
    /// </summary>
    public async Task<int> SaveGeneratedReviewAndGetIdAsync(GeneratedReview review)
    {
        using var connection = await GetConnectionAsync();

        var insertSql = @"
            INSERT INTO Production.ProductReview 
            (ProductID, ReviewerName, ReviewDate, EmailAddress, Rating, Comments, ModifiedDate)
            OUTPUT INSERTED.ProductReviewID
            VALUES 
            (@ProductID, @ReviewerName, @ReviewDate, @EmailAddress, @Rating, @Comments, GETDATE())";

        return await connection.ExecuteScalarAsync<int>(insertSql, new
        {
            review.ProductID,
            review.ReviewerName,
            review.ReviewDate,
            review.EmailAddress,
            review.Rating,
            review.Comments
        });
    }

    /// <summary>
    /// Saves an AI-generated staff reply for a specific review.
    /// </summary>
    public async Task SaveReviewReplyAsync(int reviewId, string reply, string repliedBy = "AdventureWorks Team")
    {
        using var connection = await GetConnectionAsync();

        var insertSql = @"
            INSERT INTO Production.ProductReviewReply
            (ProductReviewID, Reply, RepliedBy, ReplyDate)
            VALUES
            (@ReviewId, @Reply, @RepliedBy, GETDATE())";

        await connection.ExecuteAsync(insertSql, new { ReviewId = reviewId, Reply = reply, RepliedBy = repliedBy });
    }

    public async Task<List<SemanticSearchResult>> SearchProductsByReviewEmbeddingAsync(float[] queryEmbedding, int topN = 20)
    {
        using var connection = await GetConnectionAsync();

        // Use VECTOR_DISTANCE for semantic similarity search with native VECTOR columns
        // Returns products with reviews that are most similar to the query
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
                VECTOR_DISTANCE('cosine', pr.CommentsEmbedding, CAST(@QueryEmbedding AS VECTOR(1536))) AS SimilarityScore,
                'Review' AS MatchSource,
                pr.Comments AS MatchText
            FROM Production.Product p
            INNER JOIN Production.ProductReview pr ON p.ProductID = pr.ProductID
            LEFT JOIN Production.ProductModel pm ON p.ProductModelID = pm.ProductModelID
            LEFT JOIN Production.ProductModelProductDescriptionCulture pmpdc 
                ON pm.ProductModelID = pmpdc.ProductModelID AND pmpdc.CultureID = 'en'
            LEFT JOIN Production.ProductDescription pd 
                ON pmpdc.ProductDescriptionID = pd.ProductDescriptionID
            LEFT JOIN Production.ProductProductPhoto ppp ON p.ProductID = ppp.ProductID AND ppp.[Primary] = 1
            LEFT JOIN Production.ProductPhoto pp ON ppp.ProductPhotoID = pp.ProductPhotoID
            WHERE p.FinishedGoodsFlag = 1
              AND pr.CommentsEmbedding IS NOT NULL
            ORDER BY VECTOR_DISTANCE('cosine', pr.CommentsEmbedding, CAST(@QueryEmbedding AS VECTOR(1536)))";

        var results = await connection.QueryAsync<SemanticSearchResult>(sql, new
        {
            TopN = topN,
            QueryEmbedding = embeddingJson
        });

        return results.ToList();
    }

    public async Task<string> AnalyzeProductReviewsAsync(int productId)
    {
        using var connection = await GetConnectionAsync();

        // Get all reviews for the product
        var reviews = await connection.QueryAsync<ProductReviewData>(@"
            SELECT 
                ProductReviewID,
                ProductID,
                ReviewerName,
                ReviewDate,
                Rating,
                Comments,
                ModifiedDate
            FROM Production.ProductReview
            WHERE ProductID = @ProductId
            ORDER BY ReviewDate DESC",
            new { ProductId = productId });

        if (!reviews.Any())
        {
            return $"No reviews found for product #{productId}.";
        }

        // Get product name
        var productName = await connection.QueryFirstOrDefaultAsync<string>(
            "SELECT Name FROM Production.Product WHERE ProductID = @ProductId",
            new { ProductId = productId });

        // Calculate statistics
        var reviewList = reviews.ToList();
        var averageRating = reviewList.Average(r => r.Rating);
        var totalReviews = reviewList.Count;
        var ratingDistribution = reviewList.GroupBy(r => r.Rating)
            .OrderByDescending(g => g.Key)
            .Select(g => new { Rating = g.Key, Count = g.Count() });

        // Extract sample positive and negative comments
        var positiveReviews = reviewList.Where(r => r.Rating >= 4 && !string.IsNullOrWhiteSpace(r.Comments))
            .Take(3)
            .Select(r => r.Comments)
            .ToList();

        var negativeReviews = reviewList.Where(r => r.Rating <= 2 && !string.IsNullOrWhiteSpace(r.Comments))
            .Take(3)
            .Select(r => r.Comments)
            .ToList();

        // Build result
        var result = new System.Text.StringBuilder();
        result.AppendLine($"⭐ Product Review Analysis for: {productName ?? $"Product #{productId}"}");
        result.AppendLine();
        result.AppendLine($"Overall Rating: {averageRating:F1}/5.0 ({GetStarDisplay(averageRating)})");
        result.AppendLine($"Total Reviews: {totalReviews}");
        result.AppendLine();
        result.AppendLine("Rating Distribution:");
        foreach (var dist in ratingDistribution)
        {
            var percentage = (dist.Count * 100.0 / totalReviews);
            result.AppendLine($"  {dist.Rating}⭐: {dist.Count} reviews ({percentage:F1}%)");
        }

        if (positiveReviews.Any())
        {
            result.AppendLine();
            result.AppendLine("👍 What Customers Love:");
            foreach (var comment in positiveReviews)
            {
                if (!string.IsNullOrWhiteSpace(comment))
                {
                    var truncated = comment.Length > 100 ? comment.Substring(0, 100) + "..." : comment;
                    result.AppendLine($"  • \"{truncated}\"");
                }
            }
        }

        if (negativeReviews.Any())
        {
            result.AppendLine();
            result.AppendLine("👎 Common Concerns:");
            foreach (var comment in negativeReviews)
            {
                if (!string.IsNullOrWhiteSpace(comment))
                {
                    var truncated = comment.Length > 100 ? comment.Substring(0, 100) + "..." : comment;
                    result.AppendLine($"  • \"{truncated}\"");
                }
            }
        }

        result.AppendLine();
        var latestReview = reviewList.First();
        result.AppendLine($"Latest Review: {latestReview.ReviewDate:yyyy-MM-dd} by {latestReview.ReviewerName ?? "Anonymous"}");

        return result.ToString();
    }

    private string GetStarDisplay(double rating)
    {
        var fullStars = (int)Math.Floor(rating);
        var hasHalfStar = (rating - fullStars) >= 0.5;
        var emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);

        return new string('⭐', fullStars) +
               (hasHalfStar ? "½" : "") +
               new string('☆', emptyStars);
    }

    /// <summary>
    /// Returns distinct customers who have at least one Delivered (Status=7) order
    /// containing the specified product AND who have NOT already reviewed that product,
    /// ordered by most-recent delivery date.
    /// </summary>
    public async Task<List<CustomerWithDeliveredOrder>> GetCustomersWithDeliveredOrderForProductAsync(int productId)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT DISTINCT
                c.CustomerID,
                p.FirstName,
                p.LastName,
                COALESCE(ea.EmailAddress, '') AS EmailAddress,
                MAX(soh.OrderDate) AS DeliveryDate
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.SalesOrderDetail sod
                ON soh.SalesOrderID = sod.SalesOrderID
            INNER JOIN Sales.Customer c
                ON soh.CustomerID = c.CustomerID
            INNER JOIN Person.Person p
                ON c.PersonID = p.BusinessEntityID
            LEFT JOIN Person.EmailAddress ea
                ON p.BusinessEntityID = ea.BusinessEntityID
            WHERE soh.Status = 7
              AND sod.ProductID = @ProductId
              AND c.StoreID IS NULL   -- eshop (individual) customers only; StoreID IS NOT NULL = B2B
              AND NOT EXISTS (
                  SELECT 1 FROM Production.ProductReview pr
                  WHERE pr.ProductID = @ProductId
                    AND pr.EmailAddress = COALESCE(ea.EmailAddress, '')
                    AND COALESCE(ea.EmailAddress, '') <> ''
              )
            GROUP BY c.CustomerID, p.FirstName, p.LastName, ea.EmailAddress
            ORDER BY MAX(soh.OrderDate) DESC";

        var customers = await connection.QueryAsync<CustomerWithDeliveredOrder>(sql, new { ProductId = productId });
        return customers.ToList();
    }

    /// <summary>
    /// Returns a summary of how many unique products have at least one unreviewed customer
    /// with a Delivered order, plus the maximum such customer count for any single product.
    /// </summary>
    public async Task<VerifiedReviewsSummary> GetVerifiedReviewsSummaryAsync()
    {
        using var connection = await GetConnectionAsync();

        // CTE builds the eligible-count per product, then the outer query aggregates
        // and picks the top product (most unreviewed eligible customers) in one round-trip.
        var sql = @"
            WITH EligibleCounts AS (
                SELECT
                    sod.ProductID,
                    COUNT(DISTINCT c.CustomerID) AS EligibleCount
                FROM Sales.SalesOrderHeader soh
                INNER JOIN Sales.SalesOrderDetail sod ON soh.SalesOrderID = sod.SalesOrderID
                INNER JOIN Sales.Customer c ON soh.CustomerID = c.CustomerID
                INNER JOIN Person.Person p ON c.PersonID = p.BusinessEntityID
                LEFT JOIN Person.EmailAddress ea ON p.BusinessEntityID = ea.BusinessEntityID
                WHERE soh.Status = 7
                  AND c.StoreID IS NULL   -- eshop (individual) customers only
                  AND NOT EXISTS (
                      SELECT 1 FROM Production.ProductReview pr
                      WHERE pr.ProductID = sod.ProductID
                        AND pr.EmailAddress = COALESCE(ea.EmailAddress, '')
                        AND COALESCE(ea.EmailAddress, '') <> ''
                  )
                GROUP BY sod.ProductID
                HAVING COUNT(DISTINCT c.CustomerID) > 0
            )
            SELECT
                COUNT(*)                         AS QualifyingProductCount,
                ISNULL(MAX(ec.EligibleCount), 0) AS MaxEligibleCustomersPerProduct,
                ISNULL((
                    SELECT TOP 1 ec2.ProductID
                    FROM EligibleCounts ec2
                    ORDER BY ec2.EligibleCount DESC
                ), 0)                            AS TopProductId,
                ISNULL((
                    SELECT TOP 1 prod.Name
                    FROM EligibleCounts ec3
                    INNER JOIN Production.Product prod ON ec3.ProductID = prod.ProductID
                    ORDER BY ec3.EligibleCount DESC
                ), '')                           AS TopProductName
            FROM EligibleCounts ec";

        return await connection.QuerySingleAsync<VerifiedReviewsSummary>(sql);
    }

    /// <summary>
    /// Returns a randomly-selected batch of qualifying (product, customers) pairs.
    /// For each product, up to <paramref name="reviewsPerProduct"/> unreviewed customers are selected randomly.
    /// </summary>
    public async Task<List<(ProductForReviewGeneration Product, List<CustomerWithDeliveredOrder> Customers)>>
        GetBatchVerifiedReviewsDataAsync(int productCount, int reviewsPerProduct)
    {
        // 1. Fetch all qualifying product IDs
        using var connection = await GetConnectionAsync();
        var idSql = @"
            SELECT sod.ProductID, COUNT(DISTINCT c.CustomerID) AS EligibleCount
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.SalesOrderDetail sod ON soh.SalesOrderID = sod.SalesOrderID
            INNER JOIN Sales.Customer c ON soh.CustomerID = c.CustomerID
            INNER JOIN Person.Person p ON c.PersonID = p.BusinessEntityID
            LEFT JOIN Person.EmailAddress ea ON p.BusinessEntityID = ea.BusinessEntityID
            WHERE soh.Status = 7
              AND c.StoreID IS NULL   -- eshop (individual) customers only
              AND NOT EXISTS (
                  SELECT 1 FROM Production.ProductReview pr
                  WHERE pr.ProductID = sod.ProductID
                    AND pr.EmailAddress = COALESCE(ea.EmailAddress, '')
                    AND COALESCE(ea.EmailAddress, '') <> ''
              )
            GROUP BY sod.ProductID
            HAVING COUNT(DISTINCT c.CustomerID) > 0";

        var allQualifying = (await connection.QueryAsync<QualifyingProductInfo>(idSql)).ToList();

        if (allQualifying.Count == 0)
            return new List<(ProductForReviewGeneration, List<CustomerWithDeliveredOrder>)>();

        // 2. Randomly select productCount products
        var rng = new Random();
        var effectiveCount = productCount <= 0 ? allQualifying.Count : Math.Min(productCount, allQualifying.Count);
        var selectedInfos = allQualifying
            .OrderBy(_ => rng.Next())
            .Take(effectiveCount)
            .ToList();

        // 3. Fetch product details in one query
        var selectedIds = selectedInfos.Select(x => x.ProductID).ToList();
        var products = await GetProductsForReviewGenerationAsync(selectedIds);
        var productDict = products.ToDictionary(p => p.ProductID);

        // 4. For each selected product, fetch eligible customers and take reviewsPerProduct
        var result = new List<(ProductForReviewGeneration, List<CustomerWithDeliveredOrder>)>();
        foreach (var info in selectedInfos)
        {
            if (!productDict.TryGetValue(info.ProductID, out var product)) continue;
            var customers = await GetCustomersWithDeliveredOrderForProductAsync(info.ProductID);
            if (customers.Count == 0) continue;
            var selected = customers.OrderBy(_ => rng.Next()).Take(reviewsPerProduct).ToList();
            result.Add((product, selected));
        }

        return result;
    }

    /// <summary>
    /// Returns the (product, customers) pair for a specific product, limited to
    /// <paramref name="reviewsPerProduct"/> randomly-chosen unreviewed eligible customers.
    /// Returns null if the product has no eligible customers.
    /// </summary>
    public async Task<(ProductForReviewGeneration Product, List<CustomerWithDeliveredOrder> Customers)?>
        GetVerifiedReviewsDataForProductAsync(int productId, int reviewsPerProduct)
    {
        var products = await GetProductsForReviewGenerationAsync(new List<int> { productId });
        if (products.Count == 0) return null;

        var customers = await GetCustomersWithDeliveredOrderForProductAsync(productId);
        if (customers.Count == 0) return null;

        var rng = new Random();
        var selected = customers.OrderBy(_ => rng.Next()).Take(reviewsPerProduct).ToList();
        return (products[0], selected);
    }

    /// <summary>
    /// Lightweight count of unreviewed eshop customers (StoreID IS NULL, Status=7)
    /// who have a Delivered order for the specified product and have not yet reviewed it.
    /// Used by the product-page eligibility gate — avoids fetching full customer rows.
    /// </summary>
    public async Task<int> GetProductEligibleReviewerCountAsync(int productId)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT COUNT(DISTINCT c.CustomerID)
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.SalesOrderDetail sod ON soh.SalesOrderID = sod.SalesOrderID
            INNER JOIN Sales.Customer c ON soh.CustomerID = c.CustomerID
            INNER JOIN Person.Person p ON c.PersonID = p.BusinessEntityID
            LEFT JOIN Person.EmailAddress ea ON p.BusinessEntityID = ea.BusinessEntityID
            WHERE soh.Status = 7
              AND sod.ProductID = @ProductId
              AND c.StoreID IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM Production.ProductReview pr
                  WHERE pr.ProductID = @ProductId
                    AND pr.EmailAddress = COALESCE(ea.EmailAddress, '')
                    AND COALESCE(ea.EmailAddress, '') <> ''
              )";

        return await connection.ExecuteScalarAsync<int>(sql, new { ProductId = productId });
    }

    // ── Verified-Reviews job state (Azure Table Storage) ──────────────────────

    private const string _verifiedReviewsTableName = "verifiedReviewsJob";
    private const string _verifiedReviewsPartitionKey = "verifiedreviews";
    private const string _verifiedReviewsRowKey = "state";
    private const string _reviewModerationTableName = "reviewModerationJob";
    private const string _reviewModerationPartitionKey = "reviewmoderation";
    private const string _reviewModerationRowKey = "state";

    private Azure.Data.Tables.TableClient? _tableClient;
    private Azure.Data.Tables.TableClient? _reviewModerationTableClient;

    private Azure.Data.Tables.TableClient GetTableClient()
    {
        if (_tableClient == null)
        {
            // Use the same managed-identity pattern as every other service
            var tableService = new Azure.Data.Tables.TableServiceClient(
                new Uri(_tableServiceUri),
                new DefaultAzureCredential());
            _tableClient = tableService.GetTableClient(_verifiedReviewsTableName);
        }
        return _tableClient;
    }

    public async Task<VerifiedReviewsJobState> GetVerifiedReviewsJobStateAsync()
    {
        try
        {
            var client = GetTableClient();
            var entity = await client.GetEntityAsync<Azure.Data.Tables.TableEntity>(
                _verifiedReviewsPartitionKey, _verifiedReviewsRowKey);

            return new VerifiedReviewsJobState
            {
                IsRunning = entity.Value.GetBoolean("IsRunning") ?? false,
                ProductId = entity.Value.GetInt32("ProductId") ?? 0,
                ProductName = entity.Value.GetString("ProductName") ?? string.Empty,
                ProcessedCount = entity.Value.GetInt32("ProcessedCount") ?? 0,
                TotalCount = entity.Value.GetInt32("TotalCount") ?? 0,
                ProductsProcessed = entity.Value.GetInt32("ProductsProcessed") ?? 0,
                ProductsTotal = entity.Value.GetInt32("ProductsTotal") ?? 0,
                StartedAt = entity.Value.GetDateTimeOffset("StartedAt"),
                LastProgressAt = entity.Value.GetDateTimeOffset("LastProgressAt"),
                LastError = entity.Value.GetString("LastError")
            };
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 404)
        {
            return new VerifiedReviewsJobState { IsRunning = false };
        }
    }

    public async Task SaveVerifiedReviewsJobStateAsync(VerifiedReviewsJobState state)
    {
        var client = GetTableClient();
        var entity = new Azure.Data.Tables.TableEntity(_verifiedReviewsPartitionKey, _verifiedReviewsRowKey)
        {
            ["IsRunning"] = state.IsRunning,
            ["ProductId"] = state.ProductId,
            ["ProductName"] = state.ProductName,
            ["ProcessedCount"] = state.ProcessedCount,
            ["TotalCount"] = state.TotalCount,
            ["ProductsProcessed"] = state.ProductsProcessed,
            ["ProductsTotal"] = state.ProductsTotal,
            ["StartedAt"] = state.StartedAt,
            ["LastProgressAt"] = state.LastProgressAt,
            ["LastError"] = state.LastError
        };
        await client.UpsertEntityAsync(entity, Azure.Data.Tables.TableUpdateMode.Replace);
    }

    // ── Review auto-moderation queue state + data access ────────────────────

    private Azure.Data.Tables.TableClient GetReviewModerationTableClient()
    {
        if (_reviewModerationTableClient == null)
        {
            var tableService = new Azure.Data.Tables.TableServiceClient(
                new Uri(_tableServiceUri),
                new DefaultAzureCredential());
            _reviewModerationTableClient = tableService.GetTableClient(_reviewModerationTableName);
        }
        return _reviewModerationTableClient;
    }

    /// <summary>
    /// Snapshot of unmoderated reviews with no existing staff reply.
    /// </summary>
    public async Task<List<PendingReviewModerationItem>> GetPendingReviewsWithoutReplySnapshotAsync()
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
            SELECT
                pr.ProductReviewID AS ProductReviewId,
                pr.ProductID AS ProductId,
                pr.Rating,
                COALESCE(pr.ReviewerName, 'Anonymous') AS ReviewerName,
                COALESCE(pr.Comments, '') AS Comments,
                COALESCE(p.Name, 'Unknown') AS ProductName
            FROM Production.ProductReview pr
            LEFT JOIN Production.ProductReviewReply rr
                ON rr.ProductReviewID = pr.ProductReviewID
            LEFT JOIN Production.Product p
                ON p.ProductID = pr.ProductID
            WHERE ISNULL(pr.IsModerated, 0) = 0
              AND rr.ProductReviewReplyID IS NULL
            ORDER BY pr.ProductReviewID";

        var rows = await connection.QueryAsync<PendingReviewModerationItem>(sql);
        return rows.ToList();
    }

    /// <summary>
    /// Writes reply + approval in an idempotent transaction.
    /// </summary>
    public async Task<ReviewModerationApplyOutcome> ApplyModerationReplyAndApproveAsync(
        int reviewId,
        string replyText,
        string repliedBy = "AdventureWorks Team")
    {
        using var connection = await GetConnectionAsync();
        using var tx = connection.BeginTransaction();

        var state = await connection.QueryFirstOrDefaultAsync<ReviewModerationRowState>(@"
            SELECT TOP 1
                CAST(ISNULL(pr.IsModerated, 0) AS bit) AS IsModerated,
                rr.ProductReviewReplyID AS ReplyId
            FROM Production.ProductReview pr
            LEFT JOIN Production.ProductReviewReply rr
                ON rr.ProductReviewID = pr.ProductReviewID
            WHERE pr.ProductReviewID = @ReviewId",
            new { ReviewId = reviewId },
            tx);

        if (state == null)
        {
            tx.Commit();
            return ReviewModerationApplyOutcome.SkippedNotFound;
        }

        if (state.ReplyId.HasValue)
        {
            if (!state.IsModerated)
            {
                await connection.ExecuteAsync(@"
                    UPDATE Production.ProductReview
                    SET IsModerated = 1,
                        ModifiedDate = GETDATE()
                    WHERE ProductReviewID = @ReviewId",
                    new { ReviewId = reviewId }, tx);
            }

            tx.Commit();
            return ReviewModerationApplyOutcome.SkippedAlreadyReplied;
        }

        if (state.IsModerated)
        {
            tx.Commit();
            return ReviewModerationApplyOutcome.SkippedAlreadyModerated;
        }

        await connection.ExecuteAsync(@"
            INSERT INTO Production.ProductReviewReply
            (ProductReviewID, Reply, RepliedBy, ReplyDate)
            VALUES
            (@ReviewId, @Reply, @RepliedBy, GETDATE())",
            new { ReviewId = reviewId, Reply = replyText, RepliedBy = repliedBy }, tx);

        await connection.ExecuteAsync(@"
            UPDATE Production.ProductReview
            SET IsModerated = 1,
                ModifiedDate = GETDATE()
            WHERE ProductReviewID = @ReviewId",
            new { ReviewId = reviewId }, tx);

        tx.Commit();
        return ReviewModerationApplyOutcome.Applied;
    }

    public async Task<ReviewModerationJobState> GetReviewModerationJobStateAsync()
    {
        try
        {
            var client = GetReviewModerationTableClient();
            var entity = await client.GetEntityAsync<Azure.Data.Tables.TableEntity>(
                _reviewModerationPartitionKey, _reviewModerationRowKey);

            return new ReviewModerationJobState
            {
                IsRunning = entity.Value.GetBoolean("IsRunning") ?? false,
                JobId = entity.Value.GetString("JobId") ?? string.Empty,
                QueuedCount = entity.Value.GetInt32("QueuedCount") ?? 0,
                ProcessedCount = entity.Value.GetInt32("ProcessedCount") ?? 0,
                SuccessCount = entity.Value.GetInt32("SuccessCount") ?? 0,
                FailedCount = entity.Value.GetInt32("FailedCount") ?? 0,
                SkippedCount = entity.Value.GetInt32("SkippedCount") ?? 0,
                StartedAt = entity.Value.GetDateTimeOffset("StartedAt"),
                LastProgressAt = entity.Value.GetDateTimeOffset("LastProgressAt"),
                CompletedAt = entity.Value.GetDateTimeOffset("CompletedAt"),
                LastError = entity.Value.GetString("LastError")
            };
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 404)
        {
            return new ReviewModerationJobState { IsRunning = false };
        }
    }

    public async Task SaveReviewModerationJobStateAsync(ReviewModerationJobState state)
    {
        var client = GetReviewModerationTableClient();
        var entity = new Azure.Data.Tables.TableEntity(_reviewModerationPartitionKey, _reviewModerationRowKey)
        {
            ["IsRunning"] = state.IsRunning,
            ["JobId"] = state.JobId,
            ["QueuedCount"] = state.QueuedCount,
            ["ProcessedCount"] = state.ProcessedCount,
            ["SuccessCount"] = state.SuccessCount,
            ["FailedCount"] = state.FailedCount,
            ["SkippedCount"] = state.SkippedCount,
            ["StartedAt"] = state.StartedAt,
            ["LastProgressAt"] = state.LastProgressAt,
            ["CompletedAt"] = state.CompletedAt,
            ["LastError"] = state.LastError
        };
        await client.UpsertEntityAsync(entity, Azure.Data.Tables.TableUpdateMode.Replace);
    }

    public async Task<ReviewModerationJobState> IncrementReviewModerationProgressAsync(
        string jobId,
        bool success,
        bool skipped,
        bool failed,
        string? lastError)
    {
        var client = GetReviewModerationTableClient();
        const int maxAttempts = 6;

        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            var current = await client.GetEntityAsync<Azure.Data.Tables.TableEntity>(
                _reviewModerationPartitionKey,
                _reviewModerationRowKey);

            var entity = current.Value;
            var currentJobId = entity.GetString("JobId") ?? string.Empty;
            if (!string.Equals(currentJobId, jobId, StringComparison.Ordinal))
            {
                return await GetReviewModerationJobStateAsync();
            }

            var processed = (entity.GetInt32("ProcessedCount") ?? 0) + 1;
            var queued = entity.GetInt32("QueuedCount") ?? 0;
            var successCount = (entity.GetInt32("SuccessCount") ?? 0) + (success ? 1 : 0);
            var skippedCount = (entity.GetInt32("SkippedCount") ?? 0) + (skipped ? 1 : 0);
            var failedCount = (entity.GetInt32("FailedCount") ?? 0) + (failed ? 1 : 0);
            var completed = processed >= queued && queued > 0;

            entity["ProcessedCount"] = processed;
            entity["SuccessCount"] = successCount;
            entity["SkippedCount"] = skippedCount;
            entity["FailedCount"] = failedCount;
            entity["LastProgressAt"] = DateTimeOffset.UtcNow;
            if (!string.IsNullOrWhiteSpace(lastError))
            {
                entity["LastError"] = lastError;
            }
            if (completed)
            {
                entity["IsRunning"] = false;
                entity["CompletedAt"] = DateTimeOffset.UtcNow;
            }

            try
            {
                await client.UpdateEntityAsync(entity, current.Value.ETag, Azure.Data.Tables.TableUpdateMode.Replace);
                return new ReviewModerationJobState
                {
                    IsRunning = (bool)(entity["IsRunning"] ?? false),
                    JobId = entity.GetString("JobId") ?? string.Empty,
                    QueuedCount = entity.GetInt32("QueuedCount") ?? 0,
                    ProcessedCount = entity.GetInt32("ProcessedCount") ?? 0,
                    SuccessCount = entity.GetInt32("SuccessCount") ?? 0,
                    FailedCount = entity.GetInt32("FailedCount") ?? 0,
                    SkippedCount = entity.GetInt32("SkippedCount") ?? 0,
                    StartedAt = entity.GetDateTimeOffset("StartedAt"),
                    LastProgressAt = entity.GetDateTimeOffset("LastProgressAt"),
                    CompletedAt = entity.GetDateTimeOffset("CompletedAt"),
                    LastError = entity.GetString("LastError")
                };
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 412 && attempt < maxAttempts)
            {
                await Task.Delay(25 * attempt);
            }
        }

        throw new InvalidOperationException("Could not update review moderation state due to concurrent updates.");
    }

    private sealed class ReviewModerationRowState
    {
        public bool IsModerated { get; set; }
        public int? ReplyId { get; set; }
    }

}
