using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Queues;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;

namespace api_functions.Functions;

/// <summary>
/// An activity registers a bounded status observer. Events reflect persisted Durable runtime
/// state, never orchestrator replay or a premature "completed" activity notification.
/// </summary>
public sealed class UtilityLifecycleNotifications(WebPubSubService publisher)
{
    public const string QueueName = "utility-status-queue";
    public sealed record Notification(string InstanceId, string JobType, string? LastStatus = null,
        DateTimeOffset? LastUpdatedAt = null);

    public static Task RegisterAsync(TaskOrchestrationContext context, string jobType) =>
        context.Version == "push-v1"
            ? context.CallActivityAsync(nameof(RegisterUtilityLifecycle), new Notification(context.InstanceId, jobType))
            : Task.CompletedTask;

    private static QueueClient Queue()
    {
        var endpoint = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        if (string.IsNullOrEmpty(endpoint))
            endpoint = $"https://{Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("Storage account is not configured.")}.queue.core.windows.net";
        return new QueueClient(new Uri($"{endpoint.TrimEnd('/')}/{QueueName}"), new DefaultAzureCredential(),
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
    }

    [Function(nameof(RegisterUtilityLifecycle))]
    public Task RegisterUtilityLifecycle([ActivityTrigger] Notification notification) =>
        RegisterAndNotifyAsync(notification, async item =>
            await Queue().SendMessageAsync(JsonSerializer.Serialize(item)));

    public async Task RegisterAndNotifyAsync(Notification notification, Func<Notification, Task> persist)
    {
        await persist(notification);
        await publisher.SendToGroupAsync("utilities", new
        {
            @event = "utility-status-changed",
            instanceId = notification.InstanceId,
            jobType = notification.JobType,
            changeType = "Started"
        });
    }

    [Function(nameof(ObserveUtilityLifecycle))]
    public async Task ObserveUtilityLifecycle(
        [QueueTrigger(QueueName, Connection = "AzureWebJobsStorage")] Notification notification,
        [DurableClient] DurableTaskClient client)
    {
        var metadata = await client.GetInstanceAsync(notification.InstanceId, getInputsAndOutputs: false);
        if (metadata == null)
            throw new InvalidOperationException("Registered utility instance was not found.");

        await NotifyAndContinueAsync(notification, metadata, async next =>
            await Queue().SendMessageAsync(JsonSerializer.Serialize(next), visibilityTimeout: TimeSpan.FromSeconds(3)));
    }

    public async Task NotifyAndContinueAsync(Notification notification, OrchestrationMetadata metadata,
        Func<Notification, Task> requeue)
    {
        if (HasChanged(notification, metadata))
            await publisher.SendToGroupAsync("utilities", new
            {
                @event = "utility-status-changed",
                instanceId = notification.InstanceId,
                jobType = notification.JobType,
                changeType = metadata.RuntimeStatus.ToString()
            });

        if (!metadata.IsCompleted && metadata.RuntimeStatus.ToString() != "Canceled")
            await requeue(notification with
            {
                LastStatus = metadata.RuntimeStatus.ToString(),
                LastUpdatedAt = metadata.LastUpdatedAt
            });
    }

    public static bool HasChanged(Notification previous, OrchestrationMetadata current) =>
        previous.LastStatus != current.RuntimeStatus.ToString() || previous.LastUpdatedAt != current.LastUpdatedAt;
}
