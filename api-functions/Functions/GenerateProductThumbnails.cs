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

            // Generate thumbnail filename based on large photo filename
            // Example: "product_680_photo_2.png" -> "product_680_photo_2_small.png"
            var thumbnailFileName = GenerateThumbnailFileName(largePhotoFileName);

            // Save to database
            await _productService.SaveProductThumbnailAsync(productPhotoId, thumbnailData, thumbnailFileName);

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

    /// <summary>
    /// Generate thumbnail filename from large photo filename
    /// Examples:
    ///   "product_680_photo_2.png" -> "product_680_photo_2_small.png"
    ///   "my_image.jpg" -> "my_image_small.jpg"
    /// </summary>
    private static string GenerateThumbnailFileName(string? largePhotoFileName)
    {
        if (string.IsNullOrEmpty(largePhotoFileName))
        {
            return "thumbnail.png";
        }

        var extension = Path.GetExtension(largePhotoFileName);
        var nameWithoutExtension = Path.GetFileNameWithoutExtension(largePhotoFileName);
        return $"{nameWithoutExtension}_small{extension}";
    }
}
