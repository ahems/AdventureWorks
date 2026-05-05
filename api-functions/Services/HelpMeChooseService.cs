using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Dapper;

namespace api_functions.Services;

/// <summary>
/// Service that powers the "Help Me Choose" wizard experience.
///
/// Both phases now run through the Azure AI Foundry Responses API:
///   Step 1 (GetQuestionsAsync):       Uses the Foundry agent to generate personalised
///                                      discovery questions. Returns a threadId (Foundry
///                                      response ID) that the client must pass back to
///                                      the recommendations step so both phases share a
///                                      stored conversation context.
///   Step 2 (GetRecommendationsAsync):  Accepts the threadId from step 1 and passes it
///                                      as previousResponseId so the agent sees the
///                                      questions context when producing recommendations.
///
/// Foundry features used:
///   - structured_inputs    → cultureId and profileContext resolved via Handlebars
///                            templates in the agent instructions
///   - x-memory-user-id     → scopes memory per customer for personalisation across visits
///   - previousResponseId   → chains both wizard phases in one stored conversation
///   - tool_choice: required → ensures agent always calls HelpMeChoose MCP tool;
///                             prevents hallucinated product lists
/// </summary>
public class HelpMeChooseService
{
    private readonly ILogger<HelpMeChooseService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;
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

        _sqlConnectionString = configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        // Use the plain help-me-choose agent (not the workflow orchestrator variant) because
        // HelpMeChooseService relies on structured_inputs which are only configured on
        // eshop-help-me-choose-agent. The workflow agent is a Foundry orchestrator without
        // tool/instruction setup and would return unstructured prose.
        var agentId = configuration["AI_AGENT_HELP_ME_CHOOSE_ID"];
        _agentId = agentId ?? throw new InvalidOperationException(
            "AI_AGENT_HELP_ME_CHOOSE_ID environment variable is not set");

        _logger.LogInformation("HelpMeChooseService configured — agent: {AgentId}", _agentId);
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
    // Public API
    // -----------------------------------------------------------------------

    /// <summary>
    /// Generate personalised discovery questions via the Foundry agent.
    /// Uses the same agent as the recommendations phase so both turns share a
    /// stored Foundry conversation. Returns a threadId (Foundry response ID) that
    /// the caller must pass back to <see cref="GetRecommendationsAsync"/> so the
    /// recommendations phase has full context from the questions turn.
    /// </summary>
    public async Task<WizardQuestionsResponse> GetQuestionsAsync(
        string? context,
        string? cultureId,
        int? customerId = null)
    {
        using var op = _telemetryClient.StartOperation<RequestTelemetry>("HelpMeChoose.GetQuestions");

        try
        {
            var catalogDescription = await GetCatalogDescriptionAsync();
            var contextHint = string.IsNullOrWhiteSpace(context) ? "any product in the catalog" : context;

            // Build structured inputs to resolve Handlebars templates in agent instructions.
            // profileContext passes the catalog structure so the agent can generate relevant
            // category-aware questions without needing a separate MCP tool call.
            var structuredInputs = new Dictionary<string, object>
            {
                ["cultureId"]       = cultureId ?? "en",
                ["profileContext"]  = $"Shopper interest: {contextHint}. Available categories:\n{catalogDescription}"
            };
            if (customerId.HasValue)
                structuredInputs["userId"] = customerId.Value.ToString();

            // The agent instructions handle question generation when the user message
            // indicates the questions phase. The agent uses profileContext (resolved from
            // structured_inputs) rather than the raw catalog, keeping the message clean.
            const string userMessage = "Generate exactly 5 personalised discovery questions for the wizard following the instructions.";

            // tool_choice: auto — question generation is stateless and does not need MCP tools;
            // the agent may optionally call tools but is not required to.
            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId,
                userMessage: userMessage,
                userId: customerId.HasValue ? customerId.Value.ToString() : null,
                structuredInputs: structuredInputs,
                toolChoice: "auto");

            var raw = agentResponse.ResponseText.Trim();

            // Strip possible markdown code fence
            if (raw.StartsWith("```"))
                raw = System.Text.RegularExpressions.Regex.Replace(raw, @"^```[^\n]*\n?|```$", "", System.Text.RegularExpressions.RegexOptions.Multiline).Trim();

            // Extract JSON array from response
            var start = raw.IndexOf('[');
            var end   = raw.LastIndexOf(']');
            if (start >= 0 && end > start)
                raw = raw.Substring(start, end - start + 1);

            var questions = JsonSerializer.Deserialize<List<WizardQuestion>>(raw, _jsonOptions)
                            ?? BuildFallbackQuestions();

            _telemetryClient.TrackTrace(
                $"[HelpMeChoose] Foundry questions response:\n{agentResponse.ResponseText}",
                SeverityLevel.Verbose,
                new Dictionary<string, string> { ["Phase"] = "QuestionRawResponse", ["CultureId"] = cultureId ?? "default" });

            op.Telemetry.Success = true;
            _telemetryClient.TrackEvent("HelpMeChoose.QuestionsGenerated", new Dictionary<string, string>
            {
                ["Count"]    = questions.Count.ToString(),
                ["CultureId"] = cultureId ?? "default",
                ["ThreadId"] = agentResponse.ResponseId ?? string.Empty
            });

            return new WizardQuestionsResponse
            {
                SessionId = agentResponse.ResponseId ?? Guid.NewGuid().ToString(),
                Questions  = questions,
                ThreadId   = agentResponse.ResponseId   // Pass back so recommendations phase can chain via previousResponseId
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating wizard questions via Foundry agent");
            op.Telemetry.Success = false;
            _telemetryClient.TrackException(ex);

            // Graceful fallback — return static questions so the UX never breaks
            return new WizardQuestionsResponse
            {
                SessionId = Guid.NewGuid().ToString(),
                Questions  = BuildFallbackQuestions()
            };
        }
    }

    /// <summary>
    /// Take user answers and return product recommendations by reasoning over the live catalog
    /// via MCP SearchProducts and FindComplementaryProducts tools.
    /// Pass <paramref name="previousThreadId"/> (from <see cref="GetQuestionsAsync"/>) to chain
    /// both wizard phases in one stored Foundry conversation — the agent will see the full
    /// questions context when generating recommendations.
    /// </summary>
    public async Task<RecommendationsResponse> GetRecommendationsAsync(
        List<WizardAnswer> answers,
        string? cultureId,
        string? firstName = null,
        string? gender = null,
        string? heightLabel = null,
        List<string>? preferredColors = null,
        int? customerId = null,
        string? previousThreadId = null)
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
            // Passing previousResponseId chains this turn with the questions phase so the
            // agent sees the full wizard context stored in Foundry memory.
            // tool_choice: "required" ensures product IDs in the response come from the live
            // catalog — hallucinated IDs would break add-to-cart downstream.
            var agentResponse = await _foundryClient.InvokeAsync(_agentId, userMessage,
                userId: customerId.HasValue ? customerId.Value.ToString() : null,
                previousResponseId: string.IsNullOrEmpty(previousThreadId) ? null : previousThreadId,
                toolChoice: "required");
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

            result.ThreadId = agentResponse.ResponseId;

            // Emit a full session summary — useful for correlating the whole flow in App Insights
            _telemetryClient.TrackEvent("HelpMeChoose.SessionComplete", new Dictionary<string, string>
            {
                ["RecommendationCount"] = result.Recommendations.Count.ToString(),
                ["SearchTermsUsed"]     = string.Join(", ", result.SearchTermsUsed),
                ["DurationMs"]          = duration.TotalMilliseconds.ToString("F0"),
                ["CultureId"]           = cultureId ?? "default",
                ["HasProfile"]          = (profileParts.Count > 0).ToString(),
                ["ProductIds"]          = string.Join(", ", result.Recommendations.Select(r => r.ProductId)),
                ["PreviousThreadId"]    = previousThreadId ?? "none"
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

    /// <summary>
    /// Foundry response ID from the questions turn. Pass back as previousThreadId in the
    /// recommendations request to chain both wizard phases in one stored conversation.
    /// </summary>
    [JsonPropertyName("threadId")]
    public string? ThreadId { get; set; }
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

    /// <summary>
    /// Foundry response ID from this recommendations turn. Can be passed back for further
    /// refinement turns (multi-turn wizard refinement).
    /// </summary>
    [JsonPropertyName("threadId")]
    public string? ThreadId { get; set; }
}

public class HelpMeQuestionsRequest
{
    [JsonPropertyName("context")]
    public string? Context { get; set; }

    [JsonPropertyName("cultureId")]
    public string? CultureId { get; set; }

    [JsonPropertyName("customerId")]
    public int? CustomerId { get; set; }
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

    [JsonPropertyName("customerId")]
    public int? CustomerId { get; set; }

    /// <summary>
    /// Foundry response ID returned by the questions endpoint. Pass this back to chain
    /// the recommendations turn with the questions turn in one stored Foundry conversation.
    /// </summary>
    [JsonPropertyName("previousThreadId")]
    public string? PreviousThreadId { get; set; }
}

public class CatalogMeta
{
    [JsonPropertyName("colors")]
    public List<string> Colors { get; set; } = new();

    [JsonPropertyName("bikeSizes")]
    public List<string> BikeSizes { get; set; } = new();
}
