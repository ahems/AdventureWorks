using System.Collections.Concurrent;
using System.Text.Json;
using Azure.Data.Tables;
using Azure.Identity;
using ModelContextProtocol.Extensions.Tasks;
using ModelContextProtocol.Protocol;

namespace AdventureWorks.Services;

/// <summary>
/// Durable <see cref="IMcpTaskStore"/> backed by Azure Table Storage.
/// Survives process restarts and works across horizontally-scaled instances.
/// </summary>
public sealed class AzureTableMcpTaskStore : IMcpTaskStore
{
    private const string TableName = "awMcpTasks";
    private const string PartitionKey = "task";
    private static readonly TimeSpan DefaultPollInterval = TimeSpan.FromSeconds(2);

    private readonly TableClient _table;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<IDictionary<string, InputResponse>>> _inputWaiters = new();

    public event Action<InputResponseReceivedEventArgs>? InputResponseReceived;

    public AzureTableMcpTaskStore(string storageAccountName)
    {
        var serviceUri = new Uri($"https://{storageAccountName}.table.core.windows.net");
        var serviceClient = new TableServiceClient(serviceUri, new DefaultAzureCredential());
        _table = serviceClient.GetTableClient(TableName);
    }

    public async Task<McpTaskInfo> CreateTaskAsync(CancellationToken cancellationToken = default)
    {
        var taskId = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;

        var entity = new TableEntity(PartitionKey, taskId)
        {
            ["Status"] = McpTaskStatus.Working.ToString(),
            ["CreatedAt"] = now,
            ["UpdatedAt"] = now,
            ["PollIntervalMs"] = (long)DefaultPollInterval.TotalMilliseconds,
        };

        await _table.AddEntityAsync(entity, cancellationToken);

        return new McpTaskInfo(
            taskId,
            McpTaskStatus.Working,
            now,
            now,
            DefaultPollInterval,
            null,
            null,
            null,
            null,
            null);
    }

    public async Task<McpTaskInfo?> GetTaskAsync(string taskId, CancellationToken cancellationToken = default)
    {
        try
        {
            var response = await _table.GetEntityAsync<TableEntity>(PartitionKey, taskId, cancellationToken: cancellationToken);
            return MapToTaskInfo(response.Value);
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    public async Task SetCompletedAsync(string taskId, JsonElement result, CancellationToken cancellationToken = default)
    {
        var entity = new TableEntity(PartitionKey, taskId)
        {
            ["Status"] = McpTaskStatus.Completed.ToString(),
            ["UpdatedAt"] = DateTimeOffset.UtcNow,
            ["Result"] = result.GetRawText(),
            ["ProgressPercentage"] = 100L,
        };
        await _table.UpdateEntityAsync(entity, Azure.ETag.All, TableUpdateMode.Merge, cancellationToken);
    }

    public async Task SetFailedAsync(string taskId, JsonElement error, CancellationToken cancellationToken = default)
    {
        var entity = new TableEntity(PartitionKey, taskId)
        {
            ["Status"] = McpTaskStatus.Failed.ToString(),
            ["UpdatedAt"] = DateTimeOffset.UtcNow,
            ["Error"] = error.GetRawText(),
        };
        await _table.UpdateEntityAsync(entity, Azure.ETag.All, TableUpdateMode.Merge, cancellationToken);
    }

    public async Task<bool> SetCancelledAsync(string taskId, CancellationToken cancellationToken = default)
    {
        try
        {
            var entity = new TableEntity(PartitionKey, taskId)
            {
                ["Status"] = McpTaskStatus.Cancelled.ToString(),
                ["UpdatedAt"] = DateTimeOffset.UtcNow,
            };
            await _table.UpdateEntityAsync(entity, Azure.ETag.All, TableUpdateMode.Merge, cancellationToken);
            return true;
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 404)
        {
            return false;
        }
    }

    public async Task SetInputRequestsAsync(string taskId, IDictionary<string, InputRequest> inputRequests, CancellationToken cancellationToken = default)
    {
        var entity = new TableEntity(PartitionKey, taskId)
        {
            ["Status"] = McpTaskStatus.InputRequired.ToString(),
            ["UpdatedAt"] = DateTimeOffset.UtcNow,
            ["InputRequests"] = JsonSerializer.Serialize(inputRequests),
        };
        await _table.UpdateEntityAsync(entity, Azure.ETag.All, TableUpdateMode.Merge, cancellationToken);
    }

    public async Task ResolveInputRequestsAsync(string taskId, IDictionary<string, InputResponse> inputResponses, CancellationToken cancellationToken = default)
    {
        var entity = new TableEntity(PartitionKey, taskId)
        {
            ["Status"] = McpTaskStatus.Working.ToString(),
            ["UpdatedAt"] = DateTimeOffset.UtcNow,
            ["InputRequests"] = string.Empty,
        };
        await _table.UpdateEntityAsync(entity, Azure.ETag.All, TableUpdateMode.Merge, cancellationToken);

        foreach (var kvp in inputResponses)
        {
            InputResponseReceived?.Invoke(new InputResponseReceivedEventArgs
            {
                TaskId = taskId,
                RequestId = kvp.Key,
                Response = kvp.Value
            });
        }

        // Notify any in-process waiters (same instance that created the task)
        if (_inputWaiters.TryRemove(taskId, out var tcs))
            tcs.TrySetResult(inputResponses);
    }

    // Allows the tool implementation to await input responses on the same instance
    internal Task<IDictionary<string, InputResponse>> WaitForInputAsync(string taskId, CancellationToken cancellationToken)
    {
        var tcs = _inputWaiters.GetOrAdd(taskId, _ => new TaskCompletionSource<IDictionary<string, InputResponse>>());
        cancellationToken.Register(() => tcs.TrySetCanceled(cancellationToken));
        return tcs.Task;
    }

    private static McpTaskInfo MapToTaskInfo(TableEntity entity)
    {
        var status = Enum.Parse<McpTaskStatus>(entity.GetString("Status"));
        var createdAt = entity.GetDateTimeOffset("CreatedAt") ?? DateTimeOffset.UtcNow;
        var updatedAt = entity.GetDateTimeOffset("UpdatedAt") ?? DateTimeOffset.UtcNow;
        var pollMs = entity.GetInt64("PollIntervalMs");
        var progressPct = entity.GetInt64("ProgressPercentage");
        var progressMsg = entity.GetString("ProgressMessage");
        var resultJson = entity.GetString("Result");
        var errorJson = entity.GetString("Error");
        var inputRequestsJson = entity.GetString("InputRequests");

        JsonElement? result = string.IsNullOrEmpty(resultJson) ? null : JsonDocument.Parse(resultJson).RootElement;
        JsonElement? error = string.IsNullOrEmpty(errorJson) ? null : JsonDocument.Parse(errorJson).RootElement;

        IReadOnlyDictionary<string, InputRequest>? inputRequests = null;
        if (!string.IsNullOrEmpty(inputRequestsJson))
            inputRequests = JsonSerializer.Deserialize<Dictionary<string, InputRequest>>(inputRequestsJson);

        return new McpTaskInfo(
            entity.RowKey!,
            status,
            createdAt,
            updatedAt,
            pollMs.HasValue ? TimeSpan.FromMilliseconds(pollMs.Value) : DefaultPollInterval,
            progressPct,
            progressMsg,
            result,
            error,
            inputRequests);
    }
}
