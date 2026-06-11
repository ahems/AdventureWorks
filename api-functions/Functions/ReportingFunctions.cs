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

    // ─── Channel helper ───────────────────────────────────────────────────
    // channel param: "eshop" = online orders, "b2b" = store orders, absent/other = all
    private static bool? ParseChannel(System.Collections.Specialized.NameValueCollection query)
    {
        var ch = query["channel"];
        return ch switch {
            "eshop" => true,
            "b2b" => false,
            _ => (bool?)null
        };
    }

    [Function("ReportRevenueByCategoryReport")]
    public async Task<HttpResponseData> GetRevenueByCategory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/revenue-by-category")] HttpRequestData req)
    {
        _logger.LogInformation("ReportRevenueByCategoryReport triggered");
        try
        {
            var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var data = await _reporting.GetRevenueByCategoryAsync(ParseChannel(query));
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
            var q = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var data = await _reporting.GetMonthlyRevenueTrendAsync(ParseChannel(q));
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

            var data = await _reporting.GetTopProductsByRevenueAsync(limit, ParseChannel(query));
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
            var q2 = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var data = await _reporting.GetOrdersByStatusAsync(ParseChannel(q2));
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
            var q3 = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var data = await _reporting.GetRevenueByTerritoryAsync(ParseChannel(q3));
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
            var q4 = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
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

    [Function("ReportProductProfitability")]
    public async Task<HttpResponseData> GetProductProfitability(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/product-profitability")] HttpRequestData req)
    {
        _logger.LogInformation("ReportProductProfitability triggered");
        try
        {
            var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var limit = int.TryParse(query["limit"], out var l) ? Math.Clamp(l, 1, 50) : 20;
            var sortAsc = string.Equals(query["sortAsc"], "true", StringComparison.OrdinalIgnoreCase);

            var data = await _reporting.GetProductProfitabilityAsync(limit, sortAsc, ParseChannel(query));
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportProductProfitability");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportProductProfitabilityDetail")]
    public async Task<HttpResponseData> GetProductProfitabilityDetail(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/product-profitability-detail")] HttpRequestData req)
    {
        _logger.LogInformation("ReportProductProfitabilityDetail triggered");
        try
        {
            var q5 = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var data = await _reporting.GetProductProfitabilityDetailAsync(ParseChannel(q5));
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportProductProfitabilityDetail");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportProfitabilityByCategory")]
    public async Task<HttpResponseData> GetProfitabilityByCategory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/profitability-by-category")] HttpRequestData req)
    {
        _logger.LogInformation("ReportProfitabilityByCategory triggered");
        try
        {
            var q6 = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var data = await _reporting.GetProfitabilityByCategoryAsync(ParseChannel(q6));
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportProfitabilityByCategory");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportDiscountImpact")]
    public async Task<HttpResponseData> GetDiscountImpact(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/discount-impact")] HttpRequestData req)
    {
        _logger.LogInformation("ReportDiscountImpact triggered");
        try
        {
            var q7 = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            var data = await _reporting.GetDiscountImpactAsync(ParseChannel(q7));
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportDiscountImpact");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportSlowMovers")]
    public async Task<HttpResponseData> GetSlowMovers(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/slow-movers")] HttpRequestData req)
    {
        _logger.LogInformation("ReportSlowMovers triggered");
        try
        {
            var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            int threshold = int.TryParse(query["threshold"], out var t) ? t : 10;
            var data = await _reporting.GetSlowMoversAsync(threshold, ParseChannel(query));
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportSlowMovers");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportSalesTrends")]
    public async Task<HttpResponseData> GetSalesTrends(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/sales-trends")] HttpRequestData req)
    {
        _logger.LogInformation("ReportSalesTrends triggered");
        try
        {
            var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            if (!int.TryParse(query["productId"], out var productId) || productId <= 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "productId is required" });
                return bad;
            }
            var data = await _reporting.GetSalesTrendsAsync(productId, ParseChannel(query));
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(data);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportSalesTrends");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }

    [Function("ReportProductPriceHistory")]
    public async Task<HttpResponseData> GetProductPriceHistory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reporting/product-price-history")] HttpRequestData req)
    {
        _logger.LogInformation("ReportProductPriceHistory triggered");
        try
        {
            var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
            if (!int.TryParse(query["productId"], out var productId) || productId <= 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "productId is required" });
                return bad;
            }
            var priceHistory = await _reporting.GetProductPriceHistoryAsync(productId);
            var costHistory = await _reporting.GetProductCostHistoryAsync(productId);
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new { priceHistory, costHistory });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ReportProductPriceHistory");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred" });
            return error;
        }
    }
}
