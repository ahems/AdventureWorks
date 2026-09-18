using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;
using System.Net;
using System.Text.Json;
using Azure.Storage.Queues;
using Azure.Identity;

namespace api_functions.Functions;

public class GenerateProductImages
{
    private readonly ILogger<GenerateProductImages> _logger;
    private readonly ProductService _productService;
    // AIService is not used directly here; image generation is handled by AIJobProcessorFunction.
    private const string AI_JOB_QUEUE = "ai-job-image-queue";
    private const string THUMBNAIL_QUEUE_NAME = "product-thumbnail-generation";

    public GenerateProductImages(
        ILogger<GenerateProductImages> logger,
        ProductService productService)
    {
        _logger = logger;
        _productService = productService;
    }

    [Function(nameof(GenerateProductImages_HttpStart))]
    public async Task<HttpResponseData> GenerateProductImages_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        FunctionContext executionContext)
    {
        _logger.LogInformation("HTTP trigger received request to enqueue product image generation jobs");

        try
        {
            var queueServiceClient = GetQueueServiceClient();

            // Clear the image job queue (and its poison queue) so stale work doesn't block new jobs
            var aiJobQueueClient = queueServiceClient.GetQueueClient(AI_JOB_QUEUE);
            _logger.LogInformation("Clearing existing messages from queue: {queueName}", AI_JOB_QUEUE);
            await aiJobQueueClient.ClearMessagesAsync();

            var aiJobPoisonClient = queueServiceClient.GetQueueClient($"{AI_JOB_QUEUE}-poison");
            if (await aiJobPoisonClient.ExistsAsync())
            {
                _logger.LogInformation("Clearing poison queue: {queueName}", $"{AI_JOB_QUEUE}-poison");
                await aiJobPoisonClient.ClearMessagesAsync();
            }

            // Also clear thumbnail queues
            var thumbnailQueueClient = queueServiceClient.GetQueueClient(THUMBNAIL_QUEUE_NAME);
            if (await thumbnailQueueClient.ExistsAsync())
            {
                _logger.LogInformation("Clearing existing messages from queue: {queueName}", THUMBNAIL_QUEUE_NAME);
                await thumbnailQueueClient.ClearMessagesAsync();
            }

            var thumbnailPoisonQueueClient = queueServiceClient.GetQueueClient($"{THUMBNAIL_QUEUE_NAME}-poison");
            if (await thumbnailPoisonQueueClient.ExistsAsync())
            {
                _logger.LogInformation("Clearing poison queue: {queueName}", $"{THUMBNAIL_QUEUE_NAME}-poison");
                await thumbnailPoisonQueueClient.ClearMessagesAsync();
            }

            // Fetch all products that need images
            var products = await _productService.GetProductsForImageGenerationAsync();

            if (products == null || products.Count == 0)
            {
                _logger.LogInformation("No products need images");
                var response = req.CreateResponse(HttpStatusCode.OK);
                await response.WriteStringAsync("No products need images - all products already have enough photos");
                return response;
            }

            // Enqueue one ai-job-image-queue message per product
            int enqueued = 0;
            foreach (var product in products)
            {
                var message = JsonSerializer.Serialize(new AiJobMessage
                {
                    JobType = "image",
                    ProductId = product.ProductID
                });
                await aiJobQueueClient.SendMessageAsync(message);
                enqueued++;
            }

            _logger.LogInformation("Enqueued {count} image generation jobs onto {queue}", enqueued, AI_JOB_QUEUE);

            var successResponse = req.CreateResponse(HttpStatusCode.OK);
            await successResponse.WriteStringAsync(
                $"Enqueued {enqueued} image generation jobs. They will be processed one at a time."
            );
            return successResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error enqueueing product image generation jobs");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }

    [Function(nameof(GenerateProductImages_SingleProduct))]
    public async Task<HttpResponseData> GenerateProductImages_SingleProduct(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "products/{productId}/generate-images")] HttpRequestData req,
        int productId,
        FunctionContext executionContext)
    {
        _logger.LogInformation("HTTP trigger received request to enqueue image generation for product {id}", productId);

        try
        {
            var product = await _productService.GetProductForImageGenerationAsync(productId);

            if (product == null)
            {
                var notFound = req.CreateResponse(HttpStatusCode.NotFound);
                await notFound.WriteStringAsync($"Product {productId} not found or is not a finished good.");
                return notFound;
            }

            var queueServiceClient = GetQueueServiceClient();
            var aiJobQueueClient = queueServiceClient.GetQueueClient(AI_JOB_QUEUE);

            var message = JsonSerializer.Serialize(new AiJobMessage
            {
                JobType = "image",
                ProductId = product.ProductID
            });
            await aiJobQueueClient.SendMessageAsync(message);

            _logger.LogInformation("Enqueued image generation job for product {id}: {name}", product.ProductID, product.Name);

            var response = req.CreateResponse(HttpStatusCode.Accepted);
            await response.WriteStringAsync(
                $"Image generation queued for product {product.ProductID} ({product.Name}). Refresh the photo gallery in a few minutes."
            );
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error enqueueing single-product image generation for product {id}", productId);
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static QueueServiceClient GetQueueServiceClient()
    {
        var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        if (string.IsNullOrEmpty(queueServiceUri))
        {
            var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
            queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
        }

        return new QueueServiceClient(
            new Uri(queueServiceUri),
            new DefaultAzureCredential(),
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
    }
}
