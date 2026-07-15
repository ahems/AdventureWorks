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
///   → 202 Accepted; batch job runs in background
///   → 409 Conflict if a job is already running
///
/// GET  /api/generate-verified-reviews/status
///   → VerifiedReviewsJobState (isRunning, processedCount, totalCount,
///      productsProcessed, productsTotal, productName, lastError)
///
/// GET  /api/products/{productId}/customers-with-delivered-orders
///   → { customers: [...], count: N }  (diagnostic endpoint)
/// </summary>
public class GenerateVerifiedReviewsFunction
{
    private readonly ILogger<GenerateVerifiedReviewsFunction> _logger;
    private readonly AIService _aiService;
    private readonly ReviewAgentService _reviewAgentService;
    private readonly ReviewService _reviewService;
    private readonly TelemetryClient _telemetryClient;

    // In-process guard. Table Storage IsRunning flag provides cross-instance persistence.
    private static readonly SemaphoreSlim _startLock = new(1, 1);

    public GenerateVerifiedReviewsFunction(
        ILogger<GenerateVerifiedReviewsFunction> logger,
        AIService aiService,
        ReviewAgentService reviewAgentService,
        ReviewService reviewService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _aiService = aiService;
        _reviewAgentService = reviewAgentService;
        _reviewService = reviewService;
        _telemetryClient = telemetryClient;
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

            // Auto-reset stale guard: no progress in >10 min (same logic as GET /status)
            if (currentState.IsRunning)
            {
                var lastActivity = currentState.LastProgressAt ?? currentState.StartedAt;
                if (lastActivity.HasValue &&
                    DateTimeOffset.UtcNow - lastActivity.Value > TimeSpan.FromMinutes(10))
                {
                    _logger.LogWarning("Verified reviews batch job guard auto-reset (no progress since {t})",
                        lastActivity.Value);
                    currentState.IsRunning = false;
                    await _reviewService.SaveVerifiedReviewsJobStateAsync(currentState);
                }
            }

            if (currentState.IsRunning)
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

            var batchData = await _reviewService.GetBatchVerifiedReviewsDataAsync(productCount, reviewsPerProduct);
            if (batchData.Count == 0)
            {
                var noData = req.CreateResponse(HttpStatusCode.UnprocessableEntity);
                await noData.WriteStringAsync("No qualifying products found. All eligible customers may have already reviewed their purchased products.");
                return noData;
            }

            var totalReviews = batchData.Sum(x => x.Customers.Count);

            var jobState = new VerifiedReviewsJobState
            {
                IsRunning = true,
                ProductId = 0,
                ProductName = batchData[0].Product.Name,
                ProcessedCount = 0,
                TotalCount = totalReviews,
                ProductsProcessed = 0,
                ProductsTotal = batchData.Count,
                StartedAt = DateTimeOffset.UtcNow
            };
            await _reviewService.SaveVerifiedReviewsJobStateAsync(jobState);

            _ = Task.Run(() => RunBatchJobAsync(batchData, jobState));

            var accepted = req.CreateResponse(HttpStatusCode.Accepted);
            await accepted.WriteStringAsync(JsonSerializer.Serialize(new
            {
                message = $"Generating {totalReviews} verified review(s) across {batchData.Count} product(s)",
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

        // Auto-reset an orphaned job: if isRunning but no progress update in >10 min
        // (e.g. function host was recycled mid-job and the finally block never ran)
        if (state.IsRunning)
        {
            var lastActivity = state.LastProgressAt ?? state.StartedAt;
            if (lastActivity.HasValue &&
                DateTimeOffset.UtcNow - lastActivity.Value > TimeSpan.FromMinutes(10))
            {
                _logger.LogWarning(
                    "GetVerifiedReviewsStatus: auto-resetting orphaned job (no progress since {t})",
                    lastActivity.Value);
                state.IsRunning = false;
                await _reviewService.SaveVerifiedReviewsJobStateAsync(state);
            }
        }

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
    // Background batch job
    // ─────────────────────────────────────────────────────────────────────────

    private async Task RunBatchJobAsync(
        List<(ProductForReviewGeneration Product, List<CustomerWithDeliveredOrder> Customers)> batch,
        VerifiedReviewsJobState state)
    {
        _logger.LogInformation("VerifiedReviews batch job started: {productCount} products, {totalReviews} reviews",
            batch.Count, state.TotalCount);

        var totalSaved = 0;

        try
        {
            for (var productIndex = 0; productIndex < batch.Count; productIndex++)
            {
                var (product, customers) = batch[productIndex];

                // Update current product name so UI can show which product is being processed
                state.ProductName = product.Name;
                await _reviewService.SaveVerifiedReviewsJobStateAsync(state);

                var savedIds = new List<int>();

                foreach (var customer in customers)
                {
                    try
                    {
                        // Use the Foundry agent when configured; fall back to direct OpenAI call.
                        GeneratedReview? review;
                        if (_reviewAgentService.IsConfigured)
                        {
                            review = await _reviewAgentService.GenerateReviewAsync(product, customer);
                        }
                        else
                        {
                            _logger.LogDebug("ReviewAgentService not configured — using direct AIService fallback");
                            review = await _aiService.GenerateReviewForCustomerAsync(product, customer);
                        }
                        if (review != null)
                        {
                            var reviewId = await _reviewService.SaveGeneratedReviewAndGetIdAsync(review);
                            savedIds.Add(reviewId);
                            totalSaved++;
                            _logger.LogInformation(
                                "Saved verified review {id} for CustomerID={cid}, ProductID={pid}",
                                reviewId, customer.CustomerID, product.ProductID);
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Error generating review for CustomerID={cid}, ProductID={pid}",
                            customer.CustomerID, product.ProductID);
                        state.LastError = $"Product '{product.Name}', CustomerID {customer.CustomerID}: {ex.Message}";
                    }

                    state.ProcessedCount++;
                    state.LastProgressAt = DateTimeOffset.UtcNow;
                    await _reviewService.SaveVerifiedReviewsJobStateAsync(state);
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
                        var replies = await _aiService.GenerateReviewRepliesAsync(replyInputs);
                        foreach (var (reviewId, reply) in replies)
                            await _reviewService.SaveReviewReplyAsync(reviewId, reply);
                        _logger.LogInformation("Saved {count} replies for productId={pid}", replies.Count, product.ProductID);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to generate replies for productId={pid}", product.ProductID);
                    }
                }

                state.ProductsProcessed = productIndex + 1;
                await _reviewService.SaveVerifiedReviewsJobStateAsync(state);

                _telemetryClient.TrackEvent("VerifiedReviewsBatchProductCompleted", new Dictionary<string, string>
                {
                    ["ProductID"] = product.ProductID.ToString(),
                    ["ProductName"] = product.Name,
                    ["ReviewCount"] = savedIds.Count.ToString()
                });
            }

            _telemetryClient.TrackEvent("VerifiedReviewsBatchJobCompleted", new Dictionary<string, string>
            {
                ["ProductCount"] = batch.Count.ToString(),
                ["TotalReviews"] = totalSaved.ToString()
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "VerifiedReviews batch job failed");
            state.LastError = ex.Message;
        }
        finally
        {
            state.IsRunning = false;
            await _reviewService.SaveVerifiedReviewsJobStateAsync(state);
            _logger.LogInformation("VerifiedReviews batch job finished: saved={count}", totalSaved);
        }
    }
}
