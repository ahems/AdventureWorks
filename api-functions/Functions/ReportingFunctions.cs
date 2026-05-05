using System.Net;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP reporting endpoints that return pre-aggregated data from Azure SQL.
/// All queries run against the full dataset — no DAB pagination limits apply.
/// Routes: GET /api/reporting/{report-name}
/// </summary>
public class ReportingFunctions
{
    private readonly ILogger<ReportingFunctions> _logger;
    private readonly ReportingService _reporting;

    public ReportingFunctions(ILogger<ReportingFunctions> logger, ReportingService reporting)
    {
        _logger = logger;
        _reporting = reporting;
    }

    [Function("ReportRevenueByCategoryReport")]
    public async Task<HttpResponseData> GetRevenueByCategory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/revenue-by-category")] HttpRequestData req)
    {
        _logger.LogInformation("ReportRevenueByCategoryReport triggered");
        try
        {
            var data = await _reporting.GetRevenueByCategoryAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportRevenueByCategoryReport");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportMonthlyTrend")]
    public async Task<HttpResponseData> GetMonthlyTrend(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/monthly-trend")] HttpRequestData req)
    {
        _logger.LogInformation("ReportMonthlyTrend triggered");
        try
        {
            var data = await _reporting.GetMonthlyRevenueTrendAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportMonthlyTrend");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportTopProducts")]
    public async Task<HttpResponseData> GetTopProducts(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/top-products")] HttpRequestData req)
    {
        _logger.LogInformation("ReportTopProducts triggered");
        try
        {
            var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var limit = int.TryParse(query["limit"], out var l) ? Math.Clamp(l, 1, 50) : 10;

            var data = await _reporting.GetTopProductsByRevenueAsync(limit);
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportTopProducts");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportOrdersByStatus")]
    public async Task<HttpResponseData> GetOrdersByStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/orders-by-status")] HttpRequestData req)
    {
        _logger.LogInformation("ReportOrdersByStatus triggered");
        try
        {
            var data = await _reporting.GetOrdersByStatusAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportOrdersByStatus");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportRevenueByTerritory")]
    public async Task<HttpResponseData> GetRevenueByTerritory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/revenue-by-territory")] HttpRequestData req)
    {
        _logger.LogInformation("ReportRevenueByTerritory triggered");
        try
        {
            var data = await _reporting.GetRevenueByTerritoryAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportRevenueByTerritory");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportInventoryByCategory")]
    public async Task<HttpResponseData> GetInventoryByCategory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/inventory-by-category")] HttpRequestData req)
    {
        _logger.LogInformation("ReportInventoryByCategory triggered");
        try
        {
            var data = await _reporting.GetInventoryByCategoryAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportInventoryByCategory");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportDashboardCounts")]
    public async Task<HttpResponseData> GetDashboardCounts(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/dashboard-counts")] HttpRequestData req)
    {
        _logger.LogInformation("ReportDashboardCounts triggered");
        try
        {
            var data = await _reporting.GetDashboardCountsAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportDashboardCounts");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }
}
