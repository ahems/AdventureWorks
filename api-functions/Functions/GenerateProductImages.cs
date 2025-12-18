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

            // Process only 1 product per orchestration run to avoid timeouts and memory issues
            const int batchSize = 1;
            var productsToProcess = products.Take(batchSize).ToList();
            var remainingCount = products.Count - batchSize;

            logger.LogInformation(
                "Processing batch of {batchSize} product(s). Remaining: {remaining}",
                productsToProcess.Count,
                Math.Max(0, remainingCount)
            );

            // Step 2: Process products one at a time to avoid activity timeouts
            var totalPhotos = 0;

            for (int i = 0; i < productsToProcess.Count; i++)
            {
                var product = productsToProcess[i];
                logger.LogInformation(
                    "Processing product {current} of {total}: {name} (ID: {id})",
                    i + 1,
                    productsToProcess.Count,
                    product.Name,
                    product.ProductID
                );

                // Generate images for this single product - will throw and halt if error occurs
                var photos = await context.CallActivityAsync<List<ProductPhotoData>>(
                    nameof(GenerateProductImagesActivity),
                    product);

                if (photos != null && photos.Count > 0)
                {
                    logger.LogInformation("Generated {count} images for product {id}", photos.Count, product.ProductID);

                    // Step 3: Save images to database - will throw and halt if error occurs
                    await context.CallActivityAsync(
                        nameof(SaveProductImagesActivity),
                        photos);

                    totalPhotos += photos.Count;
                    logger.LogInformation("Saved {count} images for product {id} (total: {total})",
                        photos.Count, product.ProductID, totalPhotos);
                }
                else
                {
                    // Halt execution if no images were generated
                    var errorMsg = $"Failed to generate images for product {product.ProductID} ({product.Name})";
                    logger.LogError(errorMsg);
                    throw new InvalidOperationException(errorMsg);
                }
            }

            var message = $"Successfully generated {totalPhotos} product images for {productsToProcess.Count} product(s). {Math.Max(0, remainingCount)} products still need images.";
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
        [ActivityTrigger] ProductImageData product,
        FunctionContext executionContext)
    {
        var logger = executionContext.GetLogger(nameof(GenerateProductImagesActivity));
        logger.LogInformation("Generating images for product: {name} (ID: {id})", product.Name, product.ProductID);

        var configuration = executionContext.InstanceServices
            .GetService(typeof(Microsoft.Extensions.Configuration.IConfiguration))
            as Microsoft.Extensions.Configuration.IConfiguration
            ?? throw new InvalidOperationException("Configuration not found");

        var endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not found");

        var aiLogger = executionContext.GetLogger<AIService>();
        var aiService = new AIService(endpoint, aiLogger);

        var photos = await aiService.GenerateProductImagesAsync(new List<ProductImageData> { product });

        logger.LogInformation("Generated {count} images for product {id}", photos.Count, product.ProductID);
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
