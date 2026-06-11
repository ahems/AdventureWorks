using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
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
/// Directly generates AI reviews AND staff replies for a single product in one HTTP call.
/// Designed for the "Generate Products with AI" wizard — caller fires and forgets.
///
/// POST /api/products/{productId}/generate-reviews-with-replies
///
/// Returns a summary of what was created.
/// </summary>
public class GenerateReviewsWithRepliesFunction
{
    private readonly ILogger<GenerateReviewsWithRepliesFunction> _logger;
    private readonly AIService _aiService;
    private readonly ReviewService _reviewService;
    private readonly TelemetryClient _telemetryClient;
    private const string EMBEDDINGS_QUEUE = "ai-job-embeddings-queue";

    public GenerateReviewsWithRepliesFunction(
        ILogger<GenerateReviewsWithRepliesFunction> logger,
        AIService aiService,
        ReviewService reviewService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _aiService = aiService;
        _reviewService = reviewService;
        _telemetryClient = telemetryClient;
    }

    [Function("GenerateReviewsWithReplies")]
    public async Task<HttpResponseData> GenerateReviewsWithReplies(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post",
            Route = "products/{productId}/generate-reviews-with-replies")]
        HttpRequestData req,
        int productId)
    {
        _logger.LogInformation("GenerateReviewsWithReplies called for ProductID={ProductID}", productId);

        try
        {
            // 1. Get the product info needed for review generation
            var products = await _reviewService.GetProductsForReviewGenerationAsync(new List<int> { productId });
            if (products == null || products.Count == 0)
            {
                var notFound = req.CreateResponse(HttpStatusCode.NotFound);
                await notFound.WriteStringAsync($"Product {productId} not found or has no description.");
                return notFound;
            }

            var product = products[0];

            // 2. Generate AI reviews for this product
            var generatedReviews = await _aiService.GenerateProductReviewsAsync(new List<ProductForReviewGeneration> { product });
            if (generatedReviews.Count == 0)
            {
                var emptyResponse = req.CreateResponse(HttpStatusCode.OK);
                await emptyResponse.WriteStringAsync($"No reviews generated for product {productId}.");
                return emptyResponse;
            }

            // 3. Save each review to DB, collecting their assigned IDs
            var savedReviewIds = new List<int>();
            foreach (var review in generatedReviews)
            {
                try
                {
                    var newId = await _reviewService.SaveGeneratedReviewAndGetIdAsync(review);
                    savedReviewIds.Add(newId);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to save review for ProductID={ProductID}", productId);
                }
            }

            _logger.LogInformation("Saved {count} reviews for ProductID={ProductID}", savedReviewIds.Count, productId);

            // 4. Generate replies for a random 33–60% of saved reviews
            var rng = new Random();
            var replyRatio = rng.NextDouble() * 0.27 + 0.33; // 33% to 60%
            var replyCount = Math.Max(1, (int)Math.Round(savedReviewIds.Count * replyRatio));
            // Pick random subset
            var reviewsForReply = savedReviewIds
                .OrderBy(_ => rng.Next())
                .Take(replyCount)
                .ToList();

            // Build input tuples for the AI reply generator
            // Pair each selected review ID with its review data
            var savedReviewLookup = generatedReviews
                .Zip(savedReviewIds, (r, id) => new { Id = id, Review = r })
                .ToDictionary(x => x.Id, x => x.Review);

            var replyInputs = reviewsForReply
                .Where(id => savedReviewLookup.ContainsKey(id))
                .Select(id => (
                    ReviewId: id,
                    ReviewerName: savedReviewLookup[id].ReviewerName,
                    Rating: savedReviewLookup[id].Rating,
                    Comments: savedReviewLookup[id].Comments,
                    ProductName: product.Name
                ))
                .ToList();

            var replies = await _aiService.GenerateReviewRepliesAsync(replyInputs);

            // 5. Save the replies
            int repliesSaved = 0;
            foreach (var (reviewId, replyText) in replies)
            {
                try
                {
                    await _reviewService.SaveReviewReplyAsync(reviewId, replyText);
                    repliesSaved++;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to save reply for ProductReviewID={ReviewID}", reviewId);
                }
            }

            _logger.LogInformation("{count} replies saved for ProductID={ProductID}", repliesSaved, productId);

            // 6. Enqueue review embedding generation
            try
            {
                var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
                if (string.IsNullOrEmpty(queueServiceUri))
                {
                    var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName");
                    if (!string.IsNullOrEmpty(storageAccountName))
                        queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
                }

                if (!string.IsNullOrEmpty(queueServiceUri))
                {
                    var queueClient = new QueueServiceClient(
                        new Uri(queueServiceUri),
                        new DefaultAzureCredential(),
                        new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });

                    var embeddingsQueue = queueClient.GetQueueClient(EMBEDDINGS_QUEUE);
                    await embeddingsQueue.CreateIfNotExistsAsync();
                    var embMsg = JsonSerializer.Serialize(new AiJobMessage { JobType = "review-embeddings" });
                    await embeddingsQueue.SendMessageAsync(embMsg);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not enqueue review-embeddings job; continuing.");
            }

            _telemetryClient.TrackEvent("GenerateReviewsWithReplies.Completed", new Dictionary<string, string>
            {
                ["ProductID"] = productId.ToString(),
                ["ReviewsGenerated"] = savedReviewIds.Count.ToString(),
                ["RepliesGenerated"] = repliesSaved.ToString()
            });

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new
            {
                productId,
                reviewsCreated = savedReviewIds.Count,
                repliesCreated = repliesSaved
            });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error in GenerateReviewsWithReplies for ProductID={ProductID}", productId);
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteStringAsync($"Error: {ex.Message}");
            return error;
        }
    }
}
