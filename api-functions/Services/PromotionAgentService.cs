using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;

namespace api_functions.Services;

/// <summary>
/// Single-shot Azure AI Foundry Agent service that generates promotion suggestions by
/// reasoning over live inventory and sales data retrieved via the MCP server's
/// GetProductsForPromotion tool.
/// </summary>
public class PromotionAgentService
{
    private readonly ILogger<PromotionAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public PromotionAgentService(
        ILogger<PromotionAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        _agentId = configuration["AI_AGENT_PROMOTION_ID"]
            ?? throw new InvalidOperationException("AI_AGENT_PROMOTION_ID environment variable is not set");
    }

    /// <summary>
    /// Generate a promotion suggestion for the given parameters.
    /// Uses the Foundry agent's MCP GetProductsForPromotion tool to retrieve live data,
    /// then reasons about appropriate products, discount %, and campaign framing.
    /// </summary>
    public async Task<PromotionSuggestion> GeneratePromotionAsync(
        string promotionType,
        string offerCategory,
        int? categoryId = null,
        string? categoryName = null,
        int? subcategoryId = null,
        string? subcategoryName = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("PromotionAgent.Generate");
        operation.Telemetry.Properties["PromotionType"] = promotionType;
        operation.Telemetry.Properties["OfferCategory"] = offerCategory;
        operation.Telemetry.Properties["CategoryId"] = categoryId?.ToString() ?? "all";

        var startTime = DateTimeOffset.UtcNow;

        try
        {
            var categoryContext = subcategoryName != null
                ? $"in subcategory '{subcategoryName}'"
                : categoryName != null
                    ? $"in category '{categoryName}'"
                    : "across all product categories";

            var today = DateTime.UtcNow.ToString("yyyy-MM-dd");
            var userMessage = $@"Create a '{promotionType}' promotion targeting '{offerCategory}' customers {categoryContext}.

Today's date: {today}

Instructions:
1. Call GetProductsForPromotion with promotionType=""{promotionType}""{(subcategoryId.HasValue ? $", productSubcategoryId={subcategoryId}" : categoryId.HasValue ? $", productCategoryId={categoryId}" : "")} to retrieve live product data.
2. Analyse the inventory levels and recent sales data to select 3-8 products that are the best fit for this promotion type.
3. For Clearance: prefer products with HIGH inventory and LOW recent sales (slow-moving stock).
4. For Volume Discount: prefer products with HIGH recent sales (amplify popular items).
5. For Seasonal/Promotional: pick a balanced, representative set from the filtered category.
6. Choose a discount percentage appropriate to the type: Clearance 20-40%, Volume Discount 5-15%, Seasonal 10-25%, Promotional 5-20%, Customer/Reseller Discount 10-30%.
7. Set StartDate to today ({today}) and EndDate 30 days later (for seasonal/clearance) or 14 days later (for volume/promotional).

Return ONLY a valid JSON object matching this schema (no markdown, no explanation):
{{
  ""description"": ""Short promotional description (max 120 chars)"",
  ""discountPct"": 0.10,
  ""type"": ""{promotionType}"",
  ""category"": ""{offerCategory}"",
  ""startDate"": ""YYYY-MM-DD"",
  ""endDate"": ""YYYY-MM-DD"",
  ""minQty"": 1,
  ""suggestedProducts"": [
    {{
      ""productId"": 123,
      ""productName"": ""Product Name"",
      ""currentPrice"": 99.99,
      ""inventoryLevel"": 50,
      ""recentSalesCount"": 5,
      ""reason"": ""Brief reason for including this product""
    }}
  ],
  ""aiReasoning"": ""2-3 sentence explanation of the promotion strategy""
}}";

            // Invoke the Foundry agent via the Responses API (stateless single-shot).
            // The agent calls GetProductsForPromotion via MCP server-side.
            var agentResponse = await _foundryClient.InvokeAsync(_agentId, userMessage);
            var rawResponse = agentResponse.ResponseText;

            _logger.LogInformation("PromotionAgent raw response length: {Length}, tools used: {Tools}",
                rawResponse.Length, string.Join(",", agentResponse.ToolsUsed));

            var suggestion = ParsePromotionSuggestion(rawResponse);

            var duration = DateTimeOffset.UtcNow - startTime;
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("PromotionAgent.Success", new Dictionary<string, string>
            {
                ["PromotionType"] = promotionType,
                ["ProductCount"] = suggestion.SuggestedProducts.Count.ToString(),
                ["DurationMs"] = duration.TotalMilliseconds.ToString("F0")
            });

            return suggestion;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PromotionAgent failed for type={Type}", promotionType);
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"] = "PromotionAgent.Generate",
                ["PromotionType"] = promotionType
            });
            throw;
        }
    }

    private static PromotionSuggestion ParsePromotionSuggestion(string rawResponse)
    {
        // Strip markdown code fences if present
        var cleaned = Regex.Replace(rawResponse, @"^```(?:json)?\s*", "", RegexOptions.Multiline);
        cleaned = Regex.Replace(cleaned, @"```\s*$", "", RegexOptions.Multiline).Trim();

        // Extract JSON object
        var start = cleaned.IndexOf('{');
        var end = cleaned.LastIndexOf('}');
        if (start >= 0 && end > start)
            cleaned = cleaned.Substring(start, end - start + 1);

        return JsonSerializer.Deserialize<PromotionSuggestion>(cleaned,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("AI returned unparseable JSON");
    }

    // The system prompt and tool configuration are managed in Azure AI Foundry on the agent definition.
}

/// <summary>Structured promotion suggestion returned by the AI agent.</summary>
public class PromotionSuggestion
{
    public string Description { get; set; } = string.Empty;
    public decimal DiscountPct { get; set; }
    public string Type { get; set; } = string.Empty;
    public string Category { get; set; } = string.Empty;
    public string StartDate { get; set; } = string.Empty;
    public string EndDate { get; set; } = string.Empty;
    public int MinQty { get; set; } = 1;
    public List<SuggestedProduct> SuggestedProducts { get; set; } = new();
    public string AiReasoning { get; set; } = string.Empty;
}

public class SuggestedProduct
{
    public int ProductId { get; set; }
    public string ProductName { get; set; } = string.Empty;
    public decimal CurrentPrice { get; set; }
    public int InventoryLevel { get; set; }
    public int RecentSalesCount { get; set; }
    public string Reason { get; set; } = string.Empty;
}
