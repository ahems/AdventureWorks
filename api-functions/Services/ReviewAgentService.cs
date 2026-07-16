using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Single-shot Azure AI Foundry Agent service that generates one product review
/// from the perspective of a real customer who purchased and received the product.
///
/// Foundry features used:
///   - x-memory-user-id → scopes memory per product category for consistent voice
///   - tool_choice: none → all context supplied via structured_inputs; no MCP calls needed
///   - structured_inputs → resolves {{productName}}, {{productDescription}},
///                         {{customerFirstName}}, {{sentimentDescription}} in agent instructions
///
/// Graceful fallback: if AI_AGENT_REVIEW_ID is not set (e.g. during the transition
/// window before the agent is provisioned), the caller should fall back to
/// <see cref="AIService.GenerateReviewForCustomerAsync"/> rather than failing.
/// </summary>
public class ReviewAgentService
{
    private readonly ILogger<ReviewAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string? _agentId;

    // Sentiment options — same ratio as the previous direct-OpenAI implementation
    private static readonly string[] _sentiments =
    [
        "positive (4-5 stars)",
        "mixed (2-4 stars)",
        "mostly positive with one specific complaint (3-4 stars)"
    ];

    public ReviewAgentService(
        ILogger<ReviewAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        _agentId = configuration["AI_AGENT_REVIEW_ID"]
            ?? throw new InvalidOperationException(
                "AI_AGENT_REVIEW_ID environment variable is not set");
    }

    /// <summary>
    /// Generates a single product review anchored to the supplied customer identity.
    /// Returns null if the agent response cannot be parsed.
    /// </summary>
    public async Task<GeneratedReview?> GenerateReviewAsync(
        ProductForReviewGeneration product,
        CustomerWithDeliveredOrder customer)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("ReviewAgent.GenerateReview");
        operation.Telemetry.Properties["ProductID"] = product.ProductID.ToString();
        operation.Telemetry.Properties["CustomerID"] = customer.CustomerID.ToString();

        var rng = new Random();
        var sentimentDescription = _sentiments[rng.Next(_sentiments.Length)];

        // Structured inputs resolve Handlebars {{variables}} in the agent instructions.
        // The user message is minimal — all real context lives in the structured inputs.
        var structuredInputs = new Dictionary<string, object>
        {
            ["productName"] = product.Name,
            ["productDescription"] = product.Description ?? string.Empty,
            ["customerFirstName"] = customer.FirstName,
            ["sentimentDescription"] = sentimentDescription
        };

        // Scope memory per product to build consistent category voice without
        // mixing contexts across different product types.
        var memoryUserId = $"review-gen-product-{product.ProductID}";

        try
        {
            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId!,
                userMessage: "Generate one review as described in the instructions.",
                userId: memoryUserId,
                structuredInputs: structuredInputs,
                toolChoice: "none");

            var responseText = agentResponse.ResponseText;

            if (string.IsNullOrWhiteSpace(responseText))
            {
                _logger.LogWarning("ReviewAgent returned empty response for ProductID={ProductID}", product.ProductID);
                operation.Telemetry.Success = false;
                return null;
            }

            // Strip markdown fences if the model included them despite instructions
            var jsonStart = responseText.IndexOf('{');
            var jsonEnd = responseText.LastIndexOf('}') + 1;

            if (jsonStart == -1 || jsonEnd <= jsonStart)
            {
                _logger.LogWarning("ReviewAgent response contains no JSON object for ProductID={ProductID}: {Response}",
                    product.ProductID, responseText);
                operation.Telemetry.Success = false;
                return null;
            }

            var json = responseText.Substring(jsonStart, jsonEnd - jsonStart);

            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var rating = root.TryGetProperty("Rating", out var ratingEl) ? ratingEl.GetInt32() : 4;
            var comments = root.TryGetProperty("Comments", out var commentsEl)
                ? commentsEl.GetString() ?? string.Empty
                : string.Empty;

            rating = Math.Max(1, Math.Min(5, rating));

            // Review date: random between delivery date and now.
            // Guard against future delivery dates (simulator may create orders
            // with future OrderDate values) — clamp to today.
            var deliveryDate = customer.DeliveryDate;
            var now = DateTime.UtcNow;
            var effectiveDelivery = deliveryDate > now ? now.Date : deliveryDate;
            var daysBetween = Math.Max(0, (int)(now - effectiveDelivery).TotalDays);
            var reviewDate = effectiveDelivery.AddDays(rng.Next(0, daysBetween + 1));

            _telemetryClient.TrackEvent("ReviewAgentInvoked", new Dictionary<string, string>
            {
                ["ProductID"] = product.ProductID.ToString(),
                ["CustomerID"] = customer.CustomerID.ToString(),
                ["Sentiment"] = sentimentDescription,
                ["Rating"] = rating.ToString(),
                ["InputTokens"] = agentResponse.InputTokens.ToString(),
                ["OutputTokens"] = agentResponse.OutputTokens.ToString()
            });

            operation.Telemetry.Success = true;

            return new GeneratedReview
            {
                ProductID = product.ProductID,
                // Always override with real customer identity — never use AI-generated name/email
                ReviewerName = $"{customer.FirstName} {customer.LastName}".Trim(),
                EmailAddress = customer.EmailAddress,
                Rating = rating,
                Comments = comments,
                ReviewDate = reviewDate
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ReviewAgent failed for ProductID={ProductID}, CustomerID={CustomerID}",
                product.ProductID, customer.CustomerID);
            operation.Telemetry.Success = false;
            throw;
        }
    }
}
