using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Logging;
using api_functions.Models;

namespace api_functions.Services;

public class AutoPromotionConfigService
{
    private const string TableName = "awAutoPromotionConfig";
    private const string PartitionKey = "config";
    private const string RowKey = "auto-promotion";

    private readonly ILogger<AutoPromotionConfigService> _logger;

    public AutoPromotionConfigService(ILogger<AutoPromotionConfigService> logger)
    {
        _logger = logger;
    }

    private static async Task<TableClient> GetTableClientAsync()
    {
        var tableServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__tableServiceUri");
        if (string.IsNullOrEmpty(tableServiceUri))
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName is not configured.");
            tableServiceUri = $"https://{accountName}.table.core.windows.net";
        }

        var serviceClient = new TableServiceClient(new Uri(tableServiceUri), new DefaultAzureCredential());
        return serviceClient.GetTableClient(TableName);
    }

    public async Task<AutoPromotionConfigEntity> GetConfigAsync()
    {
        try
        {
            var table = await GetTableClientAsync();
            var response = await table.GetEntityAsync<AutoPromotionConfigEntity>(PartitionKey, RowKey);
            return response.Value;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return new AutoPromotionConfigEntity();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AutoPromotion] Could not read config — returning defaults.");
            return new AutoPromotionConfigEntity();
        }
    }

    public async Task SaveConfigAsync(AutoPromotionConfigEntity entity)
    {
        entity.PartitionKey = PartitionKey;
        entity.RowKey = RowKey;
        var table = await GetTableClientAsync();
        await table.UpsertEntityAsync(entity);
        _logger.LogInformation("[AutoPromotion] Config saved: Enabled={Enabled}, ConsumerThreshold={CT}, StoreThreshold={ST}",
            entity.IsEnabled, entity.ConsumerOrderThreshold, entity.StoreOrderThreshold);
    }

    /// <summary>
    /// Atomically increments the appropriate counter and checks if the threshold is met.
    /// Uses ETag-based optimistic concurrency. Returns (triggered, orderType).
    /// </summary>
    public async Task<(bool Triggered, string OrderType)> IncrementCounterAndCheckThresholdAsync(bool isOnlineOrder)
    {
        var table = await GetTableClientAsync();

        // Retry loop for optimistic concurrency
        for (int attempt = 0; attempt < 5; attempt++)
        {
            AutoPromotionConfigEntity entity;
            try
            {
                var response = await table.GetEntityAsync<AutoPromotionConfigEntity>(PartitionKey, RowKey);
                entity = response.Value;
            }
            catch (RequestFailedException ex) when (ex.Status == 404)
            {
                return (false, string.Empty);
            }

            if (!entity.IsEnabled)
                return (false, string.Empty);

            bool triggered = false;
            string orderType;

            if (isOnlineOrder)
            {
                if (!entity.TriggerOnConsumerOrders)
                    return (false, string.Empty);

                entity.ConsumerOrderCounter++;
                orderType = "consumer";

                if (entity.ConsumerOrderCounter >= entity.ConsumerOrderThreshold)
                {
                    entity.ConsumerOrderCounter = 0;
                    entity.LastConsumerTriggerAt = DateTimeOffset.UtcNow;
                    triggered = true;
                }
            }
            else
            {
                if (!entity.TriggerOnStoreOrders)
                    return (false, string.Empty);

                entity.StoreOrderCounter++;
                orderType = "store";

                if (entity.StoreOrderCounter >= entity.StoreOrderThreshold)
                {
                    entity.StoreOrderCounter = 0;
                    entity.LastStoreTriggerAt = DateTimeOffset.UtcNow;
                    triggered = true;
                }
            }

            try
            {
                await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);
                return (triggered, orderType);
            }
            catch (RequestFailedException ex) when (ex.Status == 412)
            {
                _logger.LogDebug("[AutoPromotion] ETag conflict on attempt {Attempt}, retrying.", attempt + 1);
            }
        }

        _logger.LogWarning("[AutoPromotion] Failed to update counter after 5 attempts.");
        return (false, string.Empty);
    }

    public async Task IncrementTotalCreatedAsync()
    {
        var table = await GetTableClientAsync();
        try
        {
            var response = await table.GetEntityAsync<AutoPromotionConfigEntity>(PartitionKey, RowKey);
            var entity = response.Value;
            entity.TotalAutoPromotionsCreated++;
            await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AutoPromotion] Could not increment total-created counter.");
        }
    }

    /// <summary>Toggles the consumer promotion type alternation bit and returns the type to use.</summary>
    public async Task<string> GetAndToggleConsumerPromotionTypeAsync()
    {
        var table = await GetTableClientAsync();
        try
        {
            var response = await table.GetEntityAsync<AutoPromotionConfigEntity>(PartitionKey, RowKey);
            var entity = response.Value;
            var type = entity.LastConsumerWasClearance ? "Promotional Discount" : "Clearance";
            entity.LastConsumerWasClearance = !entity.LastConsumerWasClearance;
            await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);
            return type;
        }
        catch
        {
            return "Promotional Discount";
        }
    }
}
