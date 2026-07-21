using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Logging;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Persists and retrieves the manufacturing agent autonomy mode in Azure Table Storage.
/// Follows the same pattern as <see cref="OrderPipelineConfigService"/>.
/// </summary>
public class ManufacturingAgentConfigService
{
    private const string TableName    = "awManufacturingAgentConfig";
    private const string PartitionKey = "config";
    private const string RowKey       = "manufacturing-agent";

    private readonly ILogger<ManufacturingAgentConfigService> _logger;

    public ManufacturingAgentConfigService(ILogger<ManufacturingAgentConfigService> logger)
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

    /// <summary>Returns the current agent mode. Defaults to Off if not yet configured.
    /// Also enforces auto-shutoff: if <c>AutoShutoffAt</c> has passed, switches to Off.</summary>
    public async Task<ManufacturingAgentMode> GetModeAsync()
    {
        try
        {
            var table    = await GetTableClientAsync();
            var response = await table.GetEntityAsync<ManufacturingAgentConfigEntity>(PartitionKey, RowKey);
            var entity   = response.Value;

            // Auto-shutoff: if the scheduled time has passed, switch to Off
            if (entity.AutoShutoffAt.HasValue
                && entity.AutoShutoffAt.Value <= DateTimeOffset.UtcNow
                && entity.Mode != (int)ManufacturingAgentMode.Off)
            {
                _logger.LogInformation(
                    "[AgentConfig] Auto-shutoff triggered at {At} — switching to Off.",
                    entity.AutoShutoffAt.Value.ToString("u"));
                entity.Mode         = (int)ManufacturingAgentMode.Off;
                entity.AutoShutoffAt = null;
                await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);
            }

            return (ManufacturingAgentMode)entity.Mode;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return ManufacturingAgentMode.Off;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AgentConfig] Could not read mode from Table Storage — defaulting to Off.");
            return ManufacturingAgentMode.Off;
        }
    }

    /// <summary>Returns both the current mode and the auto-shutoff time (enforcing shutoff if elapsed).</summary>
    public async Task<(ManufacturingAgentMode Mode, DateTimeOffset? AutoShutoffAt)> GetConfigAsync()
    {
        try
        {
            var table    = await GetTableClientAsync();
            var response = await table.GetEntityAsync<ManufacturingAgentConfigEntity>(PartitionKey, RowKey);
            var entity   = response.Value;

            if (entity.AutoShutoffAt.HasValue
                && entity.AutoShutoffAt.Value <= DateTimeOffset.UtcNow
                && entity.Mode != (int)ManufacturingAgentMode.Off)
            {
                _logger.LogInformation("[AgentConfig] Auto-shutoff triggered.");
                entity.Mode         = (int)ManufacturingAgentMode.Off;
                entity.AutoShutoffAt = null;
                await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);
            }

            return ((ManufacturingAgentMode)entity.Mode, entity.AutoShutoffAt);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return (ManufacturingAgentMode.Off, null);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AgentConfig] Could not read config — defaulting to Off.");
            return (ManufacturingAgentMode.Off, null);
        }
    }

    /// <summary>Persists a new mode and optional auto-shutoff duration to Table Storage.</summary>
    /// <param name="mode">The new mode.</param>
    /// <param name="autoShutoffHours">
    ///   Hours until the agent is automatically switched to Off (1–72).
    ///   Ignored (cleared) when <paramref name="mode"/> is <see cref="ManufacturingAgentMode.Off"/>.
    /// </param>
    public async Task SaveModeAsync(ManufacturingAgentMode mode, int? autoShutoffHours = null)
    {
        DateTimeOffset? shutoffAt = null;
        if (mode != ManufacturingAgentMode.Off && autoShutoffHours.HasValue)
            shutoffAt = DateTimeOffset.UtcNow.AddHours(Math.Clamp(autoShutoffHours.Value, 1, 72));

        var table  = await GetTableClientAsync();
        var entity = new ManufacturingAgentConfigEntity
        {
            Mode         = (int)mode,
            AutoShutoffAt = shutoffAt,
        };
        await table.UpsertEntityAsync(entity);
        _logger.LogInformation(
            "[AgentConfig] Mode saved: {Mode}, AutoShutoffAt: {Shutoff}",
            mode, shutoffAt?.ToString("u") ?? "none");
    }
}
