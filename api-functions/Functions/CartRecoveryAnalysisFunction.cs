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
/// Analyses abandoned shopping carts using AI and returns a per-cart recovery
/// strategy (score, urgency, email copy, recommended discount).
/// </summary>
public class CartRecoveryAnalysisFunction
{
    private readonly ILogger<CartRecoveryAnalysisFunction> _logger;
    private readonly AIService _aiService;
    private readonly TelemetryClient _telemetryClient;

    public CartRecoveryAnalysisFunction(
        ILogger<CartRecoveryAnalysisFunction> logger,
        AIService aiService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _aiService = aiService;
        _telemetryClient = telemetryClient;
    }

    /// <summary>
    /// POST /api/carts/analyze-recovery
    /// Body: { "carts": [{ "cartId": string, "customerName": string, "totalValue": number,
    ///          "daysStale": int, "totalItems": int, "productNames"?: string[] }] }
    /// Returns: { "strategies": [{ "cartId", "recoveryScore", "urgency", "emailSubject",
    ///            "emailBody", "recommendedDiscount", "strategy", "error?" }] }
    /// </summary>
    [Function("AnalyzeCartRecovery")]
    public async Task<HttpResponseData> AnalyzeCartRecovery(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "carts/analyze-recovery")]
        HttpRequestData req)
    {
        _logger.LogInformation("AnalyzeCartRecovery called");

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var request = JsonSerializer.Deserialize<AnalyzeCartRecoveryRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (request?.Carts == null || request.Carts.Count == 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "carts array is required and must not be empty" });
                return bad;
            }

            _telemetryClient.TrackEvent("CartRecoveryAnalysis.Started", new Dictionary<string, string>
            {
                ["CartCount"] = request.Carts.Count.ToString()
            });

            var strategies = await _aiService.AnalyzeCartRecoveryAsync(request.Carts);

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new { strategies });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error in AnalyzeCartRecovery");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An unexpected error occurred" });
            return error;
        }
    }
}

internal class AnalyzeCartRecoveryRequest
{
    public List<CartRecoveryInput> Carts { get; set; } = new();
}
