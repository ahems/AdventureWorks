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
    private const string QUEUE_NAME = "product-review-generation";

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
        _logger.LogInformation("HTTP trigger received request to enqueue product review generation jobs");

        try
        {
            // Get queue service URI from environment variables
            var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
            if (string.IsNullOrEmpty(queueServiceUri))
            {
                var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                    ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
                queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
            }

            // Create queue client with managed identity
            var queueServiceClient = new QueueServiceClient(
                new Uri(queueServiceUri),
                new DefaultAzureCredential(),
                new QueueClientOptions
                {
                    MessageEncoding = QueueMessageEncoding.Base64
                }
            );

            var queueClient = queueServiceClient.GetQueueClient(QUEUE_NAME);
            await queueClient.CreateIfNotExistsAsync();

            // Clear existing messages from the queue and poison queue
            _logger.LogInformation("Clearing existing messages from queue: {queueName}", QUEUE_NAME);
            await queueClient.ClearMessagesAsync();

            var poisonQueueClient = queueServiceClient.GetQueueClient($"{QUEUE_NAME}-poison");
            if (await poisonQueueClient.ExistsAsync())
            {
                _logger.LogInformation("Clearing poison queue: {queueName}", $"{QUEUE_NAME}-poison");
                await poisonQueueClient.ClearMessagesAsync();
            }

            // Fetch all products that need reviews
            var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
                ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

            var reviewService = new ReviewService(connectionString);
            var products = await reviewService.GetProductsForReviewGenerationAsync();

            if (products == null || products.Count == 0)
            {
                _logger.LogInformation("No products found for review generation");
                var response = req.CreateResponse(HttpStatusCode.OK);
                await response.WriteStringAsync("No products found for review generation");
                return response;
            }

            // Enqueue one message per product batch (5 products per batch)
            int enqueued = 0;
            for (int i = 0; i < products.Count; i += 5)
            {
                var batch = products.Skip(i).Take(5).ToList();
                var message = JsonSerializer.Serialize(new
                {
                    Products = batch,
                    BatchNumber = (i / 5) + 1
                });

                await queueClient.SendMessageAsync(message);
                enqueued++;
            }

            _logger.LogInformation("Enqueued {count} review generation batches for {productCount} products", enqueued, products.Count);

            var successResponse = req.CreateResponse(HttpStatusCode.OK);
            await successResponse.WriteStringAsync(
                $"Enqueued {enqueued} review generation batches covering {products.Count} products. Reviews will be generated and then embeddings will be automatically created."
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

    [Function(nameof(GenerateProductReviewsUsingAI_QueueTrigger))]
    public async Task GenerateProductReviewsUsingAI_QueueTrigger(
        [QueueTrigger(QUEUE_NAME, Connection = "AzureWebJobsStorage")] BinaryData queueMessage,
        FunctionContext executionContext)
    {
        try
        {
            // Parse queue message
            var messageData = JsonSerializer.Deserialize<JsonElement>(queueMessage.ToString());
            var batchNumber = messageData.GetProperty("BatchNumber").GetInt32();
            var productsJson = messageData.GetProperty("Products").GetRawText();
            var products = JsonSerializer.Deserialize<List<ProductForReviewGeneration>>(productsJson);

            if (products == null || products.Count == 0)
            {
                _logger.LogWarning("Batch {batch}: No products in message", batchNumber);
                return;
            }

            _logger.LogInformation("Batch {batch}: Processing {count} products", batchNumber, products.Count);

            // Generate reviews with AI
            var endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
                ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");

            var aiServiceLogger = _loggerFactory.CreateLogger<AIService>();
            var telemetryClient = _serviceProvider.GetRequiredService<TelemetryClient>();
            var aiService = new AIService(endpoint, aiServiceLogger, telemetryClient);
            var generatedReviews = await aiService.GenerateProductReviewsAsync(products);

            _logger.LogInformation("Batch {batch}: AI generated {count} total reviews", batchNumber, generatedReviews.Count);

            // Save reviews to database
            if (generatedReviews.Count > 0)
            {
                var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
                    ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

                var reviewService = new ReviewService(connectionString);

                foreach (var review in generatedReviews)
                {
                    await reviewService.SaveGeneratedReviewAsync(review);
                }

                _logger.LogInformation("Batch {batch}: Saved {count} reviews to database", batchNumber, generatedReviews.Count);
            }

            // Check if this is the last batch by checking queue
            var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
            if (string.IsNullOrEmpty(queueServiceUri))
            {
                var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                    ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
                queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
            }

            var queueServiceClient = new QueueServiceClient(
                new Uri(queueServiceUri),
                new DefaultAzureCredential()
            );

            var queueClient = queueServiceClient.GetQueueClient(QUEUE_NAME);
            var properties = await queueClient.GetPropertiesAsync();

            // If no more messages in queue, trigger embedding generation
            if (properties.Value.ApproximateMessagesCount == 0)
            {
                _logger.LogInformation("All review batches processed. Triggering embedding generation...");

                // Trigger the embedding generation HTTP endpoint
                using var httpClient = new HttpClient();
                var embeddingEndpoint = Environment.GetEnvironmentVariable("EMBEDDING_GENERATION_ENDPOINT")
                    ?? "http://localhost:7071/api/GenerateProductReviewEmbeddings_HttpStart";

                try
                {
                    var response = await httpClient.PostAsync(embeddingEndpoint, null);
                    if (response.IsSuccessStatusCode)
                    {
                        _logger.LogInformation("Successfully triggered embedding generation");
                    }
                    else
                    {
                        _logger.LogWarning("Failed to trigger embedding generation. Status: {status}", response.StatusCode);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Could not trigger embedding generation automatically");
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to process review generation from queue");
            throw; // Re-throw to trigger poison queue handling
        }
    }
}
