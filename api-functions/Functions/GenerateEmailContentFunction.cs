using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using System.Net;
using System.Text.Json;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Generates personalised AI email content (subject + body) for bulk marketing campaigns.
/// </summary>
public class GenerateEmailContentFunction
{
    private readonly ILogger<GenerateEmailContentFunction> _logger;
    private readonly AIService _aiService;
    private readonly TelemetryClient _telemetryClient;

    public GenerateEmailContentFunction(
        ILogger<GenerateEmailContentFunction> logger,
        AIService aiService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _aiService = aiService;
        _telemetryClient = telemetryClient;
    }

    /// <summary>
    /// POST /api/email/generate-ai-content
    /// Body: { "firstName": string, "templateType": string, "productNames"?: string[],
    ///         "cartValue"?: number, "lastOrderId"?: int, "totalSpent"?: number, "totalOrders"?: int }
    /// Returns: { "subject": string, "body": string } or { "subject": null, "body": null, "error": string }
    /// on model failure so callers can fall back gracefully.
    /// </summary>
    [Function("GenerateEmailContent")]
    public async Task<HttpResponseData> GenerateEmailContent(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "email/generate-ai-content")]
        HttpRequestData req)
    {
        _logger.LogInformation("GenerateEmailContent called");

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var request = JsonSerializer.Deserialize<EmailContentRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (request == null || string.IsNullOrWhiteSpace(request.FirstName))
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "firstName is required" });
                return bad;
            }

            if (string.IsNullOrWhiteSpace(request.TemplateType))
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "templateType is required" });
                return bad;
            }

            _telemetryClient.TrackEvent("EmailContentGeneration.Started", new Dictionary<string, string>
            {
                ["TemplateType"] = request.TemplateType
            });

            // GenerateEmailContentAsync never throws — returns error field on failure
            var content = await _aiService.GenerateEmailContentAsync(request);

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(content);
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error in GenerateEmailContent");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An unexpected error occurred" });
            return error;
        }
    }
}
