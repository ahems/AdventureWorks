using System.Data;
using System.Text.Json;
using System.Globalization;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Localization;
using AdventureWorks.Models;
using AdventureWorks.Resources;

namespace AdventureWorks.Services;

public class ReviewService
{
    private readonly string _connectionString;
    private readonly IStringLocalizer<Strings> _localizer;

    public ReviewService(string connectionString, IStringLocalizer<Strings> localizer)
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

    public async Task<string> AnalyzeProductReviewsAsync(int productId, string cultureId = "en")
    {
        CultureInfo.CurrentUICulture = new CultureInfo(cultureId);

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
            return _localizer["NoReviews", productId].Value;
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
        result.AppendLine(_localizer["ReviewAnalysis", productName ?? $"Product #{productId}"].Value);
        result.AppendLine();
        result.AppendLine(_localizer["OverallRating", averageRating, GetStarDisplay(averageRating)].Value);
        result.AppendLine(_localizer["TotalReviews", totalReviews].Value);
        result.AppendLine();
        result.AppendLine(_localizer["RatingDistribution"].Value);
        foreach (var dist in ratingDistribution)
        {
            var percentage = (dist.Count * 100.0 / totalReviews);
            result.AppendLine($"  {_localizer["StarReviews", dist.Rating, dist.Count, percentage].Value}");
        }

        if (positiveReviews.Any())
        {
            result.AppendLine();
            result.AppendLine(_localizer["WhatCustomersLove"].Value);
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
            result.AppendLine(_localizer["CommonConcerns"].Value);
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
        result.AppendLine(_localizer["LatestReview", latestReview.ReviewDate, latestReview.ReviewerName ?? _localizer["Anonymous"].Value].Value);

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

    private static readonly HashSet<string> SupportedCultures = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ar", "en", "es", "fr", "he", "th", "zh-cht",
        "en-gb", "en-ca", "en-au", "ja", "ko", "de"
    };

    public async Task<List<SemanticSearchResult>> SearchProductsByReviewEmbeddingAsync(float[] queryEmbedding, int topN = 10, string cultureId = "en")
    {
        // Validate culture ID
        if (!SupportedCultures.Contains(cultureId))
        {
            throw new ArgumentException($"Unsupported culture '{cultureId}'. Supported cultures: {string.Join(", ", SupportedCultures)}", nameof(cultureId));
        }

        using var connection = await GetConnectionAsync();

        // Use VECTOR_DISTANCE for semantic similarity search with native VECTOR columns
        // Returns products with reviews that are most similar to the query
        // Convert float array to JSON for CAST to VECTOR
        var embeddingJson = JsonSerializer.Serialize(queryEmbedding);

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
              AND pmpdc.CultureID = @CultureId
            ORDER BY VECTOR_DISTANCE('cosine', pr.CommentsEmbedding, CAST(@QueryEmbedding AS VECTOR(1536)))";

        var results = await connection.QueryAsync<SemanticSearchResult>(sql, new
        {
            TopN = topN,
            QueryEmbedding = embeddingJson,
            CultureId = cultureId
        });

        return results.ToList();
    }
}
