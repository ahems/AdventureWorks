using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using api_functions.Models;
using System.Net;

namespace api_functions.Functions;

/// <summary>
/// Generates vector embeddings for Production.ProductName rows where ProductNameEmbedding IS NULL.
/// Triggered via HTTP POST or called by other orchestrator functions after adding new name translations.
/// Processes all cultures in batches of 20 to respect Azure OpenAI rate limits.
/// </summary>
public class GenerateProductNameEmbeddings
{
    private readonly ILogger<GenerateProductNameEmbeddings> _logger;
    private readonly ProductService _productService;
    private readonly AIService _aiService;

    public GenerateProductNameEmbeddings(
        ILogger<GenerateProductNameEmbeddings> logger,
        ProductService productService,
        AIService aiService)
    {
        _logger = logger;
        _productService = productService;
        _aiService = aiService;
    }

    [Function("GenerateProductNameEmbeddings_HttpStart")]
    public async Task<HttpResponseData> HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "GenerateProductNameEmbeddings")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        _logger.LogInformation("GenerateProductNameEmbeddings: starting orchestration");

        try
        {
            var instanceId = await client.ScheduleNewOrchestrationInstanceAsync(
                nameof(GenerateProductNameEmbeddings_Orchestrator));

            _logger.LogInformation("Started orchestration with ID = '{instanceId}'", instanceId);

            var response = req.CreateResponse(HttpStatusCode.Accepted);
            await response.WriteAsJsonAsync(new
            {
                id = instanceId,
                message = "Product name embeddings generation started. All ProductName rows with NULL embeddings will be processed."
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error starting product name embeddings orchestration");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }

    [Function(nameof(GenerateProductNameEmbeddings_Orchestrator))]
    public async Task<string> GenerateProductNameEmbeddings_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<GenerateProductNameEmbeddings>();

        try
        {
            logger.LogInformation("Fetching ProductName rows without embeddings");
            var names = await context.CallActivityAsync<List<ProductNameEmbeddingData>>(
                nameof(FetchProductNamesActivity));

            if (names.Count == 0)
            {
                return "No ProductName rows found with NULL embeddings — nothing to do.";
            }

            logger.LogInformation("Found {count} ProductName rows to embed", names.Count);

            int totalProcessed = 0;
            const int batchSize = 20;

            for (int i = 0; i < names.Count; i += batchSize)
            {
                var batch = names.Skip(i).Take(batchSize).ToList();
                logger.LogInformation("Processing batch {batch} ({count} names)", (i / batchSize) + 1, batch.Count);

                var embeddedBatch = await context.CallActivityAsync<List<ProductNameEmbedding>>(
                    nameof(GenerateNameEmbeddingsActivity), batch);

                await context.CallActivityAsync(
                    nameof(SaveNameEmbeddingsActivity), embeddedBatch);

                totalProcessed += embeddedBatch.Count;
                logger.LogInformation("Saved {count} name embeddings (total so far: {total})", embeddedBatch.Count, totalProcessed);
            }

            return $"Successfully generated and saved {totalProcessed} product name embeddings.";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error during product name embeddings orchestration");
            throw;
        }
    }

    [Function(nameof(FetchProductNamesActivity))]
    public async Task<List<ProductNameEmbeddingData>> FetchProductNamesActivity(
        [ActivityTrigger] FunctionContext context)
    {
        _logger.LogInformation("Fetching ProductName rows with NULL embeddings from database");
        var names = await _productService.GetProductNamesForEmbeddingAsync();
        _logger.LogInformation("Fetched {count} rows", names.Count);
        return names;
    }

    [Function(nameof(GenerateNameEmbeddingsActivity))]
    public async Task<List<ProductNameEmbedding>> GenerateNameEmbeddingsActivity(
        [ActivityTrigger] List<ProductNameEmbeddingData> names,
        FunctionContext context)
    {
        _logger.LogInformation("Generating embeddings for {count} product names", names.Count);
        var embeddings = await _aiService.GenerateProductNameEmbeddingsAsync(names);
        _logger.LogInformation("Generated {count} embeddings", embeddings.Count);
        return embeddings;
    }

    [Function(nameof(SaveNameEmbeddingsActivity))]
    public async Task SaveNameEmbeddingsActivity(
        [ActivityTrigger] List<ProductNameEmbedding> embeddings,
        FunctionContext context)
    {
        _logger.LogInformation("Saving {count} product name embeddings to database", embeddings.Count);
        foreach (var embedding in embeddings)
        {
            await _productService.SaveProductNameEmbeddingAsync(embedding);
        }
        _logger.LogInformation("Saved {count} product name embeddings", embeddings.Count);
    }
}
