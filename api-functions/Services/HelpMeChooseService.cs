using System.Text.Json;
using System.Text.Json.Serialization;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Dapper;

namespace api_functions.Services;

/// <summary>
/// Service that powers the "Help Me Choose" wizard experience.
/// Step 1: generates personalised questions using AI (direct OpenAI).
/// Step 2: takes user answers, uses the Foundry agent (which calls MCP tools) to browse
///         the live catalog and returns ranked product recommendations with explanations.
/// </summary>
public class HelpMeChooseService
{
    private readonly ILogger<HelpMeChooseService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;
    private readonly string _endpoint;
    private readonly string _modelDeployment;
    private readonly string _sqlConnectionString;

    // Cached category tree — fetched once per service lifetime.
    private string? _catalogDescription;
    private readonly SemaphoreSlim _catalogLock = new(1, 1);

    // Cached catalog meta (colors + bike sizes) — fetched once per service lifetime.
    private CatalogMeta? _catalogMeta;
    private readonly SemaphoreSlim _metaLock = new(1, 1);

    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public HelpMeChooseService(
        ILogger<HelpMeChooseService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        _endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");
        _modelDeployment = configuration["chatGptDeploymentName"] ?? "chat";

        _sqlConnectionString = configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        _agentId = configuration["AI_AGENT_HELP_ME_CHOOSE_ID"]
            ?? throw new InvalidOperationException("AI_AGENT_HELP_ME_CHOOSE_ID environment variable is not set");

        _logger.LogInformation("HelpMeChooseService configured — endpoint: {Endpoint}, agent: {AgentId}",
            _endpoint, _agentId);
    }

    // -----------------------------------------------------------------------
    // Catalog description (cached)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Builds a human-readable summary of every category and its subcategories
    /// by querying Production.ProductCategory / ProductSubcategory.
    /// Result is cached for the lifetime of the service instance.
    /// </summary>
    private async Task<string> GetCatalogDescriptionAsync()
    {
        if (_catalogDescription != null) return _catalogDescription;

        await _catalogLock.WaitAsync();
        try
        {
            if (_catalogDescription != null) return _catalogDescription;

            const string sql = @"
                SELECT
                    pc.Name  AS CategoryName,
                    ps.Name  AS SubcategoryName
                FROM Production.ProductCategory pc
                LEFT JOIN Production.ProductSubcategory ps
                    ON ps.ProductCategoryID = pc.ProductCategoryID
                ORDER BY pc.Name, ps.Name";

            using var conn = new SqlConnection(_sqlConnectionString);
            await conn.OpenAsync();

            var rows = await conn.QueryAsync<(string CategoryName, string? SubcategoryName)>(sql);

            // Group into category → list of subcategories
            var grouped = rows
                .GroupBy(r => r.CategoryName)
                .OrderBy(g => g.Key)
                .ToDictionary(
                    g => g.Key,
                    g => g
                        .Where(r => r.SubcategoryName != null)
                        .Select(r => r.SubcategoryName!)
                        .OrderBy(s => s)
                        .ToList());

            var lines = new System.Text.StringBuilder();
            foreach (var (category, subcategories) in grouped)
            {
                if (subcategories.Count > 0)
                    lines.AppendLine($"  - {category}: {string.Join(", ", subcategories)}");
                else
                    lines.AppendLine($"  - {category}");
            }

            _catalogDescription = lines.ToString().TrimEnd();
            _logger.LogInformation("Catalog description loaded ({Lines} categories)", grouped.Count);
            return _catalogDescription;
        }
        finally
        {
            _catalogLock.Release();
        }
    }

    // -----------------------------------------------------------------------
    // Catalog meta (colors + bike sizes)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Returns all distinct product colours and all distinct bike frame sizes from the catalog.
    /// Result is cached for the lifetime of the service instance.
    /// </summary>
    public async Task<CatalogMeta> GetCatalogMetaAsync()
    {
        if (_catalogMeta != null) return _catalogMeta;

        await _metaLock.WaitAsync();
        try
        {
            if (_catalogMeta != null) return _catalogMeta;

            const string colorSql = @"
                SELECT DISTINCT Color
                FROM Production.Product
                WHERE Color IS NOT NULL AND Color != ''
                ORDER BY Color";

            const string sizeSql = @"
                SELECT DISTINCT p.Size
                FROM Production.Product p
                JOIN Production.ProductSubcategory ps
                    ON p.ProductSubcategoryID = ps.ProductSubcategoryID
                JOIN Production.ProductCategory pc
                    ON ps.ProductCategoryID = pc.ProductCategoryID
                WHERE pc.Name = 'Bikes'
                  AND p.Size IS NOT NULL
                  AND p.Size != ''
                ORDER BY p.Size";

            using var conn = new SqlConnection(_sqlConnectionString);
            await conn.OpenAsync();

            var colors    = (await conn.QueryAsync<string>(colorSql)).ToList();
            var bikeSizes = (await conn.QueryAsync<string>(sizeSql)).ToList();

            _catalogMeta = new CatalogMeta { Colors = colors, BikeSizes = bikeSizes };
            _logger.LogInformation("Catalog meta loaded — {C} colours, {S} bike sizes", colors.Count, bikeSizes.Count);
            return _catalogMeta;
        }
        finally
        {
            _metaLock.Release();
        }
    }

    // -----------------------------------------------------------------------
    // Agent initialisation
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// <summary>
    /// Generate a set of personalised discovery questions.
    /// The questions are AI-generated based on the AdventureWorks catalog context
    /// (bikes, components, clothing &amp; accessories).
    /// </summary>
    public async Task<WizardQuestionsResponse> GetQuestionsAsync(string? context, string? cultureId)
    {
        using var op = _telemetryClient.StartOperation<RequestTelemetry>("HelpMeChoose.GetQuestions");

        try
        {
            // Use a lightweight, stateless OpenAI call — no MCP needed for question generation.
            var credential = new DefaultAzureCredential();
            var chatClient = new AzureOpenAIClient(new Uri(_endpoint), credential)
                .GetChatClient(_modelDeployment);

            var contextHint = string.IsNullOrWhiteSpace(context) ? "any of the products listed below" : context;
            var languageHint = string.IsNullOrWhiteSpace(cultureId) ? "English" : cultureId;
            var catalogDescription = await GetCatalogDescriptionAsync();

            var prompt = $@"You are a friendly product advisor for AdventureWorks, an outdoor sports and cycling e-commerce store that sells the following product categories and subcategories:
{catalogDescription}
Generate exactly 5 short, engaging discovery questions to help a shopper find the perfect product.
The shopper expressed interest in: {contextHint}.
Answer in {languageHint} language.

Rules:
- Each question must have exactly 4 selectable options (short labels, max 30 chars each).
- Cover: riding style / use-case, experience level, budget, frequency of use, priority (performance vs comfort vs lightweight).
- Keep questions concise — one sentence each.
- Do NOT number the questions.

Return ONLY a valid JSON array (no markdown, no extra text):
[
  {{
    ""id"": 1,
    ""text"": ""<question text>"",
    ""icon"": ""<single relevant emoji>"",
    ""options"": [""<option1>"", ""<option2>"", ""<option3>"", ""<option4>""]
  }},
  ...
]";

            var sb = new System.Text.StringBuilder();
            await foreach (var partial in chatClient.CompleteChatStreamingAsync(
                [new OpenAI.Chat.UserChatMessage(prompt)]))
            {
                foreach (var textPart in partial.ContentUpdate)
                    if (!string.IsNullOrEmpty(textPart.Text)) sb.Append(textPart.Text);
            }

            var raw = sb.ToString().Trim();

            // Strip possible markdown code fence
            if (raw.StartsWith("```")) raw = System.Text.RegularExpressions.Regex.Replace(raw, @"^```[^\n]*\n?|```$", "", System.Text.RegularExpressions.RegexOptions.Multiline).Trim();

            var questions = JsonSerializer.Deserialize<List<WizardQuestion>>(raw, _jsonOptions)
                            ?? BuildFallbackQuestions();

            // Emit full prompt + response to App Insights for debugging
            _telemetryClient.TrackTrace(
                $"[HelpMeChoose] Question generation prompt:\n{prompt}",
                SeverityLevel.Verbose,
                new Dictionary<string, string> { ["Phase"] = "QuestionPrompt", ["CultureId"] = cultureId ?? "default" });

            _telemetryClient.TrackTrace(
                $"[HelpMeChoose] Question generation raw response:\n{raw}",
                SeverityLevel.Verbose,
                new Dictionary<string, string> { ["Phase"] = "QuestionRawResponse", ["CultureId"] = cultureId ?? "default" });

            op.Telemetry.Success = true;
            _telemetryClient.TrackEvent("HelpMeChoose.QuestionsGenerated",
                new Dictionary<string, string> { ["Count"] = questions.Count.ToString(), ["CultureId"] = cultureId ?? "default" });

            return new WizardQuestionsResponse
            {
                SessionId = Guid.NewGuid().ToString(),
                Questions = questions
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating wizard questions");
            op.Telemetry.Success = false;
            _telemetryClient.TrackException(ex);

            // Graceful fallback — return static questions so the UX never breaks
            return new WizardQuestionsResponse
            {
                SessionId = Guid.NewGuid().ToString(),
                Questions = BuildFallbackQuestions()
            };
        }
    }

    /// <summary>
    /// Take user answers and return product recommendations by reasoning over the live catalog
    /// via MCP SearchProducts and FindComplementaryProducts tools.
    /// </summary>
    public async Task<RecommendationsResponse> GetRecommendationsAsync(
        List<WizardAnswer> answers,
        string? cultureId,
        string? firstName = null,
        string? gender = null,
        string? heightLabel = null,
        List<string>? preferredColors = null)
    {
        using var op = _telemetryClient.StartOperation<RequestTelemetry>("HelpMeChoose.GetRecommendations");
        var startTime = DateTimeOffset.UtcNow;

        try
        {
            // Build a structured summary of the user's answers for the agent
            var answerSummary = string.Join("\n", answers.Select(a => $"- {a.Question}: {a.Answer}"));

            // Build customer profile section
            var profileParts = new List<string>();
            if (!string.IsNullOrWhiteSpace(firstName))
                profileParts.Add($"Name: {firstName}");

            if (!string.IsNullOrWhiteSpace(gender) && !gender.Equals("prefer not to say", StringComparison.OrdinalIgnoreCase))
                profileParts.Add($"Gender: {gender}");

            if (!string.IsNullOrWhiteSpace(heightLabel))
                profileParts.Add($"Height / size range: {heightLabel}");

            if (preferredColors?.Count > 0)
                profileParts.Add($"Preferred colours: {string.Join(", ", preferredColors)} — filter towards these where available");

            var profileSection = profileParts.Count > 0
                ? $"\nCustomer profile:\n{string.Join("\n", profileParts.Select(l => $"- {l}"))}\n"
                : "";

            // Emit the full input profile to App Insights before calling the AI
            _telemetryClient.TrackEvent("HelpMeChoose.RecommendationInputProfile", new Dictionary<string, string>
            {
                ["HasFirstName"]      = (!string.IsNullOrWhiteSpace(firstName)).ToString(),
                ["Gender"]            = gender ?? "(none)",
                ["HeightLabel"]       = heightLabel ?? "(none)",
                ["PreferredColors"]   = preferredColors?.Count > 0 ? string.Join(", ", preferredColors) : "(none)",
                ["AnswerCount"]       = answers.Count.ToString(),
                ["CultureId"]         = cultureId ?? "default"
            });

            _telemetryClient.TrackTrace(
                $"[HelpMeChoose] Answer summary:\n{string.Join("\n", answers.Select(a => $"  Q{a.QuestionId}: {a.Question} → {a.Answer}"))}",
                SeverityLevel.Information,
                new Dictionary<string, string> { ["Phase"] = "AnswerSummary", ["CultureId"] = cultureId ?? "default" });

            var userMessage = $@"A customer has just completed the ""Help me Choose"" wizard. Based on their answers, find the best matching products in the AdventureWorks catalog and return personalised recommendations.
{profileSection}
Customer preferences (from wizard):
{answerSummary}

Instructions:
1. Identify the most relevant search terms from the customer's answers.
2. Call SearchProducts for each relevant search term (2-3 searches max) to find matching products.
3. If you find a strong primary match, also call FindComplementaryProducts to enrich suggestions.
4. Select the 3-5 best matching products overall.
5. For each recommended product provide a personalised one-sentence explanation of WHY it suits this specific customer.
6. If height/size information is provided, prioritise products available in a compatible frame size.
7. If colour preferences are specified, strongly prefer products in those colours.
8. If the customer's name is known, refer to them by first name in the summary.
9. Use the customer's stated gender to subtly personalise clothing and accessories suggestions. Never infer or guess gender from a name.
10. Write the summary in third person — e.g. ""Based on Fred's preferences..."" or ""For someone who..."" — never use ""I"" or ""I've found"".

Return ONLY a valid JSON object (no markdown, no extra text):
{{
  ""summary"": ""<2-3 sentence personalised summary>"",
  ""recommendations"": [
    {{
      ""productId"": <number>,
      ""productName"": ""<name>"",
      ""category"": ""<category>"",
      ""price"": <number or null>,
      ""reason"": ""<one sentence personalised explanation>"",
      ""thumbnailUrl"": null
    }}
  ],
  ""searchTermsUsed"": [""<term1>"", ""<term2>""]
}}

Culture/language for responses: {cultureId ?? "en-US"}";

            // Emit full user message to App Insights before calling the agent
            _telemetryClient.TrackTrace(
                $"[HelpMeChoose] Recommendation user message sent to AI:\n{userMessage}",
                SeverityLevel.Verbose,
                new Dictionary<string, string> { ["Phase"] = "RecommendationInput", ["CultureId"] = cultureId ?? "default" });

            // Invoke the Foundry "kind: prompt" agent via the Responses API.
            // The agent calls SearchProducts / FindComplementaryProducts MCP tools
            // server-side; we just wait for the final response.
            var agentResponse = await _foundryClient.InvokeAsync(_agentId, userMessage);
            string raw = agentResponse.ResponseText;

            _telemetryClient.TrackEvent("HelpMeChoose.AgentToolsUsed", new Dictionary<string, string>
            {
                ["ToolsUsed"] = string.Join(",", agentResponse.ToolsUsed),
                ["ResponseId"] = agentResponse.ResponseId ?? "unknown"
            });

            // Emit full raw AI response to App Insights
            _telemetryClient.TrackTrace(
                $"[HelpMeChoose] Recommendation raw AI response:\n{raw}",
                SeverityLevel.Verbose,
                new Dictionary<string, string> { ["Phase"] = "RecommendationRawOutput", ["CultureId"] = cultureId ?? "default" });

            if (raw.StartsWith("```")) raw = System.Text.RegularExpressions.Regex.Replace(raw, @"^```[^\n]*\n?|```$", "", System.Text.RegularExpressions.RegexOptions.Multiline).Trim();

            var result = JsonSerializer.Deserialize<RecommendationsResponse>(raw, _jsonOptions);

            if (result == null || result.Recommendations.Count == 0)
            {
                _logger.LogWarning("Agent returned empty or unparseable recommendations. Raw: {Raw}", raw.Length > 500 ? raw[..500] : raw);
                result = BuildFallbackRecommendations();
            }

            var duration = DateTimeOffset.UtcNow - startTime;
            op.Telemetry.Success = true;

            // Emit a full session summary — useful for correlating the whole flow in App Insights
            _telemetryClient.TrackEvent("HelpMeChoose.SessionComplete", new Dictionary<string, string>
            {
                ["RecommendationCount"] = result.Recommendations.Count.ToString(),
                ["SearchTermsUsed"]     = string.Join(", ", result.SearchTermsUsed),
                ["DurationMs"]          = duration.TotalMilliseconds.ToString("F0"),
                ["CultureId"]           = cultureId ?? "default",
                ["HasProfile"]          = (profileParts.Count > 0).ToString(),
                ["ProductIds"]          = string.Join(", ", result.Recommendations.Select(r => r.ProductId))
            });

            _telemetryClient.TrackEvent("HelpMeChoose.RecommendationsGenerated", new Dictionary<string, string>
            {
                ["Count"]     = result.Recommendations.Count.ToString(),
                ["DurationMs"] = duration.TotalMilliseconds.ToString("F0"),
                ["CultureId"] = cultureId ?? "default"
            });

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating recommendations");
            op.Telemetry.Success = false;
            _telemetryClient.TrackException(ex);
            return BuildFallbackRecommendations();
        }
    }

    // -----------------------------------------------------------------------
    // Fallbacks
    // -----------------------------------------------------------------------

    private static List<WizardQuestion> BuildFallbackQuestions() => new()
    {
        new() { Id = 1, Text = "What type of riding do you plan to do?", Icon = "🚴", Options = new() { "Mountain", "Road", "Commuting", "Casual / Recreation" } },
        new() { Id = 2, Text = "How would you describe your experience level?", Icon = "🏅", Options = new() { "Beginner", "Intermediate", "Advanced", "Professional" } },
        new() { Id = 3, Text = "What is your budget?", Icon = "💰", Options = new() { "Under $500", "$500 – $1,500", "$1,500 – $3,000", "$3,000+" } },
        new() { Id = 4, Text = "How often will you ride?", Icon = "📅", Options = new() { "Daily", "A few times a week", "Weekends only", "Occasionally" } },
        new() { Id = 5, Text = "What matters most to you?", Icon = "⭐", Options = new() { "Performance", "Comfort", "Lightweight", "Durability" } },
    };

    private static RecommendationsResponse BuildFallbackRecommendations() => new()
    {
        Summary = "Based on your preferences, here are some top picks from our catalog. Our team is always happy to help you find the perfect gear — reach out via chat anytime!",
        Recommendations = new(),
        SearchTermsUsed = new()
    };

    // The system prompt and tool configuration are managed in Azure AI Foundry on the agent definition.
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

public class WizardQuestion
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;

    [JsonPropertyName("icon")]
    public string Icon { get; set; } = "❓";

    [JsonPropertyName("options")]
    public List<string> Options { get; set; } = new();
}

public class WizardQuestionsResponse
{
    [JsonPropertyName("sessionId")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("questions")]
    public List<WizardQuestion> Questions { get; set; } = new();
}

public class WizardAnswer
{
    [JsonPropertyName("questionId")]
    public int QuestionId { get; set; }

    [JsonPropertyName("question")]
    public string Question { get; set; } = string.Empty;

    [JsonPropertyName("answer")]
    public string Answer { get; set; } = string.Empty;
}

public class ProductRecommendation
{
    [JsonPropertyName("productId")]
    public int ProductId { get; set; }

    [JsonPropertyName("productName")]
    public string ProductName { get; set; } = string.Empty;

    [JsonPropertyName("category")]
    public string Category { get; set; } = string.Empty;

    [JsonPropertyName("price")]
    public decimal? Price { get; set; }

    [JsonPropertyName("reason")]
    public string Reason { get; set; } = string.Empty;

    [JsonPropertyName("thumbnailUrl")]
    public string? ThumbnailUrl { get; set; }
}

public class RecommendationsResponse
{
    [JsonPropertyName("summary")]
    public string Summary { get; set; } = string.Empty;

    [JsonPropertyName("recommendations")]
    public List<ProductRecommendation> Recommendations { get; set; } = new();

    [JsonPropertyName("searchTermsUsed")]
    public List<string> SearchTermsUsed { get; set; } = new();
}

public class HelpMeQuestionsRequest
{
    [JsonPropertyName("context")]
    public string? Context { get; set; }

    [JsonPropertyName("cultureId")]
    public string? CultureId { get; set; }
}

public class HelpMeRecommendRequest
{
    [JsonPropertyName("sessionId")]
    public string? SessionId { get; set; }

    [JsonPropertyName("answers")]
    public List<WizardAnswer> Answers { get; set; } = new();

    [JsonPropertyName("cultureId")]
    public string? CultureId { get; set; }

    [JsonPropertyName("firstName")]
    public string? FirstName { get; set; }

    [JsonPropertyName("gender")]
    public string? Gender { get; set; }

    [JsonPropertyName("heightLabel")]
    public string? HeightLabel { get; set; }

    [JsonPropertyName("preferredColors")]
    public List<string>? PreferredColors { get; set; }
}

public class CatalogMeta
{
    [JsonPropertyName("colors")]
    public List<string> Colors { get; set; } = new();

    [JsonPropertyName("bikeSizes")]
    public List<string> BikeSizes { get; set; } = new();
}
