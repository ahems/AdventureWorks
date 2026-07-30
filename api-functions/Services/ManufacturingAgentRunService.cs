using System.Text.Json;
using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Azure.Storage.Queues;
using Microsoft.Extensions.Logging;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Manages manufacturing agent run records and queue-depth metrics in Azure Table Storage.
///
/// Each run tracks the full lifecycle of a single agent invocation:
///   pending → running → completed | retrying → … → completed | failed
///
/// Intra-run progress is stored as a JSON array in StepsJson, updated via the
/// step-callback endpoint as the hosted agent progresses through its work.
/// </summary>
public class ManufacturingAgentRunService
{
    internal const string TableName    = "awManufacturingAgentRuns";
    internal const string QueueName    = "manufacturing-agent-queue";
    internal const string PoisonSuffix = "-poison";
    private  const string PartitionKey = "runs";

    private static readonly JsonSerializerOptions JsonOpts =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly ILogger<ManufacturingAgentRunService> _logger;
    private readonly string _tableServiceUri;
    private readonly string _queueServiceUri;

    public ManufacturingAgentRunService(
        ILogger<ManufacturingAgentRunService> logger,
        string tableServiceUri,
        string queueServiceUri)
    {
        _logger          = logger;
        _tableServiceUri = tableServiceUri;
        _queueServiceUri = queueServiceUri;
    }

    // ── Table client ──────────────────────────────────────────────────────────

    private async Task<TableClient> GetTableClientAsync()
    {
        var serviceClient = new TableServiceClient(new Uri(_tableServiceUri), new DefaultAzureCredential());
        return serviceClient.GetTableClient(TableName);
    }

    // ── Run lifecycle ─────────────────────────────────────────────────────────

    /// <summary>
    /// Creates a run record in <c>pending</c> state at enqueue time.
    /// Returns the new RunId (GUID string).
    /// </summary>
    public async Task<string> CreateRunAsync(int salesOrderId, int customerId, ManufacturingAgentMode mode)
    {
        var runId  = Guid.NewGuid().ToString();
        var entity = new ManufacturingAgentRunEntity
        {
            PartitionKey = PartitionKey,
            RowKey       = ManufacturingAgentRunEntity.NewRowKey(runId),
            RunId        = runId,
            SalesOrderId = salesOrderId,
            CustomerId   = customerId,
            Mode         = (int)mode,
            Status       = "pending",
            EnqueuedAt   = DateTimeOffset.UtcNow,
        };

        var table = await GetTableClientAsync();
        await table.AddEntityAsync(entity);
        _logger.LogInformation("[AgentRun] Created run {RunId} for order {SalesOrderId}", runId, salesOrderId);
        return runId;
    }

    /// <summary>Transitions a run from pending → running.</summary>
    public async Task StartRunAsync(string runId)
        => await PatchRunAsync(runId, e =>
        {
            e.Status    = "running";
            e.StartedAt = DateTimeOffset.UtcNow;
        });

    /// <summary>Appends a new step to StepsJson with status=started.</summary>
    public async Task AddStepAsync(string runId, string key, string label)
        => await PatchRunAsync(runId, e =>
        {
            var steps  = ParseSteps(e.StepsJson);
            steps.RemoveAll(s => s.Key == key); // idempotent
            steps.Add(new AgentStep(key, label, DateTimeOffset.UtcNow, null));
            e.StepsJson = JsonSerializer.Serialize(steps, JsonOpts);
        });

    /// <summary>Marks an existing step as completed.</summary>
    public async Task CompleteStepAsync(string runId, string key)
        => await PatchRunAsync(runId, e =>
        {
            var steps = ParseSteps(e.StepsJson);
            var step  = steps.FirstOrDefault(s => s.Key == key);
            if (step != null)
            {
                var idx = steps.IndexOf(step);
                steps[idx] = step with { CompletedAt = DateTimeOffset.UtcNow };
            }
            e.StepsJson = JsonSerializer.Serialize(steps, JsonOpts);
        });

    /// <summary>Transitions a run to completed with findings.</summary>
    public async Task CompleteRunAsync(
        string runId,
        string? findingsSummary,
        IEnumerable<string>? toolsUsed,
        IEnumerable<string>? proposalIds,
        IEnumerable<string>? actionsExecuted)
        => await PatchRunAsync(runId, e =>
        {
            e.Status         = "completed";
            e.CompletedAt    = DateTimeOffset.UtcNow;
            e.FindingsSummary = findingsSummary;
            if (toolsUsed != null)       e.ToolsUsed       = JsonSerializer.Serialize(toolsUsed);
            if (proposalIds != null)     e.ProposalIds     = JsonSerializer.Serialize(proposalIds);
            if (actionsExecuted != null) e.ActionsExecuted = JsonSerializer.Serialize(actionsExecuted);
        });

    /// <summary>Transitions a run to retrying with backoff metadata.</summary>
    public async Task RetryRunAsync(string runId, int newRetryCount, DateTimeOffset retryAfter, string error)
        => await PatchRunAsync(runId, e =>
        {
            e.Status        = "retrying";
            e.RetryCount    = newRetryCount;
            e.RetryAfterUtc = retryAfter;
            e.LastError     = error.Length > 500 ? error[..500] : error;
        });

    /// <summary>Transitions a run to failed (max retries exceeded).</summary>
    public async Task FailRunAsync(string runId, string error)
        => await PatchRunAsync(runId, e =>
        {
            e.Status      = "failed";
            e.CompletedAt = DateTimeOffset.UtcNow;
            e.LastError   = error.Length > 500 ? error[..500] : error;
        });

    // ── Queries ───────────────────────────────────────────────────────────────

    /// <summary>Returns the most recent <paramref name="limit"/> runs, newest first.</summary>
    public async Task<List<ManufacturingAgentRunEntity>> ListRecentAsync(int limit = 20)
    {
        var table   = await GetTableClientAsync();
        var results = new List<ManufacturingAgentRunEntity>();

        await foreach (var entity in table.QueryAsync<ManufacturingAgentRunEntity>(
            e => e.PartitionKey == PartitionKey))
        {
            results.Add(entity);
            if (results.Count >= limit) break;
        }

        return results; // RowKey ordering gives newest-first
    }

    /// <summary>Gets a single run by RunId, or null if not found.</summary>
    public async Task<ManufacturingAgentRunEntity?> GetRunAsync(string runId)
    {
        var table = await GetTableClientAsync();
        await foreach (var entity in table.QueryAsync<ManufacturingAgentRunEntity>(
            e => e.PartitionKey == PartitionKey && e.RunId == runId))
        {
            return entity;
        }
        return null;
    }

    // ── Queue status ──────────────────────────────────────────────────────────

    /// <summary>
    /// Returns approximate queue depths for the main and poison queues,
    /// plus an estimated drain time derived from recent run throughput.
    /// </summary>
    public async Task<ManufacturingAgentQueueStatus> GetQueueStatusAsync()
    {
        var queueSvcClient = new QueueServiceClient(new Uri(_queueServiceUri), new DefaultAzureCredential());
        var mainQueue      = queueSvcClient.GetQueueClient(QueueName);
        var poisonQueue    = queueSvcClient.GetQueueClient(QueueName + PoisonSuffix);

        int pending    = 0;
        int poisonDepth = 0;
        bool isProcessing = false;

        try
        {
            var props  = await mainQueue.GetPropertiesAsync();
            pending    = props.Value.ApproximateMessagesCount;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AgentRun] Could not read main queue depth.");
        }

        try
        {
            var props   = await poisonQueue.GetPropertiesAsync();
            poisonDepth = props.Value.ApproximateMessagesCount;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AgentRun] Could not read poison queue depth.");
        }

        // Estimate throughput from runs completed in the last 10 minutes
        var table = await GetTableClientAsync();
        var cutoff = DateTimeOffset.UtcNow.AddMinutes(-10);
        int completedRecent = 0;
        double totalElapsedSec = 0;

        await foreach (var e in table.QueryAsync<ManufacturingAgentRunEntity>(
            r => r.PartitionKey == PartitionKey && r.Status == "completed"))
        {
            if (e.CompletedAt.HasValue && e.CompletedAt > cutoff && e.StartedAt.HasValue)
            {
                completedRecent++;
                totalElapsedSec += (e.CompletedAt.Value - e.StartedAt.Value).TotalSeconds;
                isProcessing = true; // at least one completed recently
            }

            if (completedRecent >= 20) break; // enough sample
        }

        // Check for a currently-running entry
        await foreach (var e in table.QueryAsync<ManufacturingAgentRunEntity>(
            r => r.PartitionKey == PartitionKey && r.Status == "running"))
        {
            isProcessing = true;
            break;
        }

        double? estimatedDrainMinutes = null;
        DateTimeOffset? lastCompletedAt = null;

        if (completedRecent > 0)
        {
            var avgSec           = totalElapsedSec / completedRecent;
            var throughputPerMin = 60.0 / avgSec;
            estimatedDrainMinutes = pending > 0 ? Math.Round(pending / throughputPerMin, 1) : 0;
        }

        // Find last completed run time
        await foreach (var e in table.QueryAsync<ManufacturingAgentRunEntity>(
            r => r.PartitionKey == PartitionKey && r.Status == "completed"))
        {
            lastCompletedAt = e.CompletedAt;
            break; // newest-first ordering, first match is the latest
        }

        return new ManufacturingAgentQueueStatus(
            Pending: pending,
            PoisonQueue: poisonDepth,
            IsProcessing: isProcessing,
            LastCompletedAt: lastCompletedAt,
            EstimatedDrainMinutes: estimatedDrainMinutes);
    }

    /// <summary>Clears all messages from the main agent queue.</summary>
    public async Task ClearQueueAsync()
    {
        var queueSvcClient = new QueueServiceClient(new Uri(_queueServiceUri), new DefaultAzureCredential());
        var mainQueue      = queueSvcClient.GetQueueClient(QueueName);
        await mainQueue.ClearMessagesAsync();
        _logger.LogInformation("[AgentRun] Agent queue cleared.");
    }

    /// <summary>Clears all messages from the poison queue.</summary>
    public async Task ClearPoisonQueueAsync()
    {
        var queueSvcClient = new QueueServiceClient(new Uri(_queueServiceUri), new DefaultAzureCredential());
        var poisonQueue    = queueSvcClient.GetQueueClient(QueueName + PoisonSuffix);
        await poisonQueue.ClearMessagesAsync();
        _logger.LogInformation("[AgentRun] Agent poison queue cleared.");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async Task PatchRunAsync(string runId, Action<ManufacturingAgentRunEntity> patch)
    {
        var entity = await GetRunAsync(runId);
        if (entity == null)
        {
            _logger.LogWarning("[AgentRun] Run {RunId} not found for patch.", runId);
            return;
        }

        patch(entity);
        var table = await GetTableClientAsync();
        await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);
    }

    private static List<AgentStep> ParseSteps(string? json)
    {
        if (string.IsNullOrEmpty(json)) return [];
        try { return JsonSerializer.Deserialize<List<AgentStep>>(json, JsonOpts) ?? []; }
        catch { return []; }
    }
}

// ── Supporting types ──────────────────────────────────────────────────────────

public record AgentStep(
    string Key,
    string Label,
    DateTimeOffset StartedAt,
    DateTimeOffset? CompletedAt);

public record ManufacturingAgentQueueStatus(
    int Pending,
    int PoisonQueue,
    bool IsProcessing,
    DateTimeOffset? LastCompletedAt,
    double? EstimatedDrainMinutes);
