using System.Data;
using Azure.Identity;
using Dapper;
using Microsoft.Data.SqlClient;
using api_functions.Models;

namespace api_functions.Services;

public class ReviewService
{
    private readonly string _connectionString;

    public ReviewService(string connectionString)
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

    public async Task<List<ProductForReviewGeneration>> GetProductsForReviewGenerationAsync()
    {
        using var connection = await GetConnectionAsync();

        // Get all finished goods products with their English descriptions and review counts
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
            GROUP BY p.ProductID, p.Name, pd.Description, p.SellStartDate
            ORDER BY p.ProductID";

        var products = await connection.QueryAsync<ProductForReviewGeneration>(sql);
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

}
