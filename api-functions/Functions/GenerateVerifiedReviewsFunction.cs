using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using api_functions.Models;
using api_functions.Services;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

/// <summary>
/// Generates AI reviews anchored to real customers who have a Delivered (Status=7) order
/// for each product, where that customer has NOT yet written a review.
///
/// GET  /api/generate-verified-reviews/summary
///   → { qualifyingProductCount, maxEligibleCustomersPerProduct }
///
/// POST /api/generate-verified-reviews/start
///   body: { "productCount": N, "reviewsPerProduct": M }
///   productCount 0 = all qualifying; reviewsPerProduct default 1
///   → 202 Accepted { jobId, ... }; one message per product is enqueued on
///     verified-reviews-queue and processed by the queue trigger below
///   → 409 Conflict if a non-stale job is already running
///
/// GET  /api/generate-verified-reviews/status
///   → VerifiedReviewsJobState (pure read; isStale is computed, never reset here —
///     ReviewJobWatchdog expires abandoned jobs)
///
/// GET  /api/products/{productId}/customers-with-delivered-orders
///   → { customers: [...], count: N }  (diagnostic endpoint)
/// </summary>
public class GenerateVerifiedReviewsFunction
{
    private readonly ILogger<GenerateVerifiedReviewsFunction> _logger;
    private readonly ReviewAgentService _reviewAgentService;
    private readonly ReviewBatchAgentService _reviewBatchAgentService;
    private readonly ReviewService _reviewService;
    private readonly TelemetryClient _telemetryClient;
    private readonly WebPubSubService _webPubSub;
    private readonly VerifiedReviewsQueue _queue;

    // In-process guard. Table Storage IsRunning flag provides cross-instance persistence.
    private static readonly SemaphoreSlim _startLock = new(1, 1);

    public GenerateVerifiedReviewsFunction(
        ILogger<GenerateVerifiedReviewsFunction> logger,
        ReviewAgentService reviewAgentService,
        ReviewBatchAgentService reviewBatchAgentService,
        ReviewService reviewService,
        TelemetryClient telemetryClient,
        WebPubSubService webPubSub,
        VerifiedReviewsQueue queue)
    {
        _logger = logger;
        _reviewAgentService = reviewAgentService;
        _reviewBatchAgentService = reviewBatchAgentService;
        _reviewService = reviewService;
        _telemetryClient = telemetryClient;
        _webPubSub = webPubSub;
        _queue = queue;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/generate-verified-reviews/summary
    // ─────────────────────────────────────────────────────────────────────────

    [Function("GetVerifiedReviewsSummary")]
    public async Task<HttpResponseData> GetVerifiedReviewsSummary(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "generate-verified-reviews/summary")]
        HttpRequestData req)
    {
        _logger.LogInformation("GetVerifiedReviewsSummary called");
        var summary = await _reviewService.GetVerifiedReviewsSummaryAsync();
        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync(JsonSerializer.Serialize(summary,
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
        return response;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/generate-verified-reviews/start  (batch)
    // ─────────────────────────────────────────────────────────────────────────

    [Function("StartBatchVerifiedReviews")]
    public async Task<HttpResponseData> StartBatchVerifiedReviews(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post",
            Route = "generate-verified-reviews/start")]
        HttpRequestData req)
    {
        _logger.LogInformation("StartBatchVerifiedReviews called");

        BatchStartVerifiedReviewsRequest requestBody;
        try
        {
            var body = await req.ReadAsStringAsync();
            requestBody = (!string.IsNullOrWhiteSpace(body)
                ? JsonSerializer.Deserialize<BatchStartVerifiedReviewsRequest>(body,
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                : null) ?? new BatchStartVerifiedReviewsRequest();
        }
        catch
        {
            requestBody = new BatchStartVerifiedReviewsRequest();
        }

        var reviewsPerProduct = Math.Max(1, requestBody.ReviewsPerProduct == 0 ? 1 : requestBody.ReviewsPerProduct);
        var productCount = Math.Max(0, requestBody.ProductCount);   // 0 = all

        await _startLock.WaitAsync();
        try
        {
            var currentState = await _reviewService.GetVerifiedReviewsJobStateAsync();

            // A stale job (no progress for StaleAfter) may be replaced; its remaining queue
            // messages carry the old job id and are ignored by the processor.
            if (currentState.IsRunning && !currentState.IsStale)
            {
                var conflict = req.CreateResponse(HttpStatusCode.Conflict);
                await conflict.WriteStringAsync(JsonSerializer.Serialize(new
                {
                    error = "A verified-reviews generation job is already running.",
                    productsProcessed = currentState.ProductsProcessed,
                    productsTotal = currentState.ProductsTotal,
                    processedCount = currentState.ProcessedCount,
                    totalCount = currentState.TotalCount,
                    startedAt = currentState.StartedAt
                }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
                return conflict;
            }

            var batchData = new List<(ProductForReviewGeneration Product, List<CustomerWithDeliveredOrder> Customers)>();

            if (requestBody.SpecificProductId.HasValue)
            {
                // Product-page path: target a single specific product
                var single = await _reviewService.GetVerifiedReviewsDataForProductAsync(
                    requestBody.SpecificProductId.Value, reviewsPerProduct);

                if (single == null)
                {
                    var noData = req.CreateResponse(HttpStatusCode.UnprocessableEntity);
                    await noData.WriteStringAsync(
                        $"Product {requestBody.SpecificProductId.Value} has no eligible unreviewed customers " +
                        "with a Delivered eshop order. Reviews can only be generated for customers who " +
                        "purchased and received the product but have not yet reviewed it.");
                    return noData;
                }

                batchData.Add(single.Value);
            }
            else
            {
                // Utilities-page batch path: randomly select qualifying products
                batchData = await _reviewService.GetBatchVerifiedReviewsDataAsync(productCount, reviewsPerProduct);
                if (batchData.Count == 0)
                {
                    var noData = req.CreateResponse(HttpStatusCode.UnprocessableEntity);
                    await noData.WriteStringAsync("No qualifying products found. All eligible customers may have already reviewed their purchased products.");
                    return noData;
                }
            }

            var totalReviews = batchData.Sum(x => x.Customers.Count);
            var startedAt = DateTimeOffset.UtcNow;
            var jobState = new VerifiedReviewsJobState
            {
                IsRunning = true,
                JobId = Guid.NewGuid().ToString("N"),
                ProductId = 0,
                ProductName = batchData[0].Product.Name,
                ProcessedCount = 0,
                TotalCount = totalReviews,
                ProductsProcessed = 0,
                ProductsTotal = batchData.Count,
                StartedAt = startedAt,
                LastProgressAt = startedAt
            };
            await _reviewService.SaveVerifiedReviewsJobStateAsync(jobState);

            try
            {
                foreach (var (product, customers) in batchData)
                {
                    await _queue.EnqueueAsync(new VerifiedReviewsQueueMessage
                    {
                        JobId = jobState.JobId,
                        Product = product,
                        CustomerIds = customers.Select(c => c.CustomerID).ToList(),
                        EnqueuedAt = DateTimeOffset.UtcNow
                    });
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to enqueue verified-reviews job {JobId}", jobState.JobId);
                await _reviewService.StopVerifiedReviewsJobAsync(jobState.JobId,
                    "Failed to enqueue verified-reviews generation job.");
                var error = req.CreateResponse(HttpStatusCode.InternalServerError);
                await error.WriteStringAsync(JsonSerializer.Serialize(
                    new { error = "Failed to start verified-reviews generation job." },
                    new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
                return error;
            }

            var accepted = req.CreateResponse(HttpStatusCode.Accepted);
            await accepted.WriteStringAsync(JsonSerializer.Serialize(new
            {
                message = $"Generating {totalReviews} verified review(s) across {batchData.Count} product(s)",
                jobId = jobState.JobId,
                productsTotal = batchData.Count,
                totalCount = totalReviews
            }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
            return accepted;
        }
        finally
        {
            _startLock.Release();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/generate-verified-reviews/status
    // ─────────────────────────────────────────────────────────────────────────

    [Function("GetVerifiedReviewsStatus")]
    public async Task<HttpResponseData> GetVerifiedReviewsStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "generate-verified-reviews/status")]
        HttpRequestData req)
    {
        var state = await _reviewService.GetVerifiedReviewsJobStateAsync();

        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync(JsonSerializer.Serialize(state,
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
        return response;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/products/{productId}/customers-with-delivered-orders  (diagnostic)
    // ─────────────────────────────────────────────────────────────────────────

    [Function("GetCustomersWithDeliveredOrders")]
    public async Task<HttpResponseData> GetCustomersWithDeliveredOrders(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "products/{productId}/customers-with-delivered-orders")]
        HttpRequestData req,
        int productId)
    {
        _logger.LogInformation("GetCustomersWithDeliveredOrders: productId={productId}", productId);
        var customers = await _reviewService.GetCustomersWithDeliveredOrderForProductAsync(productId);
        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync(JsonSerializer.Serialize(new
        {
            customers,
            count = customers.Count
        }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
        return response;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/products/{productId}/eligible-reviewer-count  (product-page gate)
    // Lightweight — returns only the count, not the full customer list.
    // ─────────────────────────────────────────────────────────────────────────

    [Function("GetProductEligibleReviewerCount")]
    public async Task<HttpResponseData> GetProductEligibleReviewerCount(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "products/{productId}/eligible-reviewer-count")]
        HttpRequestData req,
        int productId)
    {
        var count = await _reviewService.GetProductEligibleReviewerCountAsync(productId);
        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync(JsonSerializer.Serialize(
            new { productId, count },
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
        return response;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Queue trigger: one message per product of a verified-reviews job
    // ─────────────────────────────────────────────────────────────────────────

    [Function("VerifiedReviews_QueueTrigger")]
    public async Task ProcessVerifiedReviewsQueueMessage(
        [QueueTrigger(VerifiedReviewsQueue.QueueName, Connection = "AzureWebJobsStorage")] BinaryData queueMessage)
    {
        VerifiedReviewsQueueMessage? message;
        try
        {
            message = JsonSerializer.Deserialize<VerifiedReviewsQueueMessage>(queueMessage.ToString());
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "Invalid verified-reviews queue message.");
            return;
        }

        if (message == null || string.IsNullOrWhiteSpace(message.JobId) || message.Product.ProductID <= 0)
        {
            _logger.LogWarning("Skipping malformed verified-reviews queue message.");
            return;
        }

        var product = message.Product;
        var state = await _reviewService.GetVerifiedReviewsJobStateAsync();
        if (!state.IsRunning || !string.Equals(state.JobId, message.JobId, StringComparison.Ordinal))
        {
            _logger.LogInformation("Ignoring verified-reviews message for inactive job {JobId}, ProductID={pid}",
                message.JobId, product.ProductID);
            return;
        }

        // Re-read eligibility so a redelivered message skips customers whose review was already saved.
        var eligible = (await _reviewService.GetCustomersWithDeliveredOrderForProductAsync(product.ProductID))
            .ToDictionary(c => c.CustomerID);
        var savedIds = new List<int>();

        try
        {
            foreach (var customerId in message.CustomerIds.Distinct())
            {
                if (!eligible.TryGetValue(customerId, out var customer))
                    continue;

                string? error = null;
                try
                {
                    var review = await _reviewAgentService.GenerateReviewAsync(product, customer);
                    if (review != null)
                    {
                        var reviewId = await _reviewService.SaveGeneratedReviewAndGetIdAsync(review);
                        savedIds.Add(reviewId);
                        _logger.LogInformation(
                            "Saved verified review {id} for CustomerID={cid}, ProductID={pid}",
                            reviewId, customer.CustomerID, product.ProductID);
                    }
                }
                catch (Exception ex) when (ex is not FoundryToolPolicyException)
                {
                    _logger.LogError(ex, "Error generating review for CustomerID={cid}, ProductID={pid}",
                        customer.CustomerID, product.ProductID);
                    error = $"Product '{product.Name}', CustomerID {customer.CustomerID}: {ex.Message}";
                }

                var progress = await _reviewService.ReportVerifiedReviewProgressAsync(message.JobId, product.Name, error);
                if (progress == null)
                {
                    _logger.LogInformation("Verified-reviews job {JobId} stopped or replaced; abandoning ProductID={pid}",
                        message.JobId, product.ProductID);
                    return;
                }

                await _webPubSub.SendToGroupAsync("reviews", new
                {
                    @event = "generation-progress", jobId = message.JobId,
                    processed = progress.ProcessedCount, total = progress.TotalCount
                });
            }

            // Generate staff replies for 33-60% of saved reviews for this product
            if (savedIds.Count > 0)
            {
                var rng = new Random();
                var replyRatio = rng.NextDouble() * 0.27 + 0.33;
                var replyCount = Math.Max(1, (int)Math.Round(savedIds.Count * replyRatio));
                var replyIds = savedIds.OrderBy(_ => rng.Next()).Take(replyCount).ToList();

                var replyInputs = replyIds.Select(id => (
                    ReviewId: id,
                    ReviewerName: "Customer",
                    Rating: 4,
                    Comments: string.Empty,
                    ProductName: product.Name
                )).ToList();

                try
                {
                    var replies = await _reviewBatchAgentService.GenerateReviewRepliesAsync(replyInputs);
                    foreach (var (reviewId, reply) in replies)
                        await _reviewService.SaveReviewReplyAsync(reviewId, reply);
                    _logger.LogInformation("Saved {count} replies for productId={pid}", replies.Count, product.ProductID);
                }
                catch (Exception ex) when (ex is not FoundryToolPolicyException)
                {
                    _logger.LogWarning(ex, "Failed to generate replies for productId={pid}", product.ProductID);
                }
            }
        }
        catch (FoundryToolPolicyException ex)
        {
            _logger.LogError(ex, "Verified-reviews job {JobId} stopped after a tool-policy violation", message.JobId);
            await _reviewService.StopVerifiedReviewsJobAsync(message.JobId, ex.Message);
            return;
        }

        var completed = await _reviewService.CompleteVerifiedReviewsProductAsync(
            message.JobId, product.ProductID, message.CustomerIds.Distinct().Count());

        _telemetryClient.TrackEvent("VerifiedReviewsBatchProductCompleted", new Dictionary<string, string>
        {
            ["JobId"] = message.JobId,
            ["ProductID"] = product.ProductID.ToString(),
            ["ProductName"] = product.Name,
            ["ReviewCount"] = savedIds.Count.ToString()
        });

        if (completed is { IsRunning: false, JobId: var jobId } && jobId == message.JobId &&
            completed.ProductsProcessed >= completed.ProductsTotal)
        {
            _telemetryClient.TrackEvent("VerifiedReviewsBatchJobCompleted", new Dictionary<string, string>
            {
                ["JobId"] = message.JobId,
                ["ProductCount"] = completed.ProductsTotal.ToString(),
                ["TotalReviews"] = completed.TotalCount.ToString()
            });
            _logger.LogInformation("Verified-reviews job {JobId} finished", message.JobId);
        }
    }
}
