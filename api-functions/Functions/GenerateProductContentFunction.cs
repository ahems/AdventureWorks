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
/// Generates a creative product name and description using AI based on
/// product category, subcategory, and optional attributes.
/// </summary>
public class GenerateProductContentFunction
{
    private readonly ILogger<GenerateProductContentFunction> _logger;
    private readonly AIService _aiService;
    private readonly TelemetryClient _telemetryClient;

    public GenerateProductContentFunction(
        ILogger<GenerateProductContentFunction> logger,
        AIService aiService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _aiService = aiService;
        _telemetryClient = telemetryClient;
    }

    /// <summary>
    /// POST /api/products/generate-content
    /// Body: { "category": string, "subcategory": string, "productLine"?: string, "class"?: string, "style"?: string }
    /// Returns: { "productName": string, "productDescription": string }
    /// </summary>
    [Function("GenerateProductContent")]
    public async Task<HttpResponseData> GenerateProductContent(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "products/generate-content")]
        HttpRequestData req)
    {
        _logger.LogInformation("GenerateProductContent called");

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var request = JsonSerializer.Deserialize<GenerateProductContentRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (request == null ||
                string.IsNullOrWhiteSpace(request.Category) ||
                string.IsNullOrWhiteSpace(request.Subcategory))
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "category and subcategory are required" });
                return bad;
            }

            _telemetryClient.TrackEvent("GenerateProductContent.Started", new Dictionary<string, string>
            {
                ["Category"] = request.Category,
                ["Subcategory"] = request.Subcategory
            });

            var result = await _aiService.GenerateProductContentAsync(request);

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(result);
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error in GenerateProductContent");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An unexpected error occurred" });
            return error;
        }
    }
}
