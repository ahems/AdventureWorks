using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

/// <summary>
/// Holds the configurable timing parameters for the sales order status pipeline.
/// </summary>
public record OrderPipelineConfig(
    int ProcessingToApprovedMinMinutes,
    int ProcessingToApprovedMaxMinutes,
    int ApprovedToShippedMinHours,
    int ApprovedToShippedMaxHours,
    int ShippedToDeliveredMinDaysB2C,
    int ShippedToDeliveredMaxDaysB2C,
    int ShippedToDeliveredMinDaysB2B,
    int ShippedToDeliveredMaxDaysB2B)
{
    public static readonly OrderPipelineConfig Defaults = new(
        ProcessingToApprovedMinMinutes: 5,
        ProcessingToApprovedMaxMinutes: 60,
        ApprovedToShippedMinHours: 1,
        ApprovedToShippedMaxHours: 12,
        ShippedToDeliveredMinDaysB2C: 3,
        ShippedToDeliveredMaxDaysB2C: 7,
        ShippedToDeliveredMinDaysB2B: 5,
        ShippedToDeliveredMaxDaysB2B: 10);
}

/// <summary>
/// Persists and retrieves the order processing pipeline timing configuration
/// in Azure Table Storage so it survives across Azure Functions restarts.
/// </summary>
public class OrderPipelineConfigService
{
    private const string TableName     = "awOrderPipelineConfig";
    private const string PartitionKey  = "config";
    private const string RowKey        = "order-pipeline";

    private readonly ILogger<OrderPipelineConfigService> _logger;

    public OrderPipelineConfigService(ILogger<OrderPipelineConfigService> logger)
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

    /// <summary>Returns the current pipeline configuration, or defaults if none has been saved.</summary>
    public async Task<OrderPipelineConfig> GetConfigAsync()
    {
        try
        {
            var table    = await GetTableClientAsync();
            var response = await table.GetEntityAsync<OrderPipelineConfigEntity>(PartitionKey, RowKey);
            var e        = response.Value;
            return new OrderPipelineConfig(
                e.ProcessingToApprovedMinMinutes,
                e.ProcessingToApprovedMaxMinutes,
                e.ApprovedToShippedMinHours,
                e.ApprovedToShippedMaxHours,
                e.ShippedToDeliveredMinDaysB2C,
                e.ShippedToDeliveredMaxDaysB2C,
                e.ShippedToDeliveredMinDaysB2B,
                e.ShippedToDeliveredMaxDaysB2B);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return OrderPipelineConfig.Defaults;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[PipelineConfig] Could not read config from Table Storage — using defaults.");
            return OrderPipelineConfig.Defaults;
        }
    }

    /// <summary>Persists a new configuration to Table Storage.</summary>
    public async Task SaveConfigAsync(OrderPipelineConfig config)
    {
        var table  = await GetTableClientAsync();
        var entity = new OrderPipelineConfigEntity
        {
            PartitionKey                    = PartitionKey,
            RowKey                          = RowKey,
            ProcessingToApprovedMinMinutes  = config.ProcessingToApprovedMinMinutes,
            ProcessingToApprovedMaxMinutes  = config.ProcessingToApprovedMaxMinutes,
            ApprovedToShippedMinHours       = config.ApprovedToShippedMinHours,
            ApprovedToShippedMaxHours       = config.ApprovedToShippedMaxHours,
            ShippedToDeliveredMinDaysB2C    = config.ShippedToDeliveredMinDaysB2C,
            ShippedToDeliveredMaxDaysB2C    = config.ShippedToDeliveredMaxDaysB2C,
            ShippedToDeliveredMinDaysB2B    = config.ShippedToDeliveredMinDaysB2B,
            ShippedToDeliveredMaxDaysB2B    = config.ShippedToDeliveredMaxDaysB2B,
        };
        await table.UpsertEntityAsync(entity);
        _logger.LogInformation(
            "[PipelineConfig] Saved: ProcessingToApproved={Min}-{Max} min, ApprovedToShipped={HMin}-{HMax} h",
            config.ProcessingToApprovedMinMinutes, config.ProcessingToApprovedMaxMinutes,
            config.ApprovedToShippedMinHours,      config.ApprovedToShippedMaxHours);
    }
}

// ── Table Storage entity ─────────────────────────────────────────────────────

internal class OrderPipelineConfigEntity : ITableEntity
{
    public string PartitionKey { get; set; } = "config";
    public string RowKey       { get; set; } = "order-pipeline";
    public ETag   ETag         { get; set; } = ETag.All;
    public DateTimeOffset? Timestamp { get; set; }

    public int ProcessingToApprovedMinMinutes { get; set; } = 5;
    public int ProcessingToApprovedMaxMinutes { get; set; } = 60;
    public int ApprovedToShippedMinHours      { get; set; } = 1;
    public int ApprovedToShippedMaxHours      { get; set; } = 12;
    public int ShippedToDeliveredMinDaysB2C   { get; set; } = 3;
    public int ShippedToDeliveredMaxDaysB2C   { get; set; } = 7;
    public int ShippedToDeliveredMinDaysB2B   { get; set; } = 5;
    public int ShippedToDeliveredMaxDaysB2B   { get; set; } = 10;
}
