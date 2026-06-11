using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using api_functions.Services;
using System.Net;

namespace api_functions.Functions;

/// <summary>
/// Returns top-spending customers who have placed at least one order, sorted descending by total spend.
/// GET /api/customers/top-spenders?limit=100
/// Returns: [ { customerId, firstName, lastName, email, totalSpend, orderCount }, ... ]
/// </summary>
public class GetTopSpendersFunction
{
    private readonly ILogger<GetTopSpendersFunction> _logger;
    private readonly OrderGenerationService _orderGenService;
    private readonly TelemetryClient _telemetryClient;

    public GetTopSpendersFunction(
        ILogger<GetTopSpendersFunction> logger,
        OrderGenerationService orderGenService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _orderGenService = orderGenService;
        _telemetryClient = telemetryClient;
    }

    [Function("GetTopSpenders")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "customers/top-spenders")] HttpRequestData req)
    {
        _logger.LogInformation("GetTopSpenders request received");

        try
        {
            var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var limitStr = query["limit"];
            var limit = int.TryParse(limitStr, out var l) ? Math.Clamp(l, 1, 500) : 100;

            var customers = await _orderGenService.GetTopSpendersAsync(limit);

            _telemetryClient.TrackEvent("GetTopSpenders.Success", new Dictionary<string, string>
            {
                ["Limit"] = limit.ToString(),
                ["ResultCount"] = customers.Count.ToString()
            });

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(customers);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GetTopSpenders");
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { ["Endpoint"] = "GetTopSpenders" });
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = ex.Message });
            return errorResponse;
        }
    }
}
