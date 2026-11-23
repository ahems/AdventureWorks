using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using api_functions.Models;
using Azure.Storage.Queues;
using Azure.Identity;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

public class GenerateProductReviewEmbeddings
{
    private readonly ILogger<GenerateProductReviewEmbeddings> _logger;
    private const string AI_JOB_QUEUE = "ai-job-embeddings-queue";

    public GenerateProductReviewEmbeddings(ILogger<GenerateProductReviewEmbeddings> logger)
    {
        _logger = logger;
    }

    [Function("GenerateProductReviewEmbeddings_HttpStart")]
    public async Task<HttpResponseData> HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        _logger.LogInformation("Review-embeddings request: enqueuing onto ai-job-embeddings-queue");

        try
        {
            var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
            if (string.IsNullOrEmpty(queueServiceUri))
            {
                var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                    ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
                queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
            }
            var queueServiceClient = new QueueServiceClient(
                new Uri(queueServiceUri),
                new DefaultAzureCredential(),
                new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });

            var aiJobQueueClient = queueServiceClient.GetQueueClient(AI_JOB_QUEUE);

            var message = JsonSerializer.Serialize(new AiJobMessage { JobType = "review-embeddings" });
            await aiJobQueueClient.SendObservedMessageAsync(message);

            _logger.LogInformation("Enqueued review-embeddings job onto {queue}", AI_JOB_QUEUE);

            var jobId = Guid.NewGuid().ToString();
            var response = req.CreateResponse(HttpStatusCode.Accepted);
            await response.WriteAsJsonAsync(new { id = jobId, message = "Review embeddings job queued and will be processed serially." });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error enqueueing review-embeddings job");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }
}
