using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Azure AI Foundry Agent service for suggesting new product categories
/// and subcategories for the AdventureWorks catalog.
///
/// Foundry features used:
///   - x-memory-user-id     → scopes memory so successive runs produce varied
///                            suggestions rather than repeating choices
///   - tool_choice: none    → existing category hierarchy supplied in user message
/// </summary>
public class CatalogSuggestionAgentService
{
    private readonly ILogger<CatalogSuggestionAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public CatalogSuggestionAgentService(
        ILogger<CatalogSuggestionAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        _agentId = configuration["AI_AGENT_CATALOG_SUGGESTION_ID"]
            ?? throw new InvalidOperationException(
                "AI_AGENT_CATALOG_SUGGESTION_ID environment variable is not set");
    }

    /// <summary>
    /// Suggests a new top-level product category not already in the hierarchy.
    /// Returns (true, name) if a suggestion was made, (false, "") otherwise.
    /// </summary>
    public async Task<(bool Suggested, string Name)> SuggestNewCategoryAsync(
        List<CategoryHierarchyItem> existingCategories,
        List<SubcategoryHierarchyItem> existingSubcategories)
    {
        var hierarchyJson = BuildCategoryHierarchyJson(existingCategories, existingSubcategories);

        var userMessage = $$"""
            Suggestion type: category
            Current AdventureWorks category hierarchy:
            {{hierarchyJson}}

            Suggest a new top-level category. Return ONLY a JSON object: {"suggested": true/false, "name": "..."}
            """;

        return await InvokeAndParseSuggestion(userMessage, "category-suggestion");
    }

    /// <summary>
    /// Suggests a new subcategory for a given parent category.
    /// Returns (true, name) if a suggestion was made, (false, "") otherwise.
    /// </summary>
    public async Task<(bool Suggested, string Name)> SuggestNewSubcategoryAsync(
        int categoryId,
        string categoryName,
        List<CategoryHierarchyItem> allCategories,
        List<SubcategoryHierarchyItem> allSubcategories)
    {
        var hierarchyJson = BuildCategoryHierarchyJson(allCategories, allSubcategories);

        var existingSubsForCategory = allSubcategories
            .Where(s => s.ProductCategoryID == categoryId)
            .Select(s => s.Name)
            .ToList();

        var userMessage = $$"""
            Suggestion type: subcategory
            Full AdventureWorks category hierarchy for context:
            {{hierarchyJson}}

            Target parent category: "{{categoryName}}"
            Existing subcategories for "{{categoryName}}": {{JsonSerializer.Serialize(existingSubsForCategory)}}

            Suggest a new subcategory for the "{{categoryName}}" category. Return ONLY a JSON object: {"suggested": true/false, "name": "..."}
            """;

        return await InvokeAndParseSuggestion(userMessage, $"subcategory-suggestion-{categoryName.ToLowerInvariant().Replace(" ", "-")}");
    }

    private async Task<(bool Suggested, string Name)> InvokeAndParseSuggestion(
        string userMessage, string memoryUserId)
    {
        var agentResponse = await _foundryClient.InvokeAsync(
            agentId: _agentId,
            userMessage: userMessage,
            userId: memoryUserId,
            toolChoice: "none");

        var content = StripMarkdownFences(agentResponse.ResponseText ?? "{}");

        using var doc = JsonDocument.Parse(content);
        var root = doc.RootElement;

        var suggested = root.TryGetProperty("suggested", out var sugProp) && sugProp.GetBoolean();
        var name = root.TryGetProperty("name", out var nameProp) && nameProp.ValueKind == JsonValueKind.String
            ? nameProp.GetString() ?? string.Empty
            : string.Empty;

        return (suggested && !string.IsNullOrWhiteSpace(name), name);
    }

    private static string BuildCategoryHierarchyJson(
        List<CategoryHierarchyItem> categories,
        List<SubcategoryHierarchyItem> subcategories)
    {
        var hierarchy = categories.Select(c => new
        {
            category = c.Name,
            subcategories = subcategories
                .Where(s => s.ProductCategoryID == c.ProductCategoryID)
                .Select(s => s.Name)
                .ToList()
        });
        return JsonSerializer.Serialize(hierarchy, new JsonSerializerOptions { WriteIndented = true });
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
