using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using api_functions.Models;
using System.Text.Json;

namespace api_functions.Functions;

public class GenerateProductEmbeddings
{
    private readonly ILogger<GenerateProductEmbeddings> _logger;
    private readonly ProductService _productService;
    private readonly AIService _aiService;

    public GenerateProductEmbeddings(
        ILogger<GenerateProductEmbeddings> logger,
        ProductService productService,
        AIService aiService)
    {
        _logger = logger;
        _productService = productService;
        _aiService = aiService;
    }

    [Function("GenerateProductEmbeddings_HttpStart")]
    public async Task<HttpResponseData> HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        var instanceId = await client.ScheduleNewOrchestrationInstanceAsync(
            nameof(GenerateProductEmbeddings_Orchestrator));

        _logger.LogInformation("Started orchestration with ID = '{instanceId}'", instanceId);

        return await client.CreateCheckStatusResponseAsync(req, instanceId);
    }

    [Function(nameof(GenerateProductEmbeddings_Orchestrator))]
    public async Task<string> GenerateProductEmbeddings_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<GenerateProductEmbeddings>();

        try
        {
            // Step 1: Fetch all product descriptions that need embeddings
            logger.LogInformation("Fetching product descriptions for embedding generation");
            var descriptions = await context.CallActivityAsync<List<ProductDescriptionData>>(
                nameof(FetchProductDescriptionsActivity));

            if (descriptions.Count == 0)
            {
                return "No product descriptions found to generate embeddings";
            }

            logger.LogInformation("Found {count} product descriptions to process", descriptions.Count);

            // Step 2 & 3: Generate embeddings and save each batch of 10
            logger.LogInformation("Generating embeddings in batches of 10");
            int totalProcessed = 0;

            // Process in batches of 10
            for (int i = 0; i < descriptions.Count; i += 10)
            {
                var batch = descriptions.Skip(i).Take(10).ToList();
                logger.LogInformation("Processing batch {batch} ({count} descriptions)", (i / 10) + 1, batch.Count);

                // Generate embeddings for this batch
                var embeddedBatch = await context.CallActivityAsync<List<ProductDescriptionEmbedding>>(
                    nameof(GenerateEmbeddingsActivity),
                    batch);

                logger.LogInformation("Generated {count} embeddings in batch", embeddedBatch.Count);

                // Save this batch immediately
                await context.CallActivityAsync(
                    nameof(SaveEmbeddingsActivity),
                    embeddedBatch);

                logger.LogInformation("Saved {count} embeddings to database", embeddedBatch.Count);

                totalProcessed += embeddedBatch.Count;
            }

            logger.LogInformation("Orchestration completed successfully");
            return $"Successfully generated and saved {totalProcessed} product description embeddings";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error during orchestration");
            throw;
        }
    }

    [Function(nameof(FetchProductDescriptionsActivity))]
    public async Task<List<ProductDescriptionData>> FetchProductDescriptionsActivity(
        FunctionContext context)
    {
        _logger.LogInformation("Fetching product descriptions from database");
        var descriptions = await _productService.GetProductDescriptionsForEmbeddingAsync();
        _logger.LogInformation("Fetched {count} product descriptions", descriptions.Count);
        return descriptions;
    }

    [Function(nameof(GenerateEmbeddingsActivity))]
    public async Task<List<ProductDescriptionEmbedding>> GenerateEmbeddingsActivity(
        [ActivityTrigger] List<ProductDescriptionData> descriptions,
        FunctionContext context)
    {
        _logger.LogInformation("Generating embeddings for {count} descriptions using AI", descriptions.Count);
        var embeddings = await _aiService.GenerateEmbeddingsAsync(descriptions);
        _logger.LogInformation("Generated {count} embeddings", embeddings.Count);
        return embeddings;
    }

    [Function(nameof(SaveEmbeddingsActivity))]
    public async Task SaveEmbeddingsActivity(
        [ActivityTrigger] List<ProductDescriptionEmbedding> embeddings,
        FunctionContext context)
    {
        _logger.LogInformation("Saving {count} embeddings to database", embeddings.Count);

        foreach (var embedding in embeddings)
        {
            await _productService.SaveEmbeddingAsync(embedding);
        }

        _logger.LogInformation("Successfully saved {count} embeddings", embeddings.Count);
    }
}
