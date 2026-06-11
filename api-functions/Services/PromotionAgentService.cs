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
///
/// Foundry features used:
///   - structured_inputs    → promotion type, category, and date context resolved via Handlebars
///                            templates in the agent instructions; keeps the user message short
///   - x-memory-user-id     → scopes memory per promotion type so the agent recalls recent
///                            promotions and generates varied campaigns across successive runs
///   - previousResponseId   → enables admin refinement turns (e.g. 'increase discount to 20%')
///                            by continuing a stored Foundry conversation
///   - tool_choice: required → ensures the agent always calls GetProductsForPromotion;
///                             prevents fabricated product lists from reaching the response
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

        // Use the plain promotion agent (not the workflow orchestrator variant) because
        // PromotionAgentService relies on structured_inputs + tool_choice="required" which are
        // configured only on admin-promotion-agent. The workflow agent is a Foundry orchestrator
        // without tool/instruction setup and would return unstructured prose.
        var agentId = configuration["AI_AGENT_PROMOTION_ID"];
        _agentId = agentId ?? throw new InvalidOperationException(
            "AI_AGENT_PROMOTION_ID environment variable is not set");
    }

    /// <summary>
    /// Generate a promotion suggestion for the given parameters.
    /// Uses the Foundry agent's MCP GetProductsForPromotion tool to retrieve live data,
    /// then reasons about appropriate products, discount %, and campaign framing.
    /// Pass <paramref name="previousResponseId"/> to continue a refinement conversation
    /// (e.g. admin adjusts discount or target category in a follow-up turn).
    /// </summary>
    public async Task<PromotionSuggestionResult> GeneratePromotionAsync(
        string promotionType,
        string offerCategory,
        int? categoryId = null,
        string? categoryName = null,
        int? subcategoryId = null,
        string? subcategoryName = null,
        string? previousResponseId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("PromotionAgent.Generate");
        operation.Telemetry.Properties["PromotionType"] = promotionType;
        operation.Telemetry.Properties["OfferCategory"] = offerCategory;
        operation.Telemetry.Properties["CategoryId"] = categoryId?.ToString() ?? "all";

        var startTime = DateTimeOffset.UtcNow;

        try
        {
            var today = DateTime.UtcNow.ToString("yyyy-MM-dd");

            // Build structured inputs to resolve Handlebars templates in the agent's Foundry
            // portal instructions. This replaces the inline categoryContext string-building and
            // the large interpolated userMessage that was here before.
            var structuredInputs = new Dictionary<string, object>
            {
                ["promotionType"]  = promotionType,
                ["offerCategory"]  = offerCategory,
                ["todayDate"]      = today
            };

            // Category/subcategory values are nullable; only add them when present so the
            // agent's {{#if categoryName}}...{{/if}} Handlebars blocks resolve correctly.
            if (!string.IsNullOrEmpty(categoryName))
                structuredInputs["categoryName"] = categoryName;
            if (!string.IsNullOrEmpty(subcategoryName))
                structuredInputs["subcategoryName"] = subcategoryName;
            if (categoryId.HasValue)
                structuredInputs["categoryId"] = categoryId.Value;
            if (subcategoryId.HasValue)
                structuredInputs["subcategoryId"] = subcategoryId.Value;

            // Scope Foundry memory per promotion type so the agent recalls what it recently
            // generated and produces more varied campaigns across successive admin runs.
            var memoryUserId = $"promotion-gen-{promotionType}";

            // The user message is now a short constant — all dynamic context lives in
            // structured_inputs which resolve the Handlebars templates in the agent instructions.
            const string userMessage = "Generate a promotion campaign following the instructions.";

            // Invoke the Foundry agent via the Responses API (supports multi-turn refinement).
            // Passing previousResponseId continues a stored conversation so the admin can
            // refine the suggestion (e.g. 'increase discount to 25%') without losing context.
            // tool_choice: "required" ensures the agent always calls GetProductsForPromotion;
            // prevents hallucinated product lists from appearing in the response.
            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId,
                userMessage: userMessage,
                userId: memoryUserId,
                previousResponseId: string.IsNullOrEmpty(previousResponseId) ? null : previousResponseId,
                structuredInputs: structuredInputs,
                toolChoice: "required");
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
                ["DurationMs"] = duration.TotalMilliseconds.ToString("F0"),
                ["ThreadId"] = agentResponse.ResponseId ?? string.Empty
            });

            return new PromotionSuggestionResult
            {
                Suggestion = suggestion,
                ThreadId   = agentResponse.ResponseId
            };
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
    public decimal StandardCost { get; set; }
    public int InventoryLevel { get; set; }
    public int RecentSalesCount { get; set; }
    public string Reason { get; set; } = string.Empty;
}

/// <summary>
/// Wraps a <see cref="PromotionSuggestion"/> with the Foundry response ID so callers
/// can chain refinement turns by passing ThreadId back as previousResponseId.
/// </summary>
public class PromotionSuggestionResult
{
    /// <summary>The AI-generated promotion suggestion.</summary>
    public PromotionSuggestion Suggestion { get; set; } = new();

    /// <summary>
    /// Foundry response ID. Pass back as previousResponseId in subsequent refinement
    /// requests to continue the stored conversation (multi-turn refinement).
    /// </summary>
    public string? ThreadId { get; set; }
}
