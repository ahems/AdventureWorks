using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.ApplicationInsights;
using api_functions.Models;
using api_functions.Services;
using System.Net;
using System.Text.Json;
using Azure.Storage.Queues;
using Azure.Identity;

namespace api_functions.Functions;

public class GenerateProductReviewsUsingAI
{
    private readonly ILogger<GenerateProductReviewsUsingAI> _logger;
    private readonly ILoggerFactory _loggerFactory;
    private readonly IServiceProvider _serviceProvider;
    private const string AI_JOB_QUEUE = "ai-job-chat-queue";

    public GenerateProductReviewsUsingAI(ILogger<GenerateProductReviewsUsingAI> logger, ILoggerFactory loggerFactory, IServiceProvider serviceProvider)
    {
        _logger = logger;
        _loggerFactory = loggerFactory;
        _serviceProvider = serviceProvider;
    }

    [Function(nameof(GenerateProductReviewsUsingAI_HttpStart))]
    public async Task<HttpResponseData> GenerateProductReviewsUsingAI_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        _logger.LogInformation("Review generation request: enqueuing review jobs onto ai-job-chat-queue");

        try
        {
            // Parse optional product filter
            List<int>? filterProductIds = null;
            var requestBody = await req.ReadAsStringAsync();
            if (!string.IsNullOrWhiteSpace(requestBody))
            {
                try
                {
                    var payload = JsonSerializer.Deserialize<ReviewGenerationRequest>(requestBody);
                    if (payload?.ProductIds?.Count > 0)
                    {
                        filterProductIds = payload.ProductIds;
                        _logger.LogInformation("Filtering review generation to {count} product(s)", filterProductIds.Count);
                    }
                }
                catch (JsonException) { /* Ignore malformed body */ }
            }

            var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
                ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");
            var reviewService = new ReviewService(connectionString);
            var products = await reviewService.GetProductsForReviewGenerationAsync(filterProductIds);

            if (products == null || products.Count == 0)
            {
                _logger.LogInformation("No products found for review generation");
                var emptyResponse = req.CreateResponse(HttpStatusCode.OK);
                await emptyResponse.WriteStringAsync("No products found for review generation");
                return emptyResponse;
            }

            // Build queue client
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
            await aiJobQueueClient.CreateIfNotExistsAsync();

            // Enqueue one message per batch of 5 products.
            // The chat-queue processor will auto-enqueue review-embeddings when the queue drains.
            int enqueued = 0;
            for (int i = 0; i < products.Count; i += 5)
            {
                var batch = products.Skip(i).Take(5).Select(p => p.ProductID).ToList();
                var message = JsonSerializer.Serialize(new AiJobMessage
                {
                    JobType = "review",
                    ProductIds = batch
                });
                await aiJobQueueClient.SendMessageAsync(message);
                enqueued++;
            }

            _logger.LogInformation("Enqueued {count} review batches onto {queue}",
                enqueued, AI_JOB_QUEUE);

            var successResponse = req.CreateResponse(HttpStatusCode.OK);
            await successResponse.WriteStringAsync(
                $"Enqueued {enqueued} review generation batches covering {products.Count} products. " +
                "Reviews and embeddings will be generated serially in the background."
            );
            return successResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error enqueueing product review generation jobs");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }

    private class ReviewGenerationRequest
    {
        public List<int>? ProductIds { get; set; }
    }
}
