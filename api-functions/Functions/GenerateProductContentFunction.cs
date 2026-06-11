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
/// Generates a creative product name, description, pricing, and variation hints using the
/// Azure AI Foundry product-content agent.
/// </summary>
public class GenerateProductContentFunction
{
    private readonly ILogger<GenerateProductContentFunction> _logger;
    private readonly ProductContentAgentService _productContentService;
    private readonly TelemetryClient _telemetryClient;

    public GenerateProductContentFunction(
        ILogger<GenerateProductContentFunction> logger,
        ProductContentAgentService productContentService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _productContentService = productContentService;
        _telemetryClient = telemetryClient;
    }

    /// <summary>
    /// POST /api/products/generate-content
    /// Body: { "category": string, "subcategory": string, "productLine"?: string,
    ///         "class"?: string, "style"?: string, "availableSizes"?: string[],
    ///         "availableColors"?: string[], "availableStyles"?: string[],
    ///         "previousResponseId"?: string }
    /// Returns: { "productName", "productDescription", "estimatedWeightLb",
    ///            "suggestedStandardCost", "suggestedListPrice", "suggestedSizes",
    ///            "suggestedColors", "suggestedStyles", "threadId"? }
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
                ["Category"]             = request.Category,
                ["Subcategory"]          = request.Subcategory,
                ["HasPreviousResponse"]  = (!string.IsNullOrEmpty(request.PreviousResponseId)).ToString()
            });

            var (result, threadId) = await _productContentService.GenerateProductContentAsync(
                request, request.PreviousResponseId);

            // Attach the Foundry response ID so the wizard can chain subsequent products.
            result.ThreadId = threadId;

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
