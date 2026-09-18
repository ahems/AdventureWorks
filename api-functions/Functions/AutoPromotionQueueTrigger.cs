using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.ApplicationInsights;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Processes auto-promotion queue messages. When order volume thresholds are met,
/// generates a promotion via the AI agent, creates it in SQL, assigns products,
/// and expires any active promotions containing out-of-stock products.
/// </summary>
public class AutoPromotionQueueTrigger
{
    private const string QueueName = "auto-promotion-queue";

    private readonly ILogger<AutoPromotionQueueTrigger> _logger;
    private readonly PromotionAgentService _promotionAgent;
    private readonly SpecialOfferService _specialOfferService;
    private readonly AutoPromotionConfigService _configService;
    private readonly WebPubSubService _webPubSub;
    private readonly TelemetryClient _telemetry;

    public AutoPromotionQueueTrigger(
        ILogger<AutoPromotionQueueTrigger> logger,
        PromotionAgentService promotionAgent,
        SpecialOfferService specialOfferService,
        AutoPromotionConfigService configService,
        WebPubSubService webPubSub,
        TelemetryClient telemetry)
    {
        _logger = logger;
        _promotionAgent = promotionAgent;
        _specialOfferService = specialOfferService;
        _configService = configService;
        _webPubSub = webPubSub;
        _telemetry = telemetry;
    }

    [Function(nameof(AutoPromotion_QueueTrigger))]
    public async Task AutoPromotion_QueueTrigger(
        [QueueTrigger(QueueName, Connection = "AzureWebJobsStorage")] string queueMessage)
    {
        _logger.LogInformation("[AutoPromotion] Processing queue message.");

        AutoPromotionMessage? msg;
        try
        {
            msg = JsonSerializer.Deserialize<AutoPromotionMessage>(queueMessage,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[AutoPromotion] Failed to deserialise message — dropping.");
            return;
        }

        if (msg == null || string.IsNullOrEmpty(msg.OrderType))
        {
            _logger.LogWarning("[AutoPromotion] Null or invalid message — dropping.");
            return;
        }

        try
        {
            // Determine promotion parameters based on order type
            string promotionType;
            string offerCategory;

            if (msg.OrderType == "store")
            {
                promotionType = "Volume Discount";
                offerCategory = "Reseller";
            }
            else
            {
                promotionType = await _configService.GetAndToggleConsumerPromotionTypeAsync();
                offerCategory = "Customer";
            }

            _logger.LogInformation(
                "[AutoPromotion] Generating {Type} promotion for {Category} (triggered by {OrderType} orders).",
                promotionType, offerCategory, msg.OrderType);

            // Call the AI agent with no category filter (all products)
            var result = await _promotionAgent.GeneratePromotionAsync(
                promotionType, offerCategory);

            var suggestion = result.Suggestion;

            // Create the promotion in SQL
            var newId = await _specialOfferService.GetNextSpecialOfferIdAsync();
            var startDate = DateTime.TryParse(suggestion.StartDate, out var sd) ? sd : DateTime.UtcNow;
            var endDate = DateTime.TryParse(suggestion.EndDate, out var ed) ? ed : DateTime.UtcNow.AddDays(7);

            await _specialOfferService.UpsertSpecialOfferAsync(
                newId, "en",
                suggestion.Description,
                (double)suggestion.DiscountPct / 100.0,
                suggestion.Type,
                suggestion.Category,
                startDate, endDate,
                suggestion.MinQty, null);

            // Assign suggested products
            var productIds = suggestion.SuggestedProducts.Select(p => p.ProductId).ToList();
            if (productIds.Count > 0)
                await _specialOfferService.AssignProductsAsync(newId, productIds);

            await _configService.IncrementTotalCreatedAsync();

            _telemetry.TrackEvent("AutoPromotion.Created", new Dictionary<string, string>
            {
                ["PromotionType"] = promotionType,
                ["OfferCategory"] = offerCategory,
                ["TriggerOrderType"] = msg.OrderType,
                ["SpecialOfferID"] = newId.ToString(),
                ["ProductCount"] = productIds.Count.ToString()
            });

            _logger.LogInformation(
                "[AutoPromotion] Created SpecialOfferID={Id} ({Type}, {Pct}% off, {Products} products).",
                newId, promotionType, suggestion.DiscountPct, productIds.Count);

            // Expire out-of-stock promotions
            var expiredIds = await _specialOfferService.ExpireOutOfStockPromotionsAsync();
            if (expiredIds.Count > 0)
            {
                _logger.LogInformation("[AutoPromotion] Expired {Count} promotion(s) with out-of-stock products: {Ids}",
                    expiredIds.Count, string.Join(", ", expiredIds));
                _telemetry.TrackEvent("AutoPromotion.ExpiredOutOfStock", new Dictionary<string, string>
                {
                    ["Count"] = expiredIds.Count.ToString(),
                    ["Ids"] = string.Join(",", expiredIds)
                });
            }

            // Push real-time notification
            await _webPubSub.SendToGroupAsync("promotions", new
            {
                @event = "auto-promotion-created",
                specialOfferId = newId,
                promotionType,
                offerCategory,
                description = suggestion.Description,
                discountPct = suggestion.DiscountPct,
                productCount = productIds.Count,
                expiredPromotionIds = expiredIds
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[AutoPromotion] Failed to generate/create promotion for {OrderType}.", msg.OrderType);
            _telemetry.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"] = "AutoPromotion.Generate",
                ["OrderType"] = msg.OrderType
            });
            throw; // Let the queue retry
        }
    }

    private record AutoPromotionMessage(string OrderType);
}
