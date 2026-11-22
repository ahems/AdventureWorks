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
    private readonly WebPubSubService _publisher;

    public ManufacturingAgentConfigService(ILogger<ManufacturingAgentConfigService> logger, WebPubSubService publisher)
    {
        _logger = logger;
        _publisher = publisher;
    }

    private async Task<TableClient> GetTableClientAsync()
    {
        var tableServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__tableServiceUri");
        if (string.IsNullOrEmpty(tableServiceUri))
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName is not configured.");
            tableServiceUri = $"https://{accountName}.table.core.windows.net";
        }

        return new NotifyingTableClient(new Uri(tableServiceUri), TableName, new DefaultAzureCredential(), _publisher, "manufacturing-agent");
    }

    /// <summary>Returns the effective agent mode. Defaults to Off if not yet configured, and
    /// reports Off once <c>AutoShutoffAt</c> has passed. Read-only; persistence of the shutoff is
    /// done by <see cref="EnforceAutoShutoffAsync"/>.</summary>
    public async Task<ManufacturingAgentMode> GetModeAsync() => (await GetConfigAsync()).Mode;

    /// <summary>Returns the effective mode and auto-shutoff time without writing.</summary>
    public async Task<(ManufacturingAgentMode Mode, DateTimeOffset? AutoShutoffAt)> GetConfigAsync()
    {
        try
        {
            var table    = await GetTableClientAsync();
            var response = await table.GetEntityAsync<ManufacturingAgentConfigEntity>(PartitionKey, RowKey);
            return Effective(response.Value, DateTimeOffset.UtcNow);
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

    /// <summary>Returns the mode and shutoff time that apply at <paramref name="now"/>.</summary>
    public static (ManufacturingAgentMode Mode, DateTimeOffset? AutoShutoffAt) Effective(
        ManufacturingAgentConfigEntity entity, DateTimeOffset now) =>
        IsShutoffDue(entity, now)
            ? (ManufacturingAgentMode.Off, null)
            : ((ManufacturingAgentMode)entity.Mode, entity.AutoShutoffAt);

    public static bool IsShutoffDue(ManufacturingAgentConfigEntity entity, DateTimeOffset now) =>
        entity.AutoShutoffAt.HasValue
        && entity.AutoShutoffAt.Value <= now
        && entity.Mode != (int)ManufacturingAgentMode.Off;

    /// <summary>Persists Off when the scheduled auto-shutoff has passed. Called by the maintenance timer.</summary>
    public async Task<bool> EnforceAutoShutoffAsync()
    {
        var table = await GetTableClientAsync();
        ManufacturingAgentConfigEntity entity;
        try
        {
            entity = (await table.GetEntityAsync<ManufacturingAgentConfigEntity>(PartitionKey, RowKey)).Value;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return false;
        }

        if (!IsShutoffDue(entity, DateTimeOffset.UtcNow)) return false;

        _logger.LogInformation(
            "[AgentConfig] Auto-shutoff reached at {At} — switching to Off.",
            entity.AutoShutoffAt!.Value.ToString("u"));
        entity.Mode          = (int)ManufacturingAgentMode.Off;
        entity.AutoShutoffAt = null;
        try
        {
            await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);
        }
        catch (RequestFailedException ex) when (ex.Status == 412)
        {
            // A concurrent PUT changed the config; the next timer run re-evaluates it.
            return false;
        }
        return true;
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
