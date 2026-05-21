using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Single-shot Azure AI Foundry Agent service that generates creative product names,
/// descriptions, pricing, and variation suggestions for the AdventureWorks catalogue.
///
/// Foundry features used:
///   - x-memory-user-id     → scopes memory per product subcategory so the agent recalls
///                            recently designed products and produces varied names/descriptions
///                            across successive wizard runs
///   - previousResponseId   → enables within-session chaining across the wizard's product loop;
///                            each product knows what was designed earlier in the same run,
///                            preventing duplicate names within a single generation batch
///   - tool_choice: none    → no MCP tools needed; the agent reasons only over the product
///                            context supplied in the user message
/// </summary>
public class ProductContentAgentService
{
    private readonly ILogger<ProductContentAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public ProductContentAgentService(
        ILogger<ProductContentAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        var agentId = configuration["AI_AGENT_PRODUCT_CONTENT_ID"];
        _agentId = agentId ?? throw new InvalidOperationException(
            "AI_AGENT_PRODUCT_CONTENT_ID environment variable is not set");
    }

    /// <summary>
    /// Generates creative product content (name, description, pricing, variation hints) for
    /// the given product attributes.
    ///
    /// Pass <paramref name="previousResponseId"/> (the <c>ThreadId</c> from the previous
    /// product in the same wizard run) to chain the Foundry conversation so the agent avoids
    /// repeating product names within a single generation batch.
    /// </summary>
    /// <returns>
    /// A tuple of the parsed <see cref="GenerateProductContentResponse"/> and the Foundry
    /// response ID (<c>ThreadId</c>) to pass as <paramref name="previousResponseId"/> on the
    /// next call in the same wizard session.
    /// </returns>
    public async Task<(GenerateProductContentResponse Result, string? ThreadId)> GenerateProductContentAsync(
        GenerateProductContentRequest request,
        string? previousResponseId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("ProductContentAgent.Generate");
        operation.Telemetry.Properties["Category"] = request.Category;
        operation.Telemetry.Properties["Subcategory"] = request.Subcategory;
        operation.Telemetry.Properties["HasPreviousResponse"] = (!string.IsNullOrEmpty(previousResponseId)).ToString();

        try
        {
            var productLine = string.IsNullOrWhiteSpace(request.ProductLine) ? "N/A" : request.ProductLine;
            var productClass = string.IsNullOrWhiteSpace(request.Class)       ? "N/A" : request.Class;
            var style        = string.IsNullOrWhiteSpace(request.Style)       ? "N/A" : request.Style;

            // Build the available-options lines only when data is provided (wizard mode).
            var sizesLine  = (request.AvailableSizes?.Count  > 0)
                ? $"\nAvailable sizes to choose from (pick only those that make sense, may be empty): {string.Join(", ", request.AvailableSizes)}"
                : string.Empty;
            var colorsLine = (request.AvailableColors?.Count > 0)
                ? $"\nAvailable colors to choose from (pick only those that make sense, may be empty): {string.Join(", ", request.AvailableColors)}"
                : string.Empty;
            var stylesLine = (request.AvailableStyles?.Count > 0)
                ? $"\nAvailable styles to choose from (pick only those that make sense, may be empty): {string.Join(", ", request.AvailableStyles)}"
                : string.Empty;

            // All dynamic context goes in the user message.
            // The agent instructions in the Foundry portal define the output schema and tone;
            // this keeps the user message short and deterministic.
            var userMessage = $"""
                Category: {request.Category}
                Subcategory: {request.Subcategory}
                Product Line (optional): {productLine}
                Class (optional): {productClass}
                Style (optional): {style}{sizesLine}{colorsLine}{stylesLine}

                Generate the JSON object for this product.
                """;

            // Scope Foundry memory per subcategory so the agent recalls what it has recently
            // designed and produces varied names/descriptions across successive wizard runs.
            var memoryUserId = $"product-gen-{request.Subcategory.ToLowerInvariant().Replace(" ", "-")}";

            // Invoke the Foundry Responses API.
            // tool_choice: "none" — the agent reasons only over the provided product context.
            // previousResponseId enables within-wizard chaining (across the product for-loop)
            // so the agent avoids repeating names/styles in a single generation batch.
            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId,
                userMessage: userMessage,
                userId: memoryUserId,
                previousResponseId: string.IsNullOrEmpty(previousResponseId) ? null : previousResponseId,
                toolChoice: "none");

            _logger.LogInformation(
                "ProductContentAgent: Category={Category}, Subcategory={Subcategory}, ResponseLength={Length}",
                request.Category, request.Subcategory, agentResponse.ResponseText.Length);

            var result = ParseResult(agentResponse.ResponseText);

            _telemetryClient.TrackEvent("ProductContentAgent.Success", new Dictionary<string, string>
            {
                ["Category"]    = request.Category,
                ["Subcategory"] = request.Subcategory,
                ["ProductName"] = result.ProductName,
                ["ThreadId"]    = agentResponse.ResponseId ?? string.Empty
            });

            operation.Telemetry.Success = true;
            return (result, agentResponse.ResponseId);
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"]   = "ProductContentAgent.Generate",
                ["Category"]    = request.Category,
                ["Subcategory"] = request.Subcategory
            });
            throw;
        }
    }

    private static GenerateProductContentResponse ParseResult(string rawResponse)
    {
        // Strip markdown code fences if the model added them
        var cleaned = Regex.Replace(rawResponse, @"^```(?:json)?\s*", "", RegexOptions.Multiline);
        cleaned = Regex.Replace(cleaned, @"```\s*$", "", RegexOptions.Multiline).Trim();

        // Extract the JSON object
        var start = cleaned.IndexOf('{');
        var end   = cleaned.LastIndexOf('}');
        if (start >= 0 && end > start)
            cleaned = cleaned[start..(end + 1)];

        GenerateProductContentResponse result;
        try
        {
            result = JsonSerializer.Deserialize<GenerateProductContentResponse>(cleaned,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? new GenerateProductContentResponse();
        }
        catch (JsonException)
        {
            result = new GenerateProductContentResponse();
        }

        // Guard: list price must be >= standard cost
        if (result.SuggestedListPrice < result.SuggestedStandardCost && result.SuggestedStandardCost > 0)
            result.SuggestedListPrice = Math.Round(result.SuggestedStandardCost * 1.2m, 2);

        return result;
    }
}
