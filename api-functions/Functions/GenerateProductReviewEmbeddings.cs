using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using api_functions.Models;

namespace api_functions.Functions;

public class GenerateProductReviewEmbeddings
{
    private readonly ILogger<GenerateProductReviewEmbeddings> _logger;
    private readonly ReviewService _reviewService;
    private readonly AIService _aiService;

    public GenerateProductReviewEmbeddings(
        ILogger<GenerateProductReviewEmbeddings> logger,
        ReviewService reviewService,
        AIService aiService)
    {
        _logger = logger;
        _reviewService = reviewService;
        _aiService = aiService;
    }

    [Function("GenerateProductReviewEmbeddings_HttpStart")]
    public async Task<HttpResponseData> HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        var instanceId = await client.ScheduleNewOrchestrationInstanceAsync(
            nameof(GenerateProductReviewEmbeddings_Orchestrator));

        _logger.LogInformation("Started review embeddings orchestration with ID = '{instanceId}'", instanceId);

        return await client.CreateCheckStatusResponseAsync(req, instanceId);
    }

    [Function(nameof(GenerateProductReviewEmbeddings_Orchestrator))]
    public async Task<string> GenerateProductReviewEmbeddings_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<GenerateProductReviewEmbeddings>();

        try
        {
            // Step 1: Fetch all product reviews that need embeddings
            logger.LogInformation("Fetching product reviews for embedding generation");
            var reviews = await context.CallActivityAsync<List<ProductReviewData>>(
                nameof(FetchProductReviewsActivity));

            if (reviews.Count == 0)
            {
                return "No product reviews found to generate embeddings";
            }

            logger.LogInformation("Found {count} product reviews to process", reviews.Count);

            // Step 2 & 3: Generate embeddings and save each batch of 10
            logger.LogInformation("Generating embeddings in batches of 10");
            int totalProcessed = 0;

            // Process in batches of 10
            for (int i = 0; i < reviews.Count; i += 10)
            {
                var batch = reviews.Skip(i).Take(10).ToList();
                logger.LogInformation("Processing batch {batch} ({count} reviews)", (i / 10) + 1, batch.Count);

                // Generate embeddings for this batch
                var embeddedBatch = await context.CallActivityAsync<List<ProductReviewEmbedding>>(
                    nameof(GenerateReviewEmbeddingsActivity),
                    batch);

                logger.LogInformation("Generated {count} embeddings in batch", embeddedBatch.Count);

                // Save this batch immediately
                await context.CallActivityAsync(
                    nameof(SaveReviewEmbeddingsActivity),
                    embeddedBatch);

                logger.LogInformation("Saved {count} embeddings to database", embeddedBatch.Count);

                totalProcessed += embeddedBatch.Count;
            }

            logger.LogInformation("Orchestration completed successfully");
            return $"Successfully generated and saved {totalProcessed} product review embeddings";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error during orchestration");
            throw;
        }
    }

    [Function(nameof(FetchProductReviewsActivity))]
    public async Task<List<ProductReviewData>> FetchProductReviewsActivity(
        [ActivityTrigger] FunctionContext context)
    {
        _logger.LogInformation("Fetching product reviews from database");
        var reviews = await _reviewService.GetProductReviewsForEmbeddingAsync();
        _logger.LogInformation("Fetched {count} product reviews", reviews.Count);
        return reviews;
    }

    [Function(nameof(GenerateReviewEmbeddingsActivity))]
    public async Task<List<ProductReviewEmbedding>> GenerateReviewEmbeddingsActivity(
        [ActivityTrigger] List<ProductReviewData> reviews,
        FunctionContext context)
    {
        _logger.LogInformation("Generating embeddings for {count} reviews using AI", reviews.Count);
        var embeddings = await _aiService.GenerateReviewEmbeddingsAsync(reviews);
        _logger.LogInformation("Generated {count} embeddings", embeddings.Count);
        return embeddings;
    }

    [Function(nameof(SaveReviewEmbeddingsActivity))]
    public async Task SaveReviewEmbeddingsActivity(
        [ActivityTrigger] List<ProductReviewEmbedding> embeddings,
        FunctionContext context)
    {
        _logger.LogInformation("Saving {count} embeddings to database", embeddings.Count);

        foreach (var embedding in embeddings)
        {
            await _reviewService.SaveEmbeddingAsync(embedding);
        }

        _logger.LogInformation("Successfully saved {count} embeddings", embeddings.Count);
    }
}
