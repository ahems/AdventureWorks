using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

public class GenerateProductReviewsUsingAI
{
    private readonly ILogger<GenerateProductReviewsUsingAI> _logger;
    private readonly ILoggerFactory _loggerFactory;

    public GenerateProductReviewsUsingAI(ILogger<GenerateProductReviewsUsingAI> logger, ILoggerFactory loggerFactory)
    {
        _logger = logger;
        _loggerFactory = loggerFactory;
    }

    [Function(nameof(GenerateProductReviewsUsingAI_HttpStart))]
    public async Task<HttpResponseData> GenerateProductReviewsUsingAI_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        _logger.LogInformation("Starting product review generation orchestration");

        var instanceId = await client.ScheduleNewOrchestrationInstanceAsync(
            nameof(GenerateProductReviewsUsingAI_Orchestrator));

        _logger.LogInformation("Started review generation orchestration with ID = '{instanceId}'", instanceId);

        return client.CreateCheckStatusResponse(req, instanceId);
    }

    [Function(nameof(GenerateProductReviewsUsingAI_Orchestrator))]
    public async Task<string> GenerateProductReviewsUsingAI_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<GenerateProductReviewsUsingAI>();

        logger.LogInformation("Review generation orchestration started for all products");

        try
        {
            // Step 1: Fetch all finished goods products
            logger.LogInformation("Fetching products from database");
            var products = await context.CallActivityAsync<List<ProductForReviewGeneration>>(
                nameof(FetchProductsForReviewsActivity));

            logger.LogInformation("Fetched {count} products", products.Count);

            if (products.Count == 0)
            {
                return "No finished goods products found to generate reviews";
            }

            // Step 2 & 3: Generate and save reviews in batches
            logger.LogInformation("Generating and saving reviews in batches of 5 products");
            int totalReviewsGenerated = 0;
            int productsProcessed = 0;

            // Process in smaller batches of 5 products (since we're generating multiple reviews per product)
            for (int i = 0; i < products.Count; i += 5)
            {
                var batch = products.Skip(i).Take(5).ToList();
                logger.LogInformation("Processing batch {batch} ({count} products)", (i / 5) + 1, batch.Count);

                // Generate reviews for this batch
                var generatedReviews = await context.CallActivityAsync<List<GeneratedReview>>(
                    nameof(GenerateReviewsWithAIActivity),
                    batch);

                logger.LogInformation("Generated {count} reviews in batch", generatedReviews.Count);

                // Save this batch immediately
                if (generatedReviews.Count > 0)
                {
                    await context.CallActivityAsync(
                        nameof(SaveReviewsActivity),
                        generatedReviews);

                    logger.LogInformation("Saved {count} reviews to database", generatedReviews.Count);
                }

                totalReviewsGenerated += generatedReviews.Count;
                productsProcessed += batch.Count;
            }

            logger.LogInformation("Orchestration completed successfully");
            return $"Successfully generated and saved {totalReviewsGenerated} reviews across {productsProcessed} products";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error during review generation orchestration");
            throw;
        }
    }

    [Function(nameof(FetchProductsForReviewsActivity))]
    public async Task<List<ProductForReviewGeneration>> FetchProductsForReviewsActivity(
        [ActivityTrigger] FunctionContext context)
    {
        _logger.LogInformation("Fetching products from database");

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var reviewService = new ReviewService(connectionString);
        var products = await reviewService.GetProductsForReviewGenerationAsync();

        _logger.LogInformation("Fetched {count} products", products.Count);
        return products;
    }

    [Function(nameof(GenerateReviewsWithAIActivity))]
    public async Task<List<GeneratedReview>> GenerateReviewsWithAIActivity(
        [ActivityTrigger] List<ProductForReviewGeneration> products)
    {
        _logger.LogInformation("Generating reviews for {count} products with AI", products.Count);

        var endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");

        var aiServiceLogger = _loggerFactory.CreateLogger<AIService>();
        var aiService = new AIService(endpoint, aiServiceLogger);
        var generatedReviews = await aiService.GenerateProductReviewsAsync(products);

        _logger.LogInformation("AI generated {count} total reviews", generatedReviews.Count);
        return generatedReviews;
    }

    [Function(nameof(SaveReviewsActivity))]
    public async Task SaveReviewsActivity(
        [ActivityTrigger] List<GeneratedReview> reviews)
    {
        _logger.LogInformation("Saving {count} reviews to database", reviews.Count);

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var reviewService = new ReviewService(connectionString);

        foreach (var review in reviews)
        {
            await reviewService.SaveGeneratedReviewAsync(review);
        }

        _logger.LogInformation("Saved {count} reviews to database", reviews.Count);
    }
}
