using System.Net;
using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Queues;
using api_functions.Models;
using api_functions.Services;
using Microsoft.ApplicationInsights;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// Queue-backed review moderation workflow for "Analyze and Approve All".
/// Start endpoint snapshots pending unreplied reviews, enqueues one message per review,
/// and returns immediately. Queue trigger does AI analysis + reply + approval per message.
/// </summary>
public class ReviewModerationQueueFunction
{
    private const string QueueName = "review-moderation-queue";
    private static readonly SemaphoreSlim StartLock = new(1, 1);

    private readonly ILogger<ReviewModerationQueueFunction> _logger;
    private readonly ReviewService _reviewService;
    private readonly ReviewAnalysisAgentService _reviewAnalysisAgentService;
    private readonly TelemetryClient _telemetryClient;
    private readonly WebPubSubService _webPubSub;

    public ReviewModerationQueueFunction(
        ILogger<ReviewModerationQueueFunction> logger,
        ReviewService reviewService,
        ReviewAnalysisAgentService reviewAnalysisAgentService,
        TelemetryClient telemetryClient,
        WebPubSubService webPubSub)
    {
        _logger = logger;
        _reviewService = reviewService;
        _reviewAnalysisAgentService = reviewAnalysisAgentService;
        _telemetryClient = telemetryClient;
        _webPubSub = webPubSub;
    }

    [Function("ReviewModeration_StartAnalyzeApproveAll")]
    public async Task<HttpResponseData> StartAnalyzeApproveAll(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "reviews/moderation/start-analyze-approve-all")]
        HttpRequestData req)
    {
        await StartLock.WaitAsync();
        try
        {
            var state = await _reviewService.GetReviewModerationJobStateAsync();
            state = await ResetIfStaleAsync(state);

            if (state.IsRunning)
            {
                var conflict = req.CreateResponse(HttpStatusCode.Conflict);
                await conflict.WriteAsJsonAsync(new
                {
                    error = "A review moderation job is already running.",
                    state
                });
                return conflict;
            }

            var snapshot = await _reviewService.GetPendingReviewsWithoutReplySnapshotAsync();
            if (snapshot.Count == 0)
            {
                var empty = req.CreateResponse(HttpStatusCode.OK);
                await empty.WriteAsJsonAsync(new
                {
                    started = false,
                    message = "No pending unreplied reviews were found.",
                    state = new ReviewModerationJobState
                    {
                        IsRunning = false,
                        QueuedCount = 0,
                        ProcessedCount = 0,
                        SuccessCount = 0,
                        FailedCount = 0,
                        SkippedCount = 0
                    }
                });
                return empty;
            }

            var queue = await GetQueueClientAsync();
            var jobId = Guid.NewGuid().ToString("N");
            var startedAt = DateTimeOffset.UtcNow;

            var newState = new ReviewModerationJobState
            {
                IsRunning = true,
                JobId = jobId,
                QueuedCount = snapshot.Count,
                ProcessedCount = 0,
                SuccessCount = 0,
                FailedCount = 0,
                SkippedCount = 0,
                StartedAt = startedAt,
                LastProgressAt = startedAt,
                CompletedAt = null,
                LastError = null
            };

            await _reviewService.SaveReviewModerationJobStateAsync(newState);

            foreach (var item in snapshot)
            {
                var message = new ReviewModerationQueueMessage
                {
                    JobId = jobId,
                    ProductReviewId = item.ProductReviewId,
                    Rating = item.Rating,
                    ReviewerName = item.ReviewerName,
                    Comments = item.Comments,
                    ProductName = item.ProductName,
                    EnqueuedAt = DateTimeOffset.UtcNow
                };

                await queue.SendMessageAsync(JsonSerializer.Serialize(message));
            }

            _telemetryClient.TrackEvent("ReviewModeration.Started", new Dictionary<string, string>
            {
                ["JobId"] = jobId,
                ["QueuedCount"] = snapshot.Count.ToString()
            });

            var accepted = req.CreateResponse(HttpStatusCode.Accepted);
            await accepted.WriteAsJsonAsync(new
            {
                started = true,
                message = $"Queued {snapshot.Count} review moderation item(s).",
                state = newState
            });
            return accepted;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to start review moderation job");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "Failed to start review moderation job." });
            return error;
        }
        finally
        {
            StartLock.Release();
        }
    }

    [Function("ReviewModeration_Status")]
    public async Task<HttpResponseData> GetStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "reviews/moderation/status")]
        HttpRequestData req)
    {
        var state = await _reviewService.GetReviewModerationJobStateAsync();
        state = await ResetIfStaleAsync(state);

        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(state);
        return response;
    }

    [Function("ReviewModeration_QueueTrigger")]
    public async Task QueueTrigger(
        [QueueTrigger(QueueName, Connection = "AzureWebJobsStorage")] BinaryData queueMessage)
    {
        ReviewModerationQueueMessage? message;
        try
        {
            message = JsonSerializer.Deserialize<ReviewModerationQueueMessage>(queueMessage.ToString());
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Invalid review moderation queue message.");
            return;
        }

        if (message == null || message.ProductReviewId <= 0 || string.IsNullOrWhiteSpace(message.JobId))
        {
            _logger.LogWarning("Skipping malformed review moderation message.");
            return;
        }

        var state = await _reviewService.GetReviewModerationJobStateAsync();
        if (!state.IsRunning || !string.Equals(state.JobId, message.JobId, StringComparison.Ordinal))
        {
            _logger.LogInformation(
                "Ignoring stale moderation message for ProductReviewId={ReviewId}, JobId={JobId}.",
                message.ProductReviewId,
                message.JobId);
            return;
        }

        try
        {
            var analyses = await _reviewAnalysisAgentService.AnalyzeReviewsAsync(new List<ReviewInput>
            {
                new()
                {
                    ProductReviewId = message.ProductReviewId,
                    Rating = message.Rating,
                    Comments = message.Comments,
                    ReviewerName = message.ReviewerName,
                    ProductName = message.ProductName
                }
            });

            var analysis = analyses.FirstOrDefault();
            var suggestedResponse = analysis?.SuggestedResponse?.Trim();
            if (string.IsNullOrWhiteSpace(suggestedResponse))
            {
                await _reviewService.IncrementReviewModerationProgressAsync(
                    message.JobId,
                    success: false,
                    skipped: false,
                    failed: true,
                    lastError: $"No suggested response for review {message.ProductReviewId}.");
                return;
            }

            var outcome = await _reviewService.ApplyModerationReplyAndApproveAsync(
                message.ProductReviewId,
                suggestedResponse);

            switch (outcome)
            {
                case ReviewModerationApplyOutcome.Applied:
                    await _reviewService.IncrementReviewModerationProgressAsync(
                        message.JobId,
                        success: true,
                        skipped: false,
                        failed: false,
                        lastError: null);
                    break;
                case ReviewModerationApplyOutcome.SkippedAlreadyModerated:
                case ReviewModerationApplyOutcome.SkippedAlreadyReplied:
                case ReviewModerationApplyOutcome.SkippedNotFound:
                    await _reviewService.IncrementReviewModerationProgressAsync(
                        message.JobId,
                        success: false,
                        skipped: true,
                        failed: false,
                        lastError: null);
                    break;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Review moderation failed for ProductReviewId={ReviewId}", message.ProductReviewId);
            await _reviewService.IncrementReviewModerationProgressAsync(
                message.JobId,
                success: false,
                skipped: false,
                failed: true,
                lastError: ex.Message);
        }

        await _webPubSub.SendToGroupAsync("reviews", new { @event = "moderation-progress", jobId = message.JobId });
    }

    private async Task<ReviewModerationJobState> ResetIfStaleAsync(ReviewModerationJobState state)
    {
        if (!state.IsRunning)
        {
            return state;
        }

        var lastActivity = state.LastProgressAt ?? state.StartedAt;
        if (!lastActivity.HasValue)
        {
            return state;
        }

        if (DateTimeOffset.UtcNow - lastActivity.Value <= TimeSpan.FromMinutes(10))
        {
            return state;
        }

        _logger.LogWarning(
            "Auto-resetting stale review moderation job {JobId}; no progress since {LastActivity}.",
            state.JobId,
            lastActivity.Value);

        state.IsRunning = false;
        state.CompletedAt = DateTimeOffset.UtcNow;
        state.LastError = "Job auto-reset after inactivity timeout.";
        await _reviewService.SaveReviewModerationJobStateAsync(state);
        return state;
    }

    private static async Task<QueueClient> GetQueueClientAsync()
    {
        var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        if (string.IsNullOrEmpty(queueServiceUri))
        {
            var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
            queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
        }

        var serviceClient = new QueueServiceClient(
            new Uri(queueServiceUri),
            new DefaultAzureCredential(),
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });

        var queueClient = serviceClient.GetQueueClient(QueueName);
        return queueClient;
    }
}
