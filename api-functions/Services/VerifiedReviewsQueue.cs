using System.Text.Json;
using api_functions.Models;
using Azure.Storage.Queues;

namespace api_functions.Services;

/// <summary>
/// Producer for the verified-review generation queue. The client must be configured with
/// <see cref="QueueMessageEncoding.Base64"/> so the payload matches the Functions queue trigger;
/// the message text is plain JSON and must not be encoded again here.
/// </summary>
public class VerifiedReviewsQueue(QueueClient client)
{
    public const string QueueName = "verified-reviews-queue";

    public virtual Task EnqueueAsync(VerifiedReviewsQueueMessage message, CancellationToken cancellationToken = default) =>
        client.SendMessageAsync(JsonSerializer.Serialize(message), cancellationToken);
}
