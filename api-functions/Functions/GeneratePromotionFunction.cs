using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using System.Net;
using System.Text.Json;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Generate a promotion suggestion using the AI promotion agent.
/// POST /api/GeneratePromotion
/// Body: { "promotionType": "Clearance", "offerCategory": "Customer", "categoryId": 1, "categoryName": "Bikes", "subcategoryId": 2, "subcategoryName": "Road Bikes" }
/// </summary>
public class GeneratePromotionFunction
{
    private readonly ILogger<GeneratePromotionFunction> _logger;
    private readonly PromotionAgentService _promotionAgentService;
    private readonly TelemetryClient _telemetryClient;

    public GeneratePromotionFunction(
        ILogger<GeneratePromotionFunction> logger,
        PromotionAgentService promotionAgentService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _promotionAgentService = promotionAgentService;
        _telemetryClient = telemetryClient;
    }

    [Function("GeneratePromotion")]
    public async Task<HttpResponseData> GeneratePromotion(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "GeneratePromotion")] HttpRequestData req)
    {
        _logger.LogInformation("GeneratePromotion request received");
        var requestStartTime = DateTimeOffset.UtcNow;

        try
        {
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var request = JsonSerializer.Deserialize<GeneratePromotionRequest>(requestBody,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (request == null || string.IsNullOrWhiteSpace(request.PromotionType))
            {
                var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequest.WriteStringAsync("promotionType is required");
                return badRequest;
            }

            _logger.LogInformation("Generating {Type} promotion for category {OfferCategory}",
                request.PromotionType, request.OfferCategory);

            _telemetryClient.TrackEvent("GeneratePromotion.Request", new Dictionary<string, string>
            {
                ["PromotionType"] = request.PromotionType,
                ["OfferCategory"] = request.OfferCategory ?? "Customer",
                ["CategoryId"] = request.CategoryId?.ToString() ?? "all"
            });

            var result = await _promotionAgentService.GeneratePromotionAsync(
                request.PromotionType,
                request.OfferCategory ?? "Customer",
                request.CategoryId,
                request.CategoryName,
                request.SubcategoryId,
                request.SubcategoryName,
                request.PreviousThreadId
            );

            var duration = DateTimeOffset.UtcNow - requestStartTime;
            _telemetryClient.TrackRequest("GeneratePromotion", requestStartTime, duration, "200", true);

            // Return the suggestion with the threadId so the UI can support refinement turns
            var responsePayload = new
            {
                suggestion = result.Suggestion,
                threadId   = result.ThreadId
            };

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(responsePayload);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating promotion");
            var duration = DateTimeOffset.UtcNow - requestStartTime;
            _telemetryClient.TrackRequest("GeneratePromotion", requestStartTime, duration, "500", false);
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Endpoint"] = "GeneratePromotion"
            });
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "Failed to generate promotion", message = ex.Message });
            return errorResponse;
        }
    }
}

public class GeneratePromotionRequest
{
    public string PromotionType { get; set; } = string.Empty;
    public string? OfferCategory { get; set; }
    public int? CategoryId { get; set; }
    public string? CategoryName { get; set; }
    public int? SubcategoryId { get; set; }
    public string? SubcategoryName { get; set; }
    /// <summary>
    /// Foundry response ID from a previous generate/refine call. Pass this back to continue
    /// the stored conversation (multi-turn refinement, e.g. 'adjust discount to 20%').
    /// </summary>
    public string? PreviousThreadId { get; set; }
}
