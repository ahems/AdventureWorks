using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Azure AI Foundry Agent service for generating batches of product reviews
/// and staff reply texts.
///
/// This handles the "Generate Reviews" wizard and "Generate Reviews with Replies"
/// flows that produce multiple reviews per product. For single verified reviews
/// anchored to real customers, see <see cref="ReviewAgentService"/>.
///
/// Foundry features used:
///   - x-memory-user-id     → scopes memory per product category for consistent
///                            voice across review batches
///   - tool_choice: none    → all product context supplied via user message
/// </summary>
public class ReviewBatchAgentService
{
    private readonly ILogger<ReviewBatchAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public ReviewBatchAgentService(
        ILogger<ReviewBatchAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        _agentId = configuration["AI_AGENT_REVIEW_BATCH_ID"]
            ?? throw new InvalidOperationException(
                "AI_AGENT_REVIEW_BATCH_ID environment variable is not set");
    }

    /// <summary>
    /// Generates multiple reviews for a list of products.
    /// </summary>
    public async Task<List<GeneratedReview>> GenerateProductReviewsAsync(
        List<ProductForReviewGeneration> products)
    {
        var allReviews = new List<GeneratedReview>();
        foreach (var product in products)
        {
            var reviews = await GenerateReviewsForProductAsync(product);
            allReviews.AddRange(reviews);
        }
        return allReviews;
    }

    /// <summary>
    /// Generates review replies for a subset of customer reviews.
    /// Returns a dictionary keyed by ProductReviewID containing the reply text.
    /// </summary>
    public async Task<Dictionary<int, string>> GenerateReviewRepliesAsync(
        List<(int ReviewId, string ReviewerName, int Rating, string Comments, string ProductName)> reviews)
    {
        if (reviews.Count == 0) return new Dictionary<int, string>();

        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("ReviewBatchAgent.Replies");
        operation.Telemetry.Properties["ReviewCount"] = reviews.Count.ToString();

        try
        {
            var reviewsJson = JsonSerializer.Serialize(reviews.Select(r => new
            {
                reviewId = r.ReviewId,
                reviewerName = r.ReviewerName,
                rating = r.Rating,
                comments = r.Comments,
                productName = r.ProductName
            }), new JsonSerializerOptions { WriteIndented = false });

            var userMessage = $$"""
                Generate staff replies for these customer reviews. Each reply should be 2–3 sentences, warm, brand-appropriate, and signed "The AdventureWorks Team".

                Reviews:
                {{reviewsJson}}

                Return ONLY a valid JSON array:
                [{"reviewId": 123, "reply": "Thank you for your kind words! ..."}]
                """;

            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId,
                userMessage: userMessage,
                userId: "review-replies",
                toolChoice: "none");

            var content = StripMarkdownFences(agentResponse.ResponseText ?? "[]");
            var parsed = JsonSerializer.Deserialize<List<ReviewReplyItem>>(content,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            operation.Telemetry.Success = true;
            return (parsed ?? new List<ReviewReplyItem>())
                .Where(r => !string.IsNullOrWhiteSpace(r.Reply))
                .ToDictionary(r => r.ReviewId, r => r.Reply!);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GenerateReviewReplies failed");
            operation.Telemetry.Success = false;
            return new Dictionary<int, string>();
        }
    }

    private async Task<List<GeneratedReview>> GenerateReviewsForProductAsync(
        ProductForReviewGeneration product)
    {
        var random = new Random();
        var reviewCount = random.Next(1, 11);

        var sentimentRatio = random.Next(1, 4);
        var sentimentDescription = sentimentRatio switch
        {
            1 => "mostly positive (4-5 stars), with some 3-star mixed reviews",
            2 => "evenly mixed between positive (4-5 stars) and negative (1-2 stars), with some 3-star reviews",
            3 => "mostly negative (1-2 stars), with some 3-star mixed reviews",
            _ => "mixed"
        };

        _logger.LogInformation(
            "Generating {count} {sentiment} reviews for ProductID {ProductID}: {name}",
            reviewCount, sentimentDescription, product.ProductID, product.Name);

        var productJson = JsonSerializer.Serialize(new
        {
            product.ProductID,
            product.Name,
            product.Description
        }, new JsonSerializerOptions { WriteIndented = true });

        var userMessage = $"""
            Generate {reviewCount} reviews for this product with {sentimentDescription}:

            {productJson}

            Return the reviews as a JSON array with objects containing: ReviewerName, EmailAddress, Rating (1-5), Comments.
            """;

        var memoryUserId = $"review-batch-{product.ProductID}";

        try
        {
            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId,
                userMessage: userMessage,
                userId: memoryUserId,
                toolChoice: "none");

            var content = agentResponse.ResponseText;
            var jsonStart = content.IndexOf('[');
            var jsonEnd = content.LastIndexOf(']') + 1;

            if (jsonStart == -1 || jsonEnd <= jsonStart)
            {
                _logger.LogWarning("No valid JSON array found in response for ProductID {ProductID}", product.ProductID);
                return new List<GeneratedReview>();
            }

            var json = content.Substring(jsonStart, jsonEnd - jsonStart);
            var generatedReviews = JsonSerializer.Deserialize<List<GeneratedReview>>(json);

            if (generatedReviews != null)
            {
                var sellStartDate = product.SellStartDate;
                var currentDate = DateTime.UtcNow;
                var daysBetween = (currentDate - sellStartDate).TotalDays;

                foreach (var review in generatedReviews)
                {
                    review.ProductID = product.ProductID;
                    var randomDays = random.Next(0, (int)daysBetween + 1);
                    review.ReviewDate = sellStartDate.AddDays(randomDays);
                }

                _logger.LogInformation("Generated {count} reviews for ProductID {ProductID}",
                    generatedReviews.Count, product.ProductID);
                return generatedReviews;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to generate reviews for ProductID {ProductID}", product.ProductID);
        }

        return new List<GeneratedReview>();
    }

    private static string StripMarkdownFences(string text)
    {
        var trimmed = text.Trim();
        if (trimmed.StartsWith("```"))
        {
            var firstNewline = trimmed.IndexOf('\n');
            if (firstNewline >= 0) trimmed = trimmed[(firstNewline + 1)..];
            if (trimmed.EndsWith("```")) trimmed = trimmed[..^3];
        }
        return trimmed.Trim();
    }

    private class ReviewReplyItem
    {
        public int ReviewId { get; set; }
        public string? Reply { get; set; }
    }
}
