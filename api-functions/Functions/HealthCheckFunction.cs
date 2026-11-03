using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System.Net;
using api_functions.Services;

namespace AdventureWorks.Functions;

public class HealthCheckFunction
{
    private readonly ILogger<HealthCheckFunction> _logger;
    private readonly DependencyHealthService _health;

    public HealthCheckFunction(ILogger<HealthCheckFunction> logger, DependencyHealthService health)
    {
        _logger = logger;
        _health = health;
    }

    [Function("HealthCheck")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "health")] HttpRequestData req)
    {
        _logger.LogInformation("Health check endpoint called");

        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync("{\"status\":\"healthy\",\"timestamp\":\"" + DateTime.UtcNow.ToString("o") + "\"}");

        return response;
    }

    [Function("DependencyReadiness")]
    public async Task<HttpResponseData> Readiness(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "health/readiness")] HttpRequestData req)
    {
        var report = await _health.GetReportAsync(req.FunctionContext.CancellationToken);
        var response = req.CreateResponse(report.Status == "healthy"
            ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable);
        response.Headers.Add("Cache-Control", "no-store");
        await response.WriteAsJsonAsync(report);
        return response;
    }
}
