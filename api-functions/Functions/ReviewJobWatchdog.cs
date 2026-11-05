using api_functions.Services;
using Microsoft.Azure.Functions.Worker;

namespace api_functions.Functions;

/// <summary>Expires abandoned jobs without requiring a browser status request to reset the guard.</summary>
public sealed class ReviewJobWatchdog(ReviewService reviews)
{
    [Function(nameof(ExpireAbandonedReviewJobs))]
    public Task ExpireAbandonedReviewJobs([TimerTrigger("0 * * * * *")] TimerInfo timer) =>
        reviews.ExpireAbandonedJobsAsync();
}
