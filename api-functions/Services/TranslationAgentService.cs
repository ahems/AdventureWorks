using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Azure AI Foundry Agent service for translating product descriptions,
/// marketing text, and i18n language files into multiple target languages.
///
/// Foundry features used:
///   - x-memory-user-id     → scopes memory per target locale for consistent
///                            terminology and style across translation runs
///   - tool_choice: none    → all context supplied via the user message;
///                            no MCP tool calls needed
/// </summary>
public class TranslationAgentService
{
    private readonly ILogger<TranslationAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public TranslationAgentService(
        ILogger<TranslationAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        _agentId = configuration["AI_AGENT_TRANSLATION_ID"]
            ?? throw new InvalidOperationException(
                "AI_AGENT_TRANSLATION_ID environment variable is not set");
    }

    /// <summary>
    /// Translates a product description into multiple target cultures.
    /// Returns a list of translated descriptions.
    /// </summary>
    public async Task<List<TranslatedDescription>> TranslateProductAsync(
        TranslationRequest request,
        List<CultureInfo> targetCultures)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("TranslationAgent.TranslateProduct");
        operation.Telemetry.Properties["ProductModelID"] = request.ProductModelID.ToString();
        operation.Telemetry.Properties["TargetCultureCount"] = targetCultures.Count.ToString();

        try
        {
            var culturesJson = JsonSerializer.Serialize(
                targetCultures.Select(c => new { CultureID = c.CultureID.Trim(), CultureName = c.Name }),
                new JsonSerializerOptions { WriteIndented = true });

            var userMessage = $"""
                Translation mode: product
                Product: {request.ProductName}

                English Description:
                {request.EnglishDescription}

                Target Languages:
                {culturesJson}

                Translate the description into each target language. Return ONLY a valid JSON object with a 'translations' array.
                """;

            var memoryUserId = "translation-product";

            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId,
                userMessage: userMessage,
                userId: memoryUserId,
                toolChoice: "none");

            var results = ParseTranslatedDescriptions(agentResponse.ResponseText, request.ProductModelID);

            _telemetryClient.TrackEvent("TranslationAgent.ProductTranslated", new Dictionary<string, string>
            {
                ["ProductModelID"] = request.ProductModelID.ToString(),
                ["TranslationsGenerated"] = results.Count.ToString()
            });

            operation.Telemetry.Success = true;
            return results;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"] = "TranslationAgent.TranslateProduct",
                ["ProductModelID"] = request.ProductModelID.ToString()
            });
            throw;
        }
    }

    /// <summary>
    /// Translates a batch of product descriptions into multiple target cultures.
    /// </summary>
    public async Task<List<TranslatedDescription>> TranslateDescriptionsAsync(
        List<TranslationRequest> requests,
        List<CultureInfo> targetCultures)
    {
        var translations = new List<TranslatedDescription>();
        foreach (var request in requests)
        {
            var productTranslations = await TranslateProductAsync(request, targetCultures);
            translations.AddRange(productTranslations);
        }
        return translations;
    }

    /// <summary>
    /// Translates a short text (e.g. a promotion description) into multiple target cultures.
    /// </summary>
    public async Task<List<TextTranslation>> TranslateTextAsync(
        string text,
        string context,
        List<CultureInfo> targetCultures)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("TranslationAgent.TranslateText");
        operation.Telemetry.Properties["TargetCultureCount"] = targetCultures.Count.ToString();

        try
        {
            var culturesJson = JsonSerializer.Serialize(
                targetCultures.Select(c => new { CultureID = c.CultureID.Trim(), CultureName = c.Name }),
                new JsonSerializerOptions { WriteIndented = true });

            var userMessage = $"""
                Translation mode: text
                Context: {context}

                Original English text:
                {text}

                Target languages:
                {culturesJson}

                Translate the text into each target language. Return ONLY a valid JSON object with a 'translations' array containing objects with CultureID and TranslatedText fields.
                """;

            var memoryUserId = "translation-text";

            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId,
                userMessage: userMessage,
                userId: memoryUserId,
                toolChoice: "none");

            var results = ParseTextTranslations(agentResponse.ResponseText);

            operation.Telemetry.Success = true;
            return results;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"] = "TranslationAgent.TranslateText"
            });
            throw;
        }
    }

    /// <summary>
    /// Translates a single text string into one target language.
    /// </summary>
    public async Task<string> TranslateSingleTextAsync(
        string text,
        string languageCode,
        string languageName)
    {
        try
        {
            var userMessage = $"""
                Translation mode: text
                Target language code: {languageCode}
                Target language name: {languageName}

                Text to translate:
                {text}

                Return ONLY the translated text, nothing else.
                """;

            var memoryUserId = $"translation-{languageCode}";

            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId,
                userMessage: userMessage,
                userId: memoryUserId,
                toolChoice: "none");

            var translatedText = agentResponse.ResponseText?.Trim();
            return string.IsNullOrWhiteSpace(translatedText) ? text : translatedText;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Translation failed for {Language}: {Message}", languageName, ex.Message);
            throw new InvalidOperationException($"Translation failed for {languageName}: {ex.Message}");
        }
    }

    /// <summary>
    /// Translates a full i18n JSON language file.
    /// </summary>
    public async Task<JsonElement> TranslateLanguageFileAsync(
        JsonElement languageData,
        string languageCode,
        string languageName)
    {
        var userMessage = $"""
            Translation mode: languageFile
            Target language code: {languageCode}
            Target language name: {languageName}

            Here is the English language file to translate to {languageName}:

            {JsonSerializer.Serialize(languageData, new JsonSerializerOptions { WriteIndented = true })}

            Return the complete translated version with all values translated to {languageName}, keeping all keys in English.
            """;

        var memoryUserId = $"translation-langfile-{languageCode}";

        _logger.LogInformation("Sending language file translation request for {Language}", languageName);

        var agentResponse = await _foundryClient.InvokeAsync(
            agentId: _agentId,
            userMessage: userMessage,
            userId: memoryUserId,
            toolChoice: "none");

        var content = agentResponse.ResponseText;

        _logger.LogInformation("Received translation response for {Language}: {Length} characters",
            languageName, content?.Length ?? 0);

        if (string.IsNullOrWhiteSpace(content))
        {
            throw new InvalidOperationException($"Empty response from AI for {languageName} translation");
        }

        // Strip markdown fences if present
        content = StripMarkdownFences(content);

        try
        {
            return JsonSerializer.Deserialize<JsonElement>(content);
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "Failed to parse AI translation response for {Language}", languageName);
            throw new InvalidOperationException($"AI returned invalid JSON for {languageName} translation", ex);
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private List<TranslatedDescription> ParseTranslatedDescriptions(string rawResponse, int productModelId)
    {
        var cleaned = StripMarkdownFences(rawResponse);

        try
        {
            var wrapper = JsonSerializer.Deserialize<TranslationWrapper>(cleaned,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            var results = wrapper?.Translations ?? new List<TranslatedDescription>();
            foreach (var t in results)
                t.ProductModelID = productModelId;
            return results;
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "Failed to parse translation response for ProductModelID {Id}", productModelId);
            return new List<TranslatedDescription>();
        }
    }

    private static List<TextTranslation> ParseTextTranslations(string rawResponse)
    {
        var cleaned = StripMarkdownFences(rawResponse);

        try
        {
            var wrapper = JsonSerializer.Deserialize<TextTranslationWrapper>(cleaned,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            return wrapper?.Translations ?? new List<TextTranslation>();
        }
        catch
        {
            return new List<TextTranslation>();
        }
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
