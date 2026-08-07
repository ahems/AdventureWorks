using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP control endpoints for the Auto-Promotion feature.
/// GET  /api/auto-promotion/config         — returns current config + counters
/// PUT  /api/auto-promotion/config         — updates config
/// POST /api/auto-promotion/reset-counters — resets order counters to 0
/// </summary>
public class AutoPromotionControlFunction
{
    private readonly ILogger<AutoPromotionControlFunction> _logger;
    private readonly AutoPromotionConfigService _configService;

    public AutoPromotionControlFunction(
        ILogger<AutoPromotionControlFunction> logger,
        AutoPromotionConfigService configService)
    {
        _logger = logger;
        _configService = configService;
    }

    [Function("AutoPromotion_GetConfig")]
    public async Task<HttpResponseData> GetConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "auto-promotion/config")]
        HttpRequestData req)
    {
        var config = await _configService.GetConfigAsync();
        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(new
        {
            config.IsEnabled,
            config.TriggerOnConsumerOrders,
            config.TriggerOnStoreOrders,
            config.ConsumerOrderThreshold,
            config.StoreOrderThreshold,
            config.ConsumerOrderCounter,
            config.StoreOrderCounter,
            config.LastConsumerTriggerAt,
            config.LastStoreTriggerAt,
            config.TotalAutoPromotionsCreated,
        });
        return resp;
    }

    [Function("AutoPromotion_UpdateConfig")]
    public async Task<HttpResponseData> UpdateConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "auto-promotion/config")]
        HttpRequestData req)
    {
        AutoPromotionUpdateRequest? input = null;
        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            input = JsonSerializer.Deserialize<AutoPromotionUpdateRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch { /* fall through */ }

        if (input == null)
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteStringAsync("Invalid request body");
            return bad;
        }

        var config = await _configService.GetConfigAsync();
        config.IsEnabled = input.IsEnabled ?? config.IsEnabled;
        config.TriggerOnConsumerOrders = input.TriggerOnConsumerOrders ?? config.TriggerOnConsumerOrders;
        config.TriggerOnStoreOrders = input.TriggerOnStoreOrders ?? config.TriggerOnStoreOrders;

        if (input.ConsumerOrderThreshold.HasValue)
            config.ConsumerOrderThreshold = Math.Clamp(input.ConsumerOrderThreshold.Value, 10, 1000);
        if (input.StoreOrderThreshold.HasValue)
            config.StoreOrderThreshold = Math.Clamp(input.StoreOrderThreshold.Value, 10, 1000);

        await _configService.SaveConfigAsync(config);

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(new
        {
            config.IsEnabled,
            config.TriggerOnConsumerOrders,
            config.TriggerOnStoreOrders,
            config.ConsumerOrderThreshold,
            config.StoreOrderThreshold,
            config.ConsumerOrderCounter,
            config.StoreOrderCounter,
            config.LastConsumerTriggerAt,
            config.LastStoreTriggerAt,
            config.TotalAutoPromotionsCreated,
        });
        return resp;
    }

    [Function("AutoPromotion_ResetCounters")]
    public async Task<HttpResponseData> ResetCounters(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "auto-promotion/reset-counters")]
        HttpRequestData req)
    {
        var config = await _configService.GetConfigAsync();
        config.ConsumerOrderCounter = 0;
        config.StoreOrderCounter = 0;
        await _configService.SaveConfigAsync(config);

        _logger.LogInformation("[AutoPromotion] Counters reset to zero.");

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(new { message = "Counters reset to zero." });
        return resp;
    }
}

public class AutoPromotionUpdateRequest
{
    public bool? IsEnabled { get; set; }
    public bool? TriggerOnConsumerOrders { get; set; }
    public bool? TriggerOnStoreOrders { get; set; }
    public int? ConsumerOrderThreshold { get; set; }
    public int? StoreOrderThreshold { get; set; }
}
