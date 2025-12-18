using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Processing;
using SixLabors.ImageSharp.Formats.Png;

namespace api_functions.Functions;

public class GenerateProductThumbnails
{
    private readonly ILogger<GenerateProductThumbnails> _logger;

    public GenerateProductThumbnails(ILogger<GenerateProductThumbnails> logger)
    {
        _logger = logger;
    }

    [Function(nameof(GenerateProductThumbnails_HttpStart))]
    public async Task<HttpResponseData> GenerateProductThumbnails_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        _logger.LogInformation("HTTP trigger received request to start product thumbnail generation");

        string instanceId = await client.ScheduleNewOrchestrationInstanceAsync(
            nameof(GenerateProductThumbnails_Orchestrator));

        _logger.LogInformation("Started orchestration with ID = '{instanceId}'", instanceId);

        return await client.CreateCheckStatusResponseAsync(req, instanceId);
    }

    [Function(nameof(GenerateProductThumbnails_Orchestrator))]
    public async Task<string> GenerateProductThumbnails_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<GenerateProductThumbnails>();
        logger.LogInformation("Starting product thumbnail generation orchestration");

        try
        {
            // Step 1: Fetch all photos that need thumbnails
            logger.LogInformation("Step 1: Fetching photos that need thumbnails");
            var photos = await context.CallActivityAsync<List<ProductPhotoThumbnailData>>(
                nameof(FetchPhotosForThumbnailsActivity));

            if (photos == null || photos.Count == 0)
            {
                logger.LogInformation("No photos need thumbnails - all photos already have thumbnails");
                return "No photos need thumbnails - all photos already have thumbnails";
            }

            logger.LogInformation("Found {count} photos that need thumbnails", photos.Count);

            // Step 2: Process thumbnails in parallel batches
            const int batchSize = 20; // Process 20 photos at a time
            var totalThumbnails = 0;

            for (int i = 0; i < photos.Count; i += batchSize)
            {
                var batch = photos.Skip(i).Take(batchSize).ToList();
                logger.LogInformation(
                    "Processing batch {batchNum} of {totalBatches} ({count} photos)",
                    (i / batchSize) + 1,
                    (photos.Count + batchSize - 1) / batchSize,
                    batch.Count
                );

                // Create parallel tasks for thumbnail generation
                var tasks = batch.Select(photo =>
                    context.CallActivityAsync<bool>(
                        nameof(GenerateThumbnailActivity),
                        photo)
                ).ToList();

                // Wait for all thumbnails in batch to complete
                var results = await Task.WhenAll(tasks);
                var successCount = results.Count(r => r);

                if (successCount > 0)
                {
                    totalThumbnails += successCount;
                    logger.LogInformation(
                        "Batch complete: {success}/{total} thumbnails generated (total: {overall})",
                        successCount,
                        batch.Count,
                        totalThumbnails
                    );
                }

                if (successCount < batch.Count)
                {
                    logger.LogWarning(
                        "{failed} thumbnails failed in batch",
                        batch.Count - successCount
                    );
                }
            }

            var message = $"Successfully generated {totalThumbnails} thumbnails from {photos.Count} photos";
            logger.LogInformation(message);
            return message;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error in orchestration");
            throw;
        }
    }

    [Function(nameof(FetchPhotosForThumbnailsActivity))]
    public async Task<List<ProductPhotoThumbnailData>> FetchPhotosForThumbnailsActivity(
        [ActivityTrigger] object input,
        FunctionContext executionContext)
    {
        var logger = executionContext.GetLogger(nameof(FetchPhotosForThumbnailsActivity));
        logger.LogInformation("Fetching photos that need thumbnails");

        var configuration = executionContext.InstanceServices
            .GetService(typeof(Microsoft.Extensions.Configuration.IConfiguration))
            as Microsoft.Extensions.Configuration.IConfiguration
            ?? throw new InvalidOperationException("Configuration not found");

        var connectionString = configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not found");

        var productService = new ProductService(connectionString);
        var photos = await productService.GetPhotosNeedingThumbnailsAsync();

        logger.LogInformation("Found {count} photos needing thumbnails", photos.Count);
        return photos;
    }

    [Function(nameof(GenerateThumbnailActivity))]
    public async Task<bool> GenerateThumbnailActivity(
        [ActivityTrigger] ProductPhotoThumbnailData photo,
        FunctionContext executionContext)
    {
        var logger = executionContext.GetLogger(nameof(GenerateThumbnailActivity));
        logger.LogInformation(
            "Generating thumbnail for ProductPhotoID {photoId}: {fileName}",
            photo.ProductPhotoID,
            photo.LargePhotoFileName
        );

        try
        {
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

            logger.LogInformation(
                "Generated thumbnail for ProductPhotoID {photoId}: {size} bytes",
                photo.ProductPhotoID,
                thumbnailData.Length
            );

            // Save to database
            var configuration = executionContext.InstanceServices
                .GetService(typeof(Microsoft.Extensions.Configuration.IConfiguration))
                as Microsoft.Extensions.Configuration.IConfiguration
                ?? throw new InvalidOperationException("Configuration not found");

            var connectionString = configuration["SQL_CONNECTION_STRING"]
                ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not found");

            var productService = new ProductService(connectionString);
            await productService.SaveProductThumbnailAsync(photo.ProductPhotoID, thumbnailData);

            logger.LogInformation(
                "Saved thumbnail for ProductPhotoID {photoId}",
                photo.ProductPhotoID
            );

            return true;
        }
        catch (Exception ex)
        {
            logger.LogError(
                ex,
                "Failed to generate thumbnail for ProductPhotoID {photoId}",
                photo.ProductPhotoID
            );
            // Return false instead of throwing to allow other thumbnails to continue
            return false;
        }
    }
}
