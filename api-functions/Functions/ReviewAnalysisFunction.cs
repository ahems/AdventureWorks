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
/// Analyses a batch of product reviews using AI to produce per-review sentiment
/// classification, content flags, and a suggested brand response.
/// </summary>
public class ReviewAnalysisFunction
{
    private readonly ILogger<ReviewAnalysisFunction> _logger;
    private readonly ReviewAnalysisAgentService _reviewAnalysisAgentService;
    private readonly TelemetryClient _telemetryClient;

    public ReviewAnalysisFunction(
        ILogger<ReviewAnalysisFunction> logger,
        ReviewAnalysisAgentService reviewAnalysisAgentService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _reviewAnalysisAgentService = reviewAnalysisAgentService;
        _telemetryClient = telemetryClient;
    }

    /// <summary>
    /// POST /api/reviews/analyze-batch
    /// Body: { "reviews": [{ "productReviewId": int, "rating": int, "comments": string,
    ///          "reviewerName": string, "productName": string }] }
    /// Returns: { "analyses": [{ "productReviewId", "sentiment", "flags", "suggestedResponse", "error?" }] }
    /// </summary>
    [Function("AnalyzeReviewsBatch")]
    public async Task<HttpResponseData> AnalyzeReviewsBatch(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "reviews/analyze-batch")]
        HttpRequestData req)
    {
        _logger.LogInformation("AnalyzeReviewsBatch called");

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var request = JsonSerializer.Deserialize<AnalyzeReviewsRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (request?.Reviews == null || request.Reviews.Count == 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "reviews array is required and must not be empty" });
                return bad;
            }

            if (request.Reviews.Count > 50)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "Maximum 50 reviews per request" });
                return bad;
            }

            _telemetryClient.TrackEvent("ReviewAnalysis.Started", new Dictionary<string, string>
            {
                ["ReviewCount"] = request.Reviews.Count.ToString()
            });

            var analyses = await _reviewAnalysisAgentService.AnalyzeReviewsAsync(request.Reviews);

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new { analyses });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error in AnalyzeReviewsBatch");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An unexpected error occurred" });
            return error;
        }
    }
}

internal class AnalyzeReviewsRequest
{
    public List<ReviewInput> Reviews { get; set; } = new();
}
