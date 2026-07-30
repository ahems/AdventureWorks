using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using api_functions.Models;
using api_functions.Services;
using Azure.Storage.Queues;
using Azure.Identity;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

/// <summary>
/// Queue-trigger processors for all AI-generating background work.
///
/// Jobs are routed to three model-specific queues so operations against independent
/// Azure OpenAI deployments run concurrently while operations that share a deployment
/// are serialised (batchSize=1 / newBatchThreshold=0 in host.json):
///
///   ai-job-image-queue      – DALL-E / image generation
///   ai-job-embeddings-queue – text-embedding model
///   ai-job-chat-queue       – GPT chat model (translations, reviews)
/// </summary>
public class AIJobProcessorFunction
{
    // ── Queue names ─────────────────────────────────────────────────────────
    internal const string IMAGE_QUEUE      = "ai-job-image-queue";
    internal const string EMBEDDINGS_QUEUE = "ai-job-embeddings-queue";
    internal const string CHAT_QUEUE       = "ai-job-chat-queue";
    private  const string THUMBNAIL_QUEUE  = "product-thumbnail-generation";

    private readonly ILogger<AIJobProcessorFunction> _logger;
    private readonly ILoggerFactory _loggerFactory;
    private readonly IServiceProvider _serviceProvider;
    private readonly ProductService _productService;
    private readonly ReviewService _reviewService;
    private readonly AIService _aiService;
    private readonly TranslationAgentService _translationAgentService;
    private readonly ReviewBatchAgentService _reviewBatchAgentService;
    private readonly OrderGenerationAgentService _orderGenAgentService;

    public AIJobProcessorFunction(
        ILogger<AIJobProcessorFunction> logger,
        ILoggerFactory loggerFactory,
        IServiceProvider serviceProvider,
        ProductService productService,
        ReviewService reviewService,
        AIService aiService,
        TranslationAgentService translationAgentService,
        ReviewBatchAgentService reviewBatchAgentService,
        OrderGenerationAgentService orderGenAgentService)
    {
        _logger = logger;
        _loggerFactory = loggerFactory;
        _serviceProvider = serviceProvider;
        _productService = productService;
        _reviewService = reviewService;
        _aiService = aiService;
        _translationAgentService = translationAgentService;
        _reviewBatchAgentService = reviewBatchAgentService;
        _orderGenAgentService = orderGenAgentService;
    }

    // ── Queue triggers (one per AI model) ────────────────────────────────────

    /// <summary>Processes image-generation jobs. Serialised against the DALL-E model.</summary>
    [Function(nameof(AIJobProcessor_Image_QueueTrigger))]
    public async Task AIJobProcessor_Image_QueueTrigger(
        [QueueTrigger(IMAGE_QUEUE, Connection = "AzureWebJobsStorage")] BinaryData queueMessage,
        FunctionContext executionContext)
    {
        var msg = DeserialiseOrDrop(queueMessage);
        if (msg == null) return;
        _logger.LogInformation("[image-queue] Processing JobType={jobType}", msg.JobType);
        if (msg.JobType.Equals("image", StringComparison.OrdinalIgnoreCase))
            await ProcessImageJobAsync(msg);
        else
            _logger.LogWarning("[image-queue] Unexpected JobType '{jobType}' — skipping", msg.JobType);
    }

    /// <summary>Processes embedding jobs. Serialised against the embeddings model.</summary>
    [Function(nameof(AIJobProcessor_Embeddings_QueueTrigger))]
    public async Task AIJobProcessor_Embeddings_QueueTrigger(
        [QueueTrigger(EMBEDDINGS_QUEUE, Connection = "AzureWebJobsStorage")] BinaryData queueMessage,
        FunctionContext executionContext)
    {
        var msg = DeserialiseOrDrop(queueMessage);
        if (msg == null) return;
        _logger.LogInformation("[embeddings-queue] Processing JobType={jobType}", msg.JobType);
        switch (msg.JobType.ToLowerInvariant())
        {
            case "product-embeddings": await ProcessProductEmbeddingsJobAsync(); break;
            case "review-embeddings":  await ProcessReviewEmbeddingsJobAsync();  break;
            default: _logger.LogWarning("[embeddings-queue] Unexpected JobType '{jobType}' — skipping", msg.JobType); break;
        }
    }

    /// <summary>Processes chat-model jobs (translations, reviews). Serialised against the GPT model.</summary>
    [Function(nameof(AIJobProcessor_Chat_QueueTrigger))]
    public async Task AIJobProcessor_Chat_QueueTrigger(
        [QueueTrigger(CHAT_QUEUE, Connection = "AzureWebJobsStorage")] BinaryData queueMessage,
        FunctionContext executionContext)
    {
        var msg = DeserialiseOrDrop(queueMessage);
        if (msg == null) return;
        _logger.LogInformation("[chat-queue] Processing JobType={jobType}", msg.JobType);
        switch (msg.JobType.ToLowerInvariant())
        {
            case "translation":     await ProcessTranslationJobAsync(msg);   break;
            case "review":          await ProcessReviewJobAsync(msg);         break;
            case "generate-order":  await ProcessGenerateOrderJobAsync(msg);  break;
            default: _logger.LogWarning("[chat-queue] Unexpected JobType '{jobType}' — skipping", msg.JobType); break;
        }
    }

    // ── Status endpoint ───────────────────────────────────────────────────────

    /// <summary>Returns the approximate number of pending jobs across all three AI model queues.</summary>
    [Function("AIJobQueue_Status")]
    public async Task<HttpResponseData> AIJobQueue_Status(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "ai-job-queue/status")] HttpRequestData req)
    {
        try
        {
            var imageClient      = await GetQueueClientAsync(IMAGE_QUEUE);
            var embeddingsClient = await GetQueueClientAsync(EMBEDDINGS_QUEUE);
            var chatClient       = await GetQueueClientAsync(CHAT_QUEUE);

            var imageCount      = (await imageClient.GetPropertiesAsync()).Value.ApproximateMessagesCount;
            var embeddingsCount = (await embeddingsClient.GetPropertiesAsync()).Value.ApproximateMessagesCount;
            var chatCount       = (await chatClient.GetPropertiesAsync()).Value.ApproximateMessagesCount;

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new
            {
                pendingJobs        = imageCount + embeddingsCount + chatCount,
                pendingImageJobs   = imageCount,
                pendingChatJobs    = chatCount,
                pendingEmbeddings  = embeddingsCount
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch AI job queue status");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteStringAsync($"Error: {ex.Message}");
            return err;
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Job handlers
    // ────────────────────────────────────────────────────────────────────────

    private async Task ProcessImageJobAsync(AiJobMessage msg)
    {
        if (msg.ProductId == null)
        {
            _logger.LogWarning("Image job missing ProductId — skipping");
            return;
        }

        var productId = msg.ProductId.Value;
        _logger.LogInformation("Image job: fetching product {id}", productId);

        var product = await _productService.GetProductForImageGenerationAsync(productId);
        if (product == null)
        {
            _logger.LogInformation("Image job: product {id} not found or already has enough photos — skipping", productId);
            return;
        }

        // Smart reuse: link photos from a sibling variant instead of calling AI
        if (product.ProductModelID.HasValue)
        {
            var siblingPhotoIds = await _productService.GetSiblingPhotoIdsAsync(
                product.ProductID,
                product.ProductModelID.Value,
                product.Color,
                product.Style);

            if (siblingPhotoIds.Count > 0)
            {
                _logger.LogInformation(
                    "Image job: product {id} shares Color={color}/Style={style} with existing variant — linking {count} photos",
                    productId, product.Color ?? "null", product.Style ?? "null", siblingPhotoIds.Count);
                await _productService.LinkPhotosToProductAsync(productId, siblingPhotoIds);
                return;
            }
        }

        _logger.LogInformation("Image job: generating {count} images for product {id}",
            4 - product.ExistingPhotoCount, productId);

        var photos = await _aiService.GenerateProductImagesAsync(new List<ProductImageData> { product });

        if (photos == null || photos.Count == 0)
        {
            _logger.LogWarning("Image job: no photos returned for product {id}", productId);
            return;
        }

        // Persist photos and enqueue thumbnail generation for each
        var thumbnailQueueClient = await GetQueueClientAsync(THUMBNAIL_QUEUE);

        foreach (var photo in photos)
        {
            var photoId = await _productService.SaveProductPhotoAsync(photo);
            _logger.LogInformation("Image job: saved photo {file} as ProductPhotoID {photoId}", photo.FileName, photoId);

            var thumbnailMessage = JsonSerializer.Serialize(new
            {
                ProductPhotoID = photoId,
                LargePhotoFileName = photo.FileName
            });
            await thumbnailQueueClient.SendMessageAsync(thumbnailMessage);
        }

        _logger.LogInformation("Image job: completed for product {id} — {count} photos saved", productId, photos.Count);
    }

    private async Task ProcessTranslationJobAsync(AiJobMessage msg)
    {
        if (msg.ProductModelId == null)
        {
            _logger.LogWarning("Translation job missing ProductModelId — skipping");
            return;
        }

        var productModelId = msg.ProductModelId.Value;
        _logger.LogInformation("Translation job: translating ProductModelID {id}", productModelId);

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");
        var productService = new ProductService(connectionString);

        // Fetch the product to translate
        var products = await productService.GetProductsByModelIdsAsync(new List<int> { productModelId });
        if (products == null || products.Count == 0)
        {
            _logger.LogWarning("Translation job: no product found for ProductModelID {id} — skipping", productModelId);
            return;
        }
        var product = products[0];

        // Fetch supported cultures
        var cultures = await productService.GetSupportedCulturesAsync();
        _logger.LogInformation("Translation job: translating ProductModelID {id} to {count} languages",
            productModelId, cultures.Count);

        // Translate descriptions
        var translations = await _translationAgentService.TranslateProductAsync(product, cultures);
        _logger.LogInformation("Translation job: AI translated ProductModelID {id} to {count} languages",
            productModelId, translations.Count);

        // Translate product name(s) if a specific ProductID is available
        if (product.ProductID > 0 && !string.IsNullOrWhiteSpace(product.ProductName))
        {
            try
            {
                var allCultures = await productService.GetAllCulturesAsync();
                var nonEnglish = allCultures
                    .Where(c => !c.CultureID.TrimEnd().Equals("en", StringComparison.OrdinalIgnoreCase)
                             && !c.CultureID.TrimEnd().StartsWith("en-", StringComparison.OrdinalIgnoreCase))
                    .ToList();
                var enVariants = allCultures
                    .Where(c => c.CultureID.TrimEnd().StartsWith("en-", StringComparison.OrdinalIgnoreCase))
                    .ToList();

                var nameTranslations = await _translationAgentService.TranslateTextAsync(
                    product.ProductName,
                    "Product name for an outdoor adventure sports equipment catalog",
                    nonEnglish);

                var namesToSave = new List<TranslatedProductName>();
                foreach (var t in nameTranslations)
                {
                    if (!string.IsNullOrWhiteSpace(t.TranslatedText))
                        namesToSave.Add(new TranslatedProductName
                        {
                            ProductID = product.ProductID,
                            CultureID = t.CultureID,
                            Name = t.TranslatedText[..Math.Min(t.TranslatedText.Length, 50)]
                        });
                }
                foreach (var c in enVariants)
                {
                    namesToSave.Add(new TranslatedProductName
                    {
                        ProductID = product.ProductID,
                        CultureID = c.CultureID,
                        Name = product.ProductName[..Math.Min(product.ProductName.Length, 50)]
                    });
                }

                if (namesToSave.Count > 0)
                    await productService.SaveProductNamesAsync(namesToSave);

                _logger.LogInformation("Translation job: saved {count} name translations for ProductID {pid}",
                    namesToSave.Count, product.ProductID);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Translation job: product name translation failed for ProductModelID {id} — continuing", productModelId);
            }
        }

        // Save description translations
        var savedResults = new List<SavedDescriptionResult>();
        if (translations.Count > 0)
        {
            savedResults = await productService.SaveTranslationsAsync(translations);
            _logger.LogInformation("Translation job: saved {count} description translations", savedResults.Count);
        }

        // Also include English description so its embedding is regenerated
        if (product.EnglishDescriptionID > 0 && !string.IsNullOrWhiteSpace(product.EnglishDescription))
        {
            savedResults.Insert(0, new SavedDescriptionResult
            {
                ProductDescriptionID = product.EnglishDescriptionID,
                Description = product.EnglishDescription,
                CultureID = "en",
                ProductModelID = product.ProductModelID
            });
        }

        // Generate + save embeddings for all saved descriptions
        if (savedResults.Count > 0)
        {
            var forEmbedding = savedResults
                .Select(r => new ProductDescriptionData
                {
                    ProductDescriptionID = r.ProductDescriptionID,
                    Description = r.Description,
                    CultureID = r.CultureID,
                    ProductModelID = r.ProductModelID,
                })
                .ToList();

            for (int i = 0; i < forEmbedding.Count; i += 10)
            {
                var batch = forEmbedding.Skip(i).Take(10).ToList();
                var embeddedBatch = await _aiService.GenerateEmbeddingsAsync(batch);
                foreach (var emb in embeddedBatch)
                    await productService.SaveEmbeddingAsync(emb);
            }

            _logger.LogInformation("Translation job: generated and saved embeddings for {count} descriptions", forEmbedding.Count);
        }

        _logger.LogInformation("Translation job: completed for ProductModelID {id}", productModelId);
    }

    private async Task ProcessReviewJobAsync(AiJobMessage msg)
    {
        if (msg.ProductIds == null || msg.ProductIds.Count == 0)
        {
            _logger.LogWarning("Review job missing ProductIds — skipping");
            return;
        }

        _logger.LogInformation("Review job: generating reviews for {count} products", msg.ProductIds.Count);

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");
        // tableServiceUri not needed here — Table Storage only used for verified-reviews job state
        var reviewService = new ReviewService(connectionString, tableServiceUri: string.Empty);

        var products = await reviewService.GetProductsForReviewGenerationAsync(msg.ProductIds);
        if (products == null || products.Count == 0)
        {
            _logger.LogInformation("Review job: no products found for the requested IDs — skipping");
            return;
        }

        var generatedReviews = await _reviewBatchAgentService.GenerateProductReviewsAsync(products);
        _logger.LogInformation("Review job: AI generated {count} reviews", generatedReviews.Count);

        foreach (var review in generatedReviews)
            await reviewService.SaveGeneratedReviewAsync(review);

        _logger.LogInformation("Review job: saved {count} reviews", generatedReviews.Count);

        // When this was the last review batch on the chat queue, kick off review-embeddings
        // on the embeddings queue. batchSize=1 means no other chat job runs concurrently,
        // so an approximate count of 0 here reliably means all reviews are saved.
        var chatQueueClient = await GetQueueClientAsync(CHAT_QUEUE);
        var chatProps = await chatQueueClient.GetPropertiesAsync();
        if (chatProps.Value.ApproximateMessagesCount == 0)
        {
            _logger.LogInformation("Review job: chat queue is empty — enqueuing review-embeddings job");
            var embeddingsQueueClient = await GetQueueClientAsync(EMBEDDINGS_QUEUE);
            await embeddingsQueueClient.SendMessageAsync(
                JsonSerializer.Serialize(new AiJobMessage { JobType = "review-embeddings" }));
        }
    }

    private async Task ProcessGenerateOrderJobAsync(AiJobMessage msg)
    {
        var personaType = msg.PersonaType ?? "newbie-male";
        _logger.LogInformation("Generate-order job: personaType={PersonaType} seedCustomerId={SeedCustomerId}",
            personaType, msg.SeedCustomerId?.ToString() ?? "random");

        try
        {
            var result = await _orderGenAgentService.GenerateOrderAsync(
                personaType,
                customPersona: null,
                seedCustomerId: msg.SeedCustomerId);

            if (result.Success)
            {
                _logger.LogInformation("Generate-order job: created SalesOrderID={OrderId} for {Customer}",
                    result.SalesOrderId, result.CustomerName);
            }
            else
            {
                _logger.LogWarning("Generate-order job: failed — {Error}", result.ErrorMessage);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Generate-order job: unhandled exception for personaType={PersonaType}", personaType);
        }
    }

    private async Task ProcessProductEmbeddingsJobAsync()
    {
        _logger.LogInformation("Product-embeddings job: fetching descriptions");
        var descriptions = await _productService.GetProductDescriptionsForEmbeddingAsync();

        if (descriptions.Count == 0)
        {
            _logger.LogInformation("Product-embeddings job: nothing to embed");
            return;
        }

        _logger.LogInformation("Product-embeddings job: embedding {count} descriptions in batches of 10", descriptions.Count);
        int total = 0;

        for (int i = 0; i < descriptions.Count; i += 10)
        {
            var batch = descriptions.Skip(i).Take(10).ToList();
            var embeddedBatch = await _aiService.GenerateEmbeddingsAsync(batch);
            foreach (var emb in embeddedBatch)
                await _productService.SaveEmbeddingAsync(emb);
            total += embeddedBatch.Count;
        }

        _logger.LogInformation("Product-embeddings job: completed — {count} embeddings saved", total);
    }

    private async Task ProcessReviewEmbeddingsJobAsync()
    {
        _logger.LogInformation("Review-embeddings job: fetching reviews");
        var reviews = await _reviewService.GetProductReviewsForEmbeddingAsync();

        if (reviews.Count == 0)
        {
            _logger.LogInformation("Review-embeddings job: nothing to embed");
            return;
        }

        _logger.LogInformation("Review-embeddings job: embedding {count} reviews in batches of 10", reviews.Count);
        int total = 0;

        for (int i = 0; i < reviews.Count; i += 10)
        {
            var batch = reviews.Skip(i).Take(10).ToList();
            var embeddedBatch = await _aiService.GenerateReviewEmbeddingsAsync(batch);
            foreach (var emb in embeddedBatch)
                await _reviewService.SaveEmbeddingAsync(emb);
            total += embeddedBatch.Count;
        }

        _logger.LogInformation("Review-embeddings job: completed — {count} embeddings saved", total);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────────────

    private AiJobMessage? DeserialiseOrDrop(BinaryData queueMessage)
    {
        try
        {
            var msg = JsonSerializer.Deserialize<AiJobMessage>(queueMessage.ToString(),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (msg == null || string.IsNullOrWhiteSpace(msg.JobType))
            {
                _logger.LogWarning("Received null or empty AI job message — skipping");
                return null;
            }
            return msg;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to deserialise AI job message — dropping: {raw}", queueMessage.ToString());
            return null;
        }
    }

    private static async Task<QueueClient> GetQueueClientAsync(string queueName)
    {
        var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        if (string.IsNullOrEmpty(queueServiceUri))
        {
            var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
            queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
        }

        var client = new QueueServiceClient(
            new Uri(queueServiceUri),
            new DefaultAzureCredential(),
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });

        var queueClient = client.GetQueueClient(queueName);
        return queueClient;
    }
}
