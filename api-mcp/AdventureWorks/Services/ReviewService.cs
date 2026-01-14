using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;
using AdventureWorks.Models;

namespace AdventureWorks.Services;

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
