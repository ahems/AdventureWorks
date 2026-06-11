using System.Net;
using System.Text.Json;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// HTTP-triggered endpoint to refresh exchange rates from the Frankfurter API
/// (European Central Bank daily data) into Sales.CurrencyRate.
/// Route: POST /api/exchange-rates/refresh
/// </summary>
public class UpdateExchangeRatesFunction
{
    private readonly ExchangeRateService _exchangeRateService;
    private readonly ILogger<UpdateExchangeRatesFunction> _logger;

    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented        = true,
    };

    public UpdateExchangeRatesFunction(
        ExchangeRateService exchangeRateService,
        ILogger<UpdateExchangeRatesFunction> logger)
    {
        _exchangeRateService = exchangeRateService;
        _logger              = logger;
    }

    [Function("RefreshExchangeRates")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "exchange-rates/refresh")]
        HttpRequestData req)
    {
        _logger.LogInformation("Exchange rate refresh requested");

        try
        {
            var result = await _exchangeRateService.RefreshExchangeRatesAsync();
            var resp   = req.CreateResponse(HttpStatusCode.OK);
            resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
            await resp.WriteStringAsync(JsonSerializer.Serialize(result, _json));
            return resp;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exchange rate refresh failed");
            var resp = req.CreateResponse(HttpStatusCode.InternalServerError);
            resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
            await resp.WriteStringAsync(
                JsonSerializer.Serialize(new { error = ex.Message }, _json));
            return resp;
        }
    }
}
