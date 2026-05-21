using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using AddressFunctions.Services;
using System.Net;

namespace AddressFunctions.Functions;

public class CustomerStatsFunction
{
    private readonly ILogger<CustomerStatsFunction> _logger;
    private readonly CustomerStatsService _customerStatsService;

    public CustomerStatsFunction(ILogger<CustomerStatsFunction> logger, CustomerStatsService customerStatsService)
    {
        _logger = logger;
        _customerStatsService = customerStatsService;
    }

    /// <summary>
    /// Returns aggregate KPI summary: total customers, total/avg revenue, countries served,
    /// and spending bucket distribution — all computed across the full AdventureWorks dataset.
    /// </summary>
    [Function("GetCustomerStats")]
    public async Task<HttpResponseData> GetCustomerStats(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "customer-stats")] HttpRequestData req)
    {
        _logger.LogInformation("GetCustomerStats function processing request");
        try
        {
            var summary = await _customerStatsService.GetSummaryAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(summary);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting customer stats summary");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while retrieving customer stats" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Returns customer count and revenue grouped by country, ordered by customer count descending.
    /// </summary>
    [Function("GetCustomerCountryBreakdown")]
    public async Task<HttpResponseData> GetCustomerCountryBreakdown(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "customer-country-breakdown")] HttpRequestData req)
    {
        _logger.LogInformation("GetCustomerCountryBreakdown function processing request");
        try
        {
            var stats = await _customerStatsService.GetCountryBreakdownAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(stats);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting customer country breakdown");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while retrieving country breakdown" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Returns customer count and revenue grouped by sales territory group
    /// (North America / Europe / Pacific), ordered by revenue descending.
    /// </summary>
    [Function("GetCustomerRegionBreakdown")]
    public async Task<HttpResponseData> GetCustomerRegionBreakdown(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "customer-region-breakdown")] HttpRequestData req)
    {
        _logger.LogInformation("GetCustomerRegionBreakdown function processing request");
        try
        {
            var stats = await _customerStatsService.GetRegionBreakdownAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(stats);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting customer region breakdown");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while retrieving region breakdown" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Returns monthly revenue totals across all individual-customer orders, ordered chronologically.
    /// </summary>
    [Function("GetCustomerMonthlyRevenue")]
    public async Task<HttpResponseData> GetCustomerMonthlyRevenue(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "customer-monthly-revenue")] HttpRequestData req)
    {
        _logger.LogInformation("GetCustomerMonthlyRevenue function processing request");
        try
        {
            var monthlyData = await _customerStatsService.GetMonthlyRevenueAsync();
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(monthlyData);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting customer monthly revenue");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while retrieving monthly revenue" });
            return errorResponse;
        }
    }
}
