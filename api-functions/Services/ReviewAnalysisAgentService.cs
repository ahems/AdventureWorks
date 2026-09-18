using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Azure AI Foundry Agent service for analysing customer reviews —
/// sentiment classification, content flagging, and suggested responses.
///
/// Foundry features used:
///   - x-memory-user-id     → scopes memory per analysis session
///   - tool_choice: none    → reviews supplied in the user message
/// </summary>
public class ReviewAnalysisAgentService
{
    private readonly ILogger<ReviewAnalysisAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public ReviewAnalysisAgentService(
        ILogger<ReviewAnalysisAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        _agentId = configuration["AI_AGENT_REVIEW_ANALYSIS_ID"]
            ?? throw new InvalidOperationException(
                "AI_AGENT_REVIEW_ANALYSIS_ID environment variable is not set");
    }

    /// <summary>
    /// Analyses reviews in batches of 10, returning sentiment, flags, and a suggested response per review.
    /// </summary>
    public async Task<List<ReviewAnalysisResult>> AnalyzeReviewsAsync(List<ReviewInput> reviews)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("ReviewAnalysisAgent.Analyze");
        operation.Telemetry.Properties["ReviewCount"] = reviews.Count.ToString();

        var results = new List<ReviewAnalysisResult>();
        const int batchSize = 10;

        for (int i = 0; i < reviews.Count; i += batchSize)
        {
            var batch = reviews.Skip(i).Take(batchSize).ToList();
            try
            {
                var batchResults = await AnalyzeBatchAsync(batch);
                results.AddRange(batchResults);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Review analysis failed for batch starting at index {Index}", i);
                results.AddRange(batch.Select(r => new ReviewAnalysisResult
                {
                    ProductReviewId = r.ProductReviewId,
                    Sentiment = "neutral",
                    Flags = new List<string>(),
                    SuggestedResponse = null,
                    Error = "Analysis unavailable"
                }));
            }
        }

        operation.Telemetry.Success = true;
        return results;
    }

    private async Task<List<ReviewAnalysisResult>> AnalyzeBatchAsync(List<ReviewInput> reviews)
    {
        var reviewsJson = JsonSerializer.Serialize(reviews.Select(r => new
        {
            productReviewId = r.ProductReviewId,
            rating = r.Rating,
            reviewerName = r.ReviewerName ?? "Anonymous",
            productName = r.ProductName ?? "Unknown Product",
            comments = r.Comments ?? ""
        }), new JsonSerializerOptions { WriteIndented = false });

        var userMessage = $"""
            Analyse these customer reviews. For each review return:
            - productReviewId (copy from input)
            - sentiment: "positive", "neutral", or "negative"
            - flags: array from ["Short Review", "Potential Spam", "Refund Request", "Excessive Punctuation", "Offensive Language"]
            - suggestedResponse: a concise, professional, brand-appropriate response (2-3 sentences)

            Reviews:
            {reviewsJson}

            Return ONLY a valid JSON array. No markdown fences, no explanation.
            """;

        var agentResponse = await _foundryClient.InvokeAsync(
            agentId: _agentId,
            userMessage: userMessage,
            userId: "review-analysis",
            toolChoice: "none");

        var content = StripMarkdownFences(agentResponse.ResponseText ?? "[]");
        var batchResults = JsonSerializer.Deserialize<List<ReviewAnalysisResult>>(content,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

        return batchResults ?? reviews.Select(r => new ReviewAnalysisResult
        {
            ProductReviewId = r.ProductReviewId,
            Sentiment = "neutral",
            Flags = new List<string>(),
            Error = "Parse error"
        }).ToList();
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
}
