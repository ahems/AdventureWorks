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
    int ApprovedToShippedMaxHours)
{
    public static readonly OrderPipelineConfig Defaults = new(
        ProcessingToApprovedMinMinutes: 5,
        ProcessingToApprovedMaxMinutes: 60,
        ApprovedToShippedMinHours: 1,
        ApprovedToShippedMaxHours: 12);
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
        await serviceClient.CreateTableIfNotExistsAsync(TableName);
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
                e.ApprovedToShippedMaxHours);
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
}
