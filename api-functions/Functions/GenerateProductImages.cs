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
    private readonly AIService _aiService;
    private const string QUEUE_NAME = "product-image-generation";
    private const string THUMBNAIL_QUEUE_NAME = "product-thumbnail-generation";

    public GenerateProductImages(
        ILogger<GenerateProductImages> logger,
        ProductService productService,
        AIService aiService)
    {
        _logger = logger;
        _productService = productService;
        _aiService = aiService;
    }

    [Function(nameof(GenerateProductImages_HttpStart))]
    public async Task<HttpResponseData> GenerateProductImages_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        FunctionContext executionContext)
    {
        _logger.LogInformation("HTTP trigger received request to enqueue product image generation jobs");

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
                await response.WriteStringAsync("No products need images - all products already have 4 photos");
                return response;
            }

            // Enqueue one message per product
            int enqueued = 0;
            foreach (var product in products)
            {
                var message = JsonSerializer.Serialize(new
                {
                    ProductID = product.ProductID,
                    ProductName = product.Name
                });

                await queueClient.SendMessageAsync(message);
                enqueued++;
            }

            _logger.LogInformation("Enqueued {count} product image generation jobs", enqueued);

            var successResponse = req.CreateResponse(HttpStatusCode.OK);
            await successResponse.WriteStringAsync(
                $"Enqueued {enqueued} product image generation jobs. Each product will be processed sequentially."
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

    [Function(nameof(GenerateProductImages_QueueTrigger))]
    public async Task GenerateProductImages_QueueTrigger(
        [QueueTrigger(QUEUE_NAME, Connection = "AzureWebJobsStorage")] BinaryData queueMessage,
        FunctionContext executionContext)
    {
        try
        {
            // Parse queue message
            var messageData = JsonSerializer.Deserialize<JsonElement>(queueMessage.ToString());
            var productId = messageData.GetProperty("ProductID").GetInt32();
            var productName = messageData.GetProperty("ProductName").GetString();

            _logger.LogInformation("Processing product {id}: {name}", productId, productName);

            // Fetch current product data to verify it still needs images
            var products = await _productService.GetProductsForImageGenerationAsync();

            var product = products.FirstOrDefault(p => p.ProductID == productId);

            if (product == null)
            {
                _logger.LogInformation("Product {id} no longer needs images - skipping", productId);
                return;
            }

            _logger.LogInformation("Product {id} needs {count} images. Generating...",
                productId, 4 - product.ExistingPhotoCount);

            // Generate images for this product with retry logic for rate limiting
            List<ProductPhotoData>? photos = null;
            int maxRetries = 5;
            int retryCount = 0;

            while (retryCount < maxRetries)
            {
                try
                {
                    photos = await _aiService.GenerateProductImagesAsync(new List<ProductImageData> { product });
                    break; // Success, exit retry loop
                }
                catch (Exception ex) when (ex.Message.Contains("429") || ex.Message.Contains("RateLimitReached"))
                {
                    retryCount++;
                    if (retryCount >= maxRetries)
                    {
                        _logger.LogError("Rate limit exceeded after {retries} retries for product {id}", maxRetries, productId);
                        throw; // Let it go to poison queue after max retries
                    }

                    // Exponential backoff: 60s, 120s, 240s, 480s
                    int delaySeconds = 60 * (int)Math.Pow(2, retryCount - 1);
                    _logger.LogWarning(
                        "Rate limit hit for product {id}. Retry {retry}/{max} after {delay}s delay",
                        productId, retryCount, maxRetries, delaySeconds
                    );
                    await Task.Delay(TimeSpan.FromSeconds(delaySeconds));
                }
            }

            if (photos != null && photos.Count > 0)
            {
                // Get storage account connection for thumbnail queue using Environment variables
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
                    new QueueClientOptions
                    {
                        MessageEncoding = QueueMessageEncoding.Base64
                    }
                );

                var thumbnailQueueClient = queueServiceClient.GetQueueClient(THUMBNAIL_QUEUE_NAME);
                await thumbnailQueueClient.CreateIfNotExistsAsync();

                // Save images to database and enqueue thumbnail generation
                foreach (var photo in photos)
                {
                    var photoId = await _productService.SaveProductPhotoAsync(photo);
                    _logger.LogInformation(
                        "Saved image for ProductID {productId}: {fileName} ({size} bytes), ProductPhotoID: {photoId}",
                        photo.ProductID,
                        photo.FileName,
                        photo.ImageData.Length,
                        photoId
                    );

                    // Enqueue thumbnail generation for this photo
                    var thumbnailMessage = JsonSerializer.Serialize(new
                    {
                        ProductPhotoID = photoId,
                        LargePhotoFileName = photo.FileName
                    });

                    await thumbnailQueueClient.SendMessageAsync(thumbnailMessage);
                }

                _logger.LogInformation(
                    "Successfully processed product {id} - saved {imageCount} images and enqueued {thumbnailCount} thumbnail jobs",
                    productId, photos.Count, photos.Count);
            }
            else
            {
                _logger.LogWarning("No images generated for product {id}", productId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing product image generation from queue. Message: {message}, StackTrace: {stackTrace}",
                ex.Message, ex.StackTrace);
            throw; // Re-throw to trigger poison queue handling
        }
    }
}
