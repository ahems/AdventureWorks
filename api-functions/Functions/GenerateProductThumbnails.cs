using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Processing;
using SixLabors.ImageSharp.Formats.Png;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker.Http;
using System.Net;
using Azure.Identity;
using Azure.Storage.Queues;
using Azure.Storage.Queues.Models;

namespace api_functions.Functions;

public class GenerateProductThumbnails
{
    private readonly ILogger<GenerateProductThumbnails> _logger;
    private readonly ProductService _productService;
    private const string QUEUE_NAME = "product-thumbnail-generation";

    public GenerateProductThumbnails(
        ILogger<GenerateProductThumbnails> logger,
        ProductService productService)
    {
        _logger = logger;
        _productService = productService;
    }

    [Function(nameof(GenerateProductThumbnails_QueueTrigger))]
    public async Task GenerateProductThumbnails_QueueTrigger(
        [QueueTrigger(QUEUE_NAME, Connection = "AzureWebJobsStorage")] BinaryData queueMessage,
        FunctionContext executionContext)
    {
        _logger.LogInformation("Queue trigger processing thumbnail generation");

        try
        {
            // Parse queue message to get ProductPhotoID and LargePhotoFileName
            var messageData = JsonSerializer.Deserialize<JsonElement>(queueMessage.ToString());
            var productPhotoId = messageData.GetProperty("ProductPhotoID").GetInt32();
            var largePhotoFileName = messageData.GetProperty("LargePhotoFileName").GetString();

            _logger.LogInformation(
                "Generating thumbnail for ProductPhotoID {photoId}: {fileName}",
                productPhotoId,
                largePhotoFileName
            );

            // Fetch the photo data from database
            var photo = await _productService.GetProductPhotoAsync(productPhotoId);

            if (photo == null)
            {
                _logger.LogWarning(
                    "ProductPhotoID {photoId} not found - skipping",
                    productPhotoId
                );
                return;
            }

            // Check if thumbnail already exists
            if (photo.ThumbNailPhoto != null && photo.ThumbNailPhoto.Length > 0)
            {
                _logger.LogInformation(
                    "ProductPhotoID {photoId} already has thumbnail - skipping",
                    productPhotoId
                );
                return;
            }

            // Load the image from byte array
            using var imageStream = new MemoryStream(photo.LargePhoto);
            using var image = await Image.LoadAsync(imageStream);

            // Resize to 200x200 maintaining aspect ratio
            image.Mutate(x => x.Resize(new ResizeOptions
            {
                Size = new Size(200, 200),
                Mode = ResizeMode.Max // Maintains aspect ratio, fits within 200x200
            }));

            // Save as high-quality PNG
            using var outputStream = new MemoryStream();
            var encoder = new PngEncoder
            {
                CompressionLevel = PngCompressionLevel.BestCompression
            };
            await image.SaveAsync(outputStream, encoder);
            var thumbnailData = outputStream.ToArray();

            _logger.LogInformation(
                "Generated thumbnail for ProductPhotoID {photoId}: {size} bytes",
                productPhotoId,
                thumbnailData.Length
            );

            // Save to database
            await _productService.SaveProductThumbnailAsync(productPhotoId, thumbnailData);

            _logger.LogInformation(
                "Saved thumbnail for ProductPhotoID {photoId}",
                productPhotoId
            );
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "Failed to generate thumbnail from queue message"
            );
            throw; // Re-throw to trigger poison queue handling
        }
    }

    [Function(nameof(RepairMissingThumbnails_HttpStart))]
    public async Task<HttpResponseData> RepairMissingThumbnails_HttpStart(
        [HttpTrigger(AuthorizationLevel.Function, "post")] HttpRequestData req,
        FunctionContext executionContext)
    {
        _logger.LogInformation("Starting repair of missing thumbnails");

        try
        {
            // Get all photos without thumbnails from database
            var photosNeedingThumbnails = await _productService.GetProductPhotosWithoutThumbnailsAsync();

            _logger.LogInformation(
                "Found {count} photos without thumbnails",
                photosNeedingThumbnails.Count
            );

            if (photosNeedingThumbnails.Count == 0)
            {
                var noWorkResponse = req.CreateResponse(HttpStatusCode.OK);
                await noWorkResponse.WriteStringAsync(
                    JsonSerializer.Serialize(new { message = "No photos need thumbnails" })
                );
                return noWorkResponse;
            }

            // Get storage account connection for thumbnail queue
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

            var thumbnailQueueClient = queueServiceClient.GetQueueClient(QUEUE_NAME);
            await thumbnailQueueClient.CreateIfNotExistsAsync();

            // Enqueue a message for each photo that needs a thumbnail
            int enqueuedCount = 0;
            foreach (var photo in photosNeedingThumbnails)
            {
                var thumbnailMessage = JsonSerializer.Serialize(new
                {
                    ProductPhotoID = photo.ProductPhotoID,
                    LargePhotoFileName = photo.LargePhotoFileName ?? $"product_photo_{photo.ProductPhotoID}.png"
                });

                await thumbnailQueueClient.SendMessageAsync(thumbnailMessage);
                enqueuedCount++;
            }

            _logger.LogInformation(
                "Enqueued {count} thumbnail generation messages",
                enqueuedCount
            );

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteStringAsync(
                JsonSerializer.Serialize(new
                {
                    message = $"Enqueued {enqueuedCount} photos for thumbnail generation",
                    count = enqueuedCount
                })
            );
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to repair missing thumbnails");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }
}
