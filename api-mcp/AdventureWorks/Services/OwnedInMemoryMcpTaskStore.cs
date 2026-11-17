using System.Collections.Concurrent;
using System.Text.Json;
using AdventureWorks.Auth;
using ModelContextProtocol.Extensions.Tasks;
using ModelContextProtocol.Protocol;

namespace AdventureWorks.Services;

public sealed class OwnedInMemoryMcpTaskStore(IMcpTaskStore inner, McpTaskOwnership ownership) : IMcpTaskStore
{
    private readonly ConcurrentDictionary<string, McpTaskOwner> _owners = new(StringComparer.Ordinal);

    public event Action<InputResponseReceivedEventArgs>? InputResponseReceived
    {
        add => inner.InputResponseReceived += value;
        remove => inner.InputResponseReceived -= value;
    }

    public async Task<McpTaskInfo> CreateTaskAsync(CancellationToken cancellationToken = default)
    {
        var owner = ownership.AuthorizeCreation();
        var task = await inner.CreateTaskAsync(cancellationToken);
        if (!_owners.TryAdd(task.TaskId, owner))
            throw new InvalidOperationException("Task identity was reused by the underlying store.");
        return task;
    }

    private void Authorize(string taskId)
    {
        _owners.TryGetValue(taskId, out var owner);
        ownership.AuthorizeAccess(owner);
    }

    public Task<McpTaskInfo?> GetTaskAsync(string taskId, CancellationToken cancellationToken = default)
    {
        Authorize(taskId);
        return inner.GetTaskAsync(taskId, cancellationToken);
    }

    public Task SetCompletedAsync(string taskId, JsonElement result, CancellationToken cancellationToken = default)
    {
        Authorize(taskId);
        return inner.SetCompletedAsync(taskId, result, cancellationToken);
    }

    public Task SetFailedAsync(string taskId, JsonElement error, CancellationToken cancellationToken = default)
    {
        Authorize(taskId);
        return inner.SetFailedAsync(taskId, error, cancellationToken);
    }

    public Task<bool> SetCancelledAsync(string taskId, CancellationToken cancellationToken = default)
    {
        Authorize(taskId);
        return inner.SetCancelledAsync(taskId, cancellationToken);
    }

    public Task SetInputRequestsAsync(string taskId, IDictionary<string, InputRequest> requests,
        CancellationToken cancellationToken = default)
    {
        Authorize(taskId);
        return inner.SetInputRequestsAsync(taskId, requests, cancellationToken);
    }

    public Task ResolveInputRequestsAsync(string taskId, IDictionary<string, InputResponse> responses,
        CancellationToken cancellationToken = default)
    {
        Authorize(taskId);
        return inner.ResolveInputRequestsAsync(taskId, responses, cancellationToken);
    }
}
