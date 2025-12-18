using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;
using System.Net;

namespace api_functions.Functions;

public class GenerateProductImages
{
    private readonly ILogger<GenerateProductImages> _logger;

    public GenerateProductImages(ILogger<GenerateProductImages> logger)
    {
        _logger = logger;
    }

    [Function(nameof(GenerateProductImages_HttpStart))]
    public async Task<HttpResponseData> GenerateProductImages_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        _logger.LogInformation("HTTP trigger received request to start product image generation");

        string instanceId = await client.ScheduleNewOrchestrationInstanceAsync(
            nameof(GenerateProductImages_Orchestrator));

        _logger.LogInformation("Started orchestration with ID = '{instanceId}'", instanceId);

        return await client.CreateCheckStatusResponseAsync(req, instanceId);
    }

    [Function(nameof(GenerateProductImages_Orchestrator))]
    public async Task<string> GenerateProductImages_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<GenerateProductImages>();
        logger.LogInformation("Starting product image generation orchestration");

        try
        {
            // Step 1: Fetch all products that need images (less than 4 photos)
            logger.LogInformation("Step 1: Fetching products that need images");
            var products = await context.CallActivityAsync<List<ProductImageData>>(
                nameof(FetchProductsForImagesActivity));

            if (products == null || products.Count == 0)
            {
                logger.LogInformation("No products need images - all products already have 4 photos");
                return "No products need images - all products already have 4 photos";
            }

            logger.LogInformation("Found {count} products that need images", products.Count);

            // Step 2: Generate images in batches of 10 products
            const int batchSize = 10;
            var totalPhotos = 0;

            for (int i = 0; i < products.Count; i += batchSize)
            {
                var batch = products.Skip(i).Take(batchSize).ToList();
                logger.LogInformation(
                    "Processing batch {batchNum} of {totalBatches} ({count} products)",
                    (i / batchSize) + 1,
                    (products.Count + batchSize - 1) / batchSize,
                    batch.Count
                );

                // Generate images for this batch
                var photos = await context.CallActivityAsync<List<ProductPhotoData>>(
                    nameof(GenerateProductImagesActivity),
                    batch);

                if (photos != null && photos.Count > 0)
                {
                    logger.LogInformation("Generated {count} images for batch", photos.Count);

                    // Step 3: Save images to database
                    await context.CallActivityAsync(
                        nameof(SaveProductImagesActivity),
                        photos);

                    totalPhotos += photos.Count;
                    logger.LogInformation("Saved {count} images to database (total: {total})",
                        photos.Count, totalPhotos);
                }
                else
                {
                    logger.LogWarning("No images generated for batch");
                }
            }

            var message = $"Successfully generated {totalPhotos} product images for {products.Count} products";
            logger.LogInformation(message);
            return message;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error in orchestration");
            throw;
        }
    }

    [Function(nameof(FetchProductsForImagesActivity))]
    public async Task<List<ProductImageData>> FetchProductsForImagesActivity(
        [ActivityTrigger] object input,
        FunctionContext executionContext)
    {
        var logger = executionContext.GetLogger(nameof(FetchProductsForImagesActivity));
        logger.LogInformation("Fetching products that need images");

        var configuration = executionContext.InstanceServices
            .GetService(typeof(Microsoft.Extensions.Configuration.IConfiguration))
            as Microsoft.Extensions.Configuration.IConfiguration
            ?? throw new InvalidOperationException("Configuration not found");

        var connectionString = configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not found");

        var productService = new ProductService(connectionString);
        var products = await productService.GetProductsForImageGenerationAsync();

        logger.LogInformation("Found {count} products needing images", products.Count);
        return products;
    }

    [Function(nameof(GenerateProductImagesActivity))]
    public async Task<List<ProductPhotoData>> GenerateProductImagesActivity(
        [ActivityTrigger] List<ProductImageData> products,
        FunctionContext executionContext)
    {
        var logger = executionContext.GetLogger(nameof(GenerateProductImagesActivity));
        logger.LogInformation("Generating images for {count} products", products.Count);

        var configuration = executionContext.InstanceServices
            .GetService(typeof(Microsoft.Extensions.Configuration.IConfiguration))
            as Microsoft.Extensions.Configuration.IConfiguration
            ?? throw new InvalidOperationException("Configuration not found");

        var endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not found");

        var aiLogger = executionContext.GetLogger<AIService>();
        var aiService = new AIService(endpoint, aiLogger);

        var photos = await aiService.GenerateProductImagesAsync(products);

        logger.LogInformation("Generated {count} images", photos.Count);
        return photos;
    }

    [Function(nameof(SaveProductImagesActivity))]
    public async Task SaveProductImagesActivity(
        [ActivityTrigger] List<ProductPhotoData> photos,
        FunctionContext executionContext)
    {
        var logger = executionContext.GetLogger(nameof(SaveProductImagesActivity));
        logger.LogInformation("Saving {count} images to database", photos.Count);

        var configuration = executionContext.InstanceServices
            .GetService(typeof(Microsoft.Extensions.Configuration.IConfiguration))
            as Microsoft.Extensions.Configuration.IConfiguration
            ?? throw new InvalidOperationException("Configuration not found");

        var connectionString = configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not found");

        var productService = new ProductService(connectionString);

        foreach (var photo in photos)
        {
            await productService.SaveProductPhotoAsync(photo);
            logger.LogInformation(
                "Saved image for ProductID {productId}: {fileName} ({size} bytes)",
                photo.ProductID,
                photo.FileName,
                photo.ImageData.Length
            );
        }

        logger.LogInformation("Successfully saved {count} images", photos.Count);
    }
}
