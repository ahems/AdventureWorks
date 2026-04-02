using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.ApplicationInsights;
using System.Text.Json;
using api_functions.Models;
using api_functions.Services;
using Azure.Storage.Queues;
using Azure.Identity;
using System.Net;

namespace api_functions.Functions;

public class TranslateProductDescriptions
{
    private readonly ILogger<TranslateProductDescriptions> _logger;
    private readonly ILoggerFactory _loggerFactory;
    private readonly IServiceProvider _serviceProvider;
    private const string AI_JOB_QUEUE = "ai-job-chat-queue";

    public TranslateProductDescriptions(ILogger<TranslateProductDescriptions> logger, ILoggerFactory loggerFactory, IServiceProvider serviceProvider)
    {
        _logger = logger;
        _loggerFactory = loggerFactory;
        _serviceProvider = serviceProvider;
    }

    [Function(nameof(TranslateProductDescriptions_HttpStart))]
    public async Task<HttpResponseData> TranslateProductDescriptions_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        _logger.LogInformation("Translation request: enqueuing translation jobs onto ai-job-chat-queue");

        // Read optional product model IDs from request body
        List<int>? productModelIds = null;
        try
        {
            var bodyText = await req.ReadAsStringAsync();
            if (!string.IsNullOrWhiteSpace(bodyText))
            {
                var bodyElement = JsonSerializer.Deserialize<JsonElement>(bodyText);
                if (bodyElement.ValueKind == JsonValueKind.Array)
                    productModelIds = bodyElement.Deserialize<List<int>>();
                else if (bodyElement.ValueKind == JsonValueKind.Object &&
                         bodyElement.TryGetProperty("ProductModelIds", out var prop))
                    productModelIds = prop.Deserialize<List<int>>();
            }
        }
        catch
        {
            _logger.LogInformation("No product model IDs provided — will use recently enhanced products");
        }

        try
        {
            // Resolve which product models to translate
            var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
                ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");
            var productService = new ProductService(connectionString);

            var products = productModelIds?.Count > 0
                ? await productService.GetProductsByModelIdsAsync(productModelIds)
                : await productService.GetRecentlyEnhancedProductsAsync();

            if (products == null || products.Count == 0)
            {
                var emptyResponse = req.CreateResponse(HttpStatusCode.OK);
                await emptyResponse.WriteAsJsonAsync(new QueuedJobResponseDto
                {
                    Id = Guid.NewGuid().ToString(),
                    Message = "No products found for translation"
                });
                return emptyResponse;
            }

            // Build queue client
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
                new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });

            var aiJobQueueClient = queueServiceClient.GetQueueClient(AI_JOB_QUEUE);
            await aiJobQueueClient.CreateIfNotExistsAsync();

            // Enqueue one translation job per product model
            int enqueued = 0;
            foreach (var product in products)
            {
                var message = JsonSerializer.Serialize(new AiJobMessage
                {
                    JobType = "translation",
                    ProductModelId = product.ProductModelID,
                    // Pass ProductID so name translation is also performed
                    ProductId = product.ProductID > 0 ? product.ProductID : null
                });
                await aiJobQueueClient.SendMessageAsync(message);
                enqueued++;
            }

            _logger.LogInformation("Enqueued {count} translation jobs onto {queue}", enqueued, AI_JOB_QUEUE);

            var jobId = Guid.NewGuid().ToString();
            var successResponse = req.CreateResponse(HttpStatusCode.Accepted);
            // Return the same shape the admin UI expects for a queued (non-Durable) job
            await successResponse.WriteAsJsonAsync(new QueuedJobResponseDto
            {
                Id = jobId,
                Message = $"Enqueued {enqueued} translation jobs. They will be processed serially."
            });
            return successResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error enqueueing translation jobs");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }

    // ── DTO returned to admin UI ─────────────────────────────────────────────
    private class QueuedJobResponseDto
    {
        public string Id { get; set; } = string.Empty;
        public string? Message { get; set; }
        // statusQueryGetUri intentionally omitted → frontend treats as queued/done
    }

    // ────────────────────────────────────────────────────────────────────────
    // Durable Activity functions are kept below so that any in-flight
    // orchestrations started before this deployment can still complete.
    // They are no longer invoked by new requests.
    // ────────────────────────────────────────────────────────────────────────

    [Function(nameof(TranslateProductDescriptions_Orchestrator))]
    public async Task<string> TranslateProductDescriptions_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<TranslateProductDescriptions>();

        try
        {
            // Step 1: Fetch products to translate
            // If productModelIds are provided as input, fetch those specific products
            // Otherwise, fetch recently enhanced products
            var productModelIds = context.GetInput<List<int>?>();

            logger.LogInformation(productModelIds != null && productModelIds.Count > 0
                ? $"Fetching {productModelIds.Count} specific products for translation"
                : "Fetching recently enhanced products");

            var recentProducts = await context.CallActivityAsync<List<TranslationRequest>>(
                nameof(FetchRecentlyEnhancedProductsActivity),
                productModelIds);

            if (recentProducts == null || recentProducts.Count == 0)
            {
                return productModelIds != null && productModelIds.Count > 0
                    ? $"No products found for ProductModelIds: {string.Join(", ", productModelIds)}"
                    : "No recently enhanced products found for translation";
            }

            logger.LogInformation("Found {count} products to translate", recentProducts.Count);

            // Step 2: Get supported cultures (all except English)
            logger.LogInformation("Fetching supported cultures");
            var cultures = await context.CallActivityAsync<List<CultureInfo>>(
                nameof(GetSupportedCulturesActivity));

            logger.LogInformation("Found {count} target languages", cultures.Count);

            // Step 3: Translate, save, and collect saved description IDs for each product
            int totalTranslations = 0;
            var allSavedDescriptions = new List<SavedDescriptionResult>();

            // Also include the English descriptions so they get embeddings too
            foreach (var product in recentProducts)
            {
                if (product.EnglishDescriptionID > 0 && !string.IsNullOrWhiteSpace(product.EnglishDescription))
                {
                    allSavedDescriptions.Add(new SavedDescriptionResult
                    {
                        ProductDescriptionID = product.EnglishDescriptionID,
                        Description = product.EnglishDescription,
                        CultureID = "en",
                        ProductModelID = product.ProductModelID,
                    });
                }
            }

            foreach (var product in recentProducts)
            {
                logger.LogInformation("Translating product {ProductModelID}", product.ProductModelID);

                var translations = await context.CallActivityAsync<List<TranslatedDescription>>(
                    nameof(TranslateSingleProductActivity),
                    new TranslationActivityInput
                    {
                        Products = new List<TranslationRequest> { product },
                        Cultures = cultures
                    });

                logger.LogInformation("Generated {count} translations for product {ProductModelID}",
                    translations.Count, product.ProductModelID);

                if (translations.Count > 0)
                {
                    logger.LogInformation("Saving {count} translations for product {ProductModelID}",
                        translations.Count, product.ProductModelID);

                    var saved = await context.CallActivityAsync<List<SavedDescriptionResult>>(
                        nameof(SaveTranslationsActivity),
                        translations);

                    allSavedDescriptions.AddRange(saved);
                    totalTranslations += translations.Count;
                }
            }

            // Step 4: Generate and save embeddings for all descriptions (English + translations)
            // Passed in-memory from the save step — no extra DB round-trip needed.
            if (allSavedDescriptions.Count > 0)
            {
                logger.LogInformation("Generating embeddings for {count} descriptions", allSavedDescriptions.Count);

                var forEmbedding = allSavedDescriptions
                    .Select(r => new ProductDescriptionData
                    {
                        ProductDescriptionID = r.ProductDescriptionID,
                        Description = r.Description,
                        CultureID = r.CultureID,
                        ProductModelID = r.ProductModelID,
                    })
                    .ToList();

                int embeddingsProcessed = 0;
                for (int i = 0; i < forEmbedding.Count; i += 10)
                {
                    var batch = forEmbedding.Skip(i).Take(10).ToList();

                    var embeddedBatch = await context.CallActivityAsync<List<ProductDescriptionEmbedding>>(
                        "GenerateEmbeddingsActivity", batch);

                    await context.CallActivityAsync(
                        "SaveEmbeddingsActivity", embeddedBatch);

                    embeddingsProcessed += embeddedBatch.Count;
                }

                logger.LogInformation("Generated and saved {count} embeddings", embeddingsProcessed);
            }

            return $"Successfully translated {recentProducts.Count} products into {cultures.Count} languages ({totalTranslations} total translations), with embeddings generated";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Translation orchestration failed");
            throw;
        }
    }

    [Function(nameof(FetchRecentlyEnhancedProductsActivity))]
    public async Task<List<TranslationRequest>> FetchRecentlyEnhancedProductsActivity(
        [ActivityTrigger] List<int>? productModelIds)
    {
        _logger.LogInformation(productModelIds != null && productModelIds.Count > 0
            ? $"Fetching specific products: {string.Join(", ", productModelIds)}"
            : "Fetching recently enhanced products from database");

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var productService = new ProductService(connectionString);
        var products = productModelIds != null && productModelIds.Count > 0
            ? await productService.GetProductsByModelIdsAsync(productModelIds)
            : await productService.GetRecentlyEnhancedProductsAsync();

        _logger.LogInformation("Fetched {count} recently enhanced products", products.Count);
        return products;
    }

    [Function(nameof(GetSupportedCulturesActivity))]
    public async Task<List<CultureInfo>> GetSupportedCulturesActivity(
        [ActivityTrigger] FunctionContext context)
    {
        _logger.LogInformation("Fetching supported cultures from database");

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var productService = new ProductService(connectionString);
        var cultures = await productService.GetSupportedCulturesAsync();

        _logger.LogInformation("Found {count} supported cultures", cultures.Count);
        return cultures;
    }

    [Function(nameof(TranslateSingleProductActivity))]
    public async Task<List<TranslatedDescription>> TranslateSingleProductActivity(
        [ActivityTrigger] TranslationActivityInput input)
    {
        if (input == null || input.Products == null || input.Products.Count == 0)
        {
            _logger.LogWarning("No product provided for translation");
            return new List<TranslatedDescription>();
        }

        var product = input.Products[0];
        _logger.LogInformation("Translating product {ProductModelID} ({ProductName}) to {cultureCount} languages",
            product.ProductModelID, product.ProductName, input.Cultures.Count);

        var endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");

        var aiServiceLogger = _loggerFactory.CreateLogger<AIService>();
        var telemetryClient = _serviceProvider.GetRequiredService<TelemetryClient>();
        var aiService = new AIService(endpoint, aiServiceLogger, telemetryClient);

        // Translate description
        var translations = await aiService.TranslateProductAsync(product, input.Cultures);

        _logger.LogInformation("AI translated product {ProductModelID} to {count} languages",
            product.ProductModelID, translations.Count);

        // Also translate product name if ProductID is specified
        if (product.ProductID > 0 && !string.IsNullOrWhiteSpace(product.ProductName))
        {
            try
            {
                var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
                    ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");
                var productService = new ProductService(connectionString);

                var allCultures = await productService.GetAllCulturesAsync();
                var nonEnglish = allCultures.Where(c => !c.CultureID.TrimEnd().Equals("en", StringComparison.OrdinalIgnoreCase) && !c.CultureID.TrimEnd().StartsWith("en-", StringComparison.OrdinalIgnoreCase)).ToList();
                var enVariants = allCultures.Where(c => c.CultureID.TrimEnd().StartsWith("en-", StringComparison.OrdinalIgnoreCase)).ToList();

                var nameTranslations = await aiService.TranslateTextAsync(
                    product.ProductName,
                    "Product name for an outdoor adventure sports equipment catalog",
                    nonEnglish);

                var productIds = await productService.GetProductIdsByModelIdAsync(product.ProductModelID);
                // Use the specified ProductID or fall back to first in model
                var targetProductId = product.ProductID > 0 ? product.ProductID : (productIds.Count > 0 ? productIds[0] : 0);

                if (targetProductId > 0)
                {
                    var namesToSave = new List<TranslatedProductName>();

                    foreach (var t in nameTranslations)
                    {
                        if (!string.IsNullOrWhiteSpace(t.TranslatedText))
                            namesToSave.Add(new TranslatedProductName { ProductID = targetProductId, CultureID = t.CultureID, Name = t.TranslatedText[..Math.Min(t.TranslatedText.Length, 50)] });
                    }
                    foreach (var c in enVariants)
                    {
                        namesToSave.Add(new TranslatedProductName { ProductID = targetProductId, CultureID = c.CultureID, Name = product.ProductName[..Math.Min(product.ProductName.Length, 50)] });
                    }

                    if (namesToSave.Count > 0)
                        await productService.SaveProductNamesAsync(namesToSave);

                    _logger.LogInformation("Saved {count} product name translations for ProductID {ProductID}", namesToSave.Count, targetProductId);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Product name translation failed for ProductModelID {ModelID} — continuing", product.ProductModelID);
            }
        }

        return translations;
    }

    [Function(nameof(TranslateDescriptionsActivity))]
    public async Task<List<TranslatedDescription>> TranslateDescriptionsActivity(
        [ActivityTrigger] TranslationActivityInput input)
    {
        _logger.LogInformation("Translating {productCount} products to {cultureCount} languages",
            input.Products.Count, input.Cultures.Count);

        var endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");

        var aiServiceLogger = _loggerFactory.CreateLogger<AIService>();
        var telemetryClient = _serviceProvider.GetRequiredService<TelemetryClient>();
        var aiService = new AIService(endpoint, aiServiceLogger, telemetryClient);
        var translations = await aiService.TranslateDescriptionsAsync(input.Products, input.Cultures);

        _logger.LogInformation("AI translated {count} descriptions", translations.Count);
        return translations;
    }

    [Function(nameof(SaveTranslationsActivity))]
    public async Task<List<SavedDescriptionResult>> SaveTranslationsActivity(
        [ActivityTrigger] List<TranslatedDescription> translations)
    {
        _logger.LogInformation("Saving {count} translations to database", translations.Count);

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var productService = new ProductService(connectionString);
        var results = await productService.SaveTranslationsAsync(translations);

        _logger.LogInformation("Saved {count} translations", results.Count);
        return results;
    }
}
