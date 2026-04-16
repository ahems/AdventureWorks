using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using System.Net;
using System.Text.Json;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP functions that back the "Help me Choose" AI wizard in the frontend.
///
/// POST /api/helpme/questions  → returns AI-generated discovery questions
/// POST /api/helpme/recommend  → takes answers, uses MCP to browse catalog, returns recommendations
/// </summary>
public class HelpMeChooseFunctions
{
    private readonly ILogger<HelpMeChooseFunctions> _logger;
    private readonly HelpMeChooseService _helpMeChooseService;
    private readonly TelemetryClient _telemetryClient;

    public HelpMeChooseFunctions(
        ILogger<HelpMeChooseFunctions> logger,
        HelpMeChooseService helpMeChooseService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _helpMeChooseService = helpMeChooseService;
        _telemetryClient = telemetryClient;
    }

    /// <summary>
    /// Generate personalised discovery questions for the wizard.
    /// POST /api/helpme/questions
    /// Body: { "context": "looking for a mountain bike", "cultureId": "en-US" }
    /// </summary>
    [Function("HelpMeChooseQuestions")]
    public async Task<HttpResponseData> GetQuestions(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "helpme/questions")] HttpRequestData req)
    {
        _logger.LogInformation("HelpMeChoose: questions request received");

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var request = string.IsNullOrWhiteSpace(body)
                ? new HelpMeQuestionsRequest()
                : JsonSerializer.Deserialize<HelpMeQuestionsRequest>(body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                  ?? new HelpMeQuestionsRequest();

            _telemetryClient.TrackEvent("HelpMeChoose.QuestionsRequested", new Dictionary<string, string>
            {
                ["CultureId"] = request.CultureId ?? "default",
                ["HasContext"] = (!string.IsNullOrWhiteSpace(request.Context)).ToString()
            });

            var result = await _helpMeChooseService.GetQuestionsAsync(request.Context, request.CultureId);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(result);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating wizard questions");
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { ["Endpoint"] = "HelpMeChooseQuestions" });

            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "Failed to generate questions", message = ex.Message });
            return error;
        }
    }

    /// <summary>
    /// Generate product recommendations based on wizard answers.
    /// POST /api/helpme/recommend
    /// Body: { "sessionId": "...", "answers": [...], "cultureId": "en-US" }
    /// </summary>
    [Function("HelpMeChooseRecommend")]
    public async Task<HttpResponseData> GetRecommendations(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "helpme/recommend")] HttpRequestData req)
    {
        _logger.LogInformation("HelpMeChoose: recommendation request received");

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var request = JsonSerializer.Deserialize<HelpMeRecommendRequest>(body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (request == null || request.Answers.Count == 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteStringAsync("answers are required");
                return bad;
            }

            _telemetryClient.TrackEvent("HelpMeChoose.RecommendRequested", new Dictionary<string, string>
            {
                ["AnswerCount"] = request.Answers.Count.ToString(),
                ["CultureId"] = request.CultureId ?? "default",
                ["SessionId"] = request.SessionId ?? "none"
            });

            var result = await _helpMeChooseService.GetRecommendationsAsync(
                request.Answers,
                request.CultureId,
                request.FirstName,
                request.Gender,
                request.HeightLabel,
                request.PreferredColors,
                request.CustomerId);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(result);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating recommendations");
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { ["Endpoint"] = "HelpMeChooseRecommend" });

            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "Failed to generate recommendations", message = ex.Message });
            return error;
        }
    }

    /// <summary>
    /// Returns the live list of distinct product colours and bike frame sizes.
    /// GET /api/helpme/catalog-meta
    /// </summary>
    [Function("HelpMeChooseCatalogMeta")]
    public async Task<HttpResponseData> GetCatalogMeta(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "helpme/catalog-meta")] HttpRequestData req)
    {
        try
        {
            var meta = await _helpMeChooseService.GetCatalogMetaAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(meta);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching catalog meta");
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { ["Endpoint"] = "HelpMeChooseCatalogMeta" });
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "Failed to fetch catalog meta", message = ex.Message });
            return error;
        }
    }
}
