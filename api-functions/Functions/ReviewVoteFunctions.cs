using System.Net;
using ApiFunctions.Auth;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// Storefront "helpful" review votes. The voter is always the signed-in consumer from the token;
/// each person counts once per review, and the counter changes atomically with the vote row.
/// </summary>
public sealed class ReviewVoteFunctions(
    IReviewVoteStore votes,
    WebPubSubService publisher,
    ILogger<ReviewVoteFunctions> logger)
{
    [Function("VoteReviewHelpful")]
    public Task<HttpResponseData> VoteReviewHelpful(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "reviews/{productReviewId:int}/vote")] HttpRequestData request,
        int productReviewId,
        FunctionContext context) =>
        ChangeAsync(request, context, productReviewId, add: true);

    [Function("RemoveReviewHelpfulVote")]
    public Task<HttpResponseData> RemoveReviewHelpfulVote(
        [HttpTrigger(AuthorizationLevel.Anonymous, "delete", Route = "reviews/{productReviewId:int}/vote")] HttpRequestData request,
        int productReviewId,
        FunctionContext context) =>
        ChangeAsync(request, context, productReviewId, add: false);

    private async Task<HttpResponseData> ChangeAsync(HttpRequestData request, FunctionContext context, int productReviewId, bool add)
    {
        var user = FunctionUser.Current(context);
        if (!user.IsAuthenticated || !user.IsConsumer || user.BusinessEntityId is not int voter || voter <= 0)
        {
            logger.LogWarning("Review vote denied: no signed consumer identity.");
            return await JsonAsync(request, HttpStatusCode.Forbidden, new { error = "A signed-in shopper is required to vote." });
        }

        if (productReviewId <= 0)
        {
            return await JsonAsync(request, HttpStatusCode.BadRequest, new { error = "A valid review id is required." });
        }

        var result = add
            ? await votes.AddVoteAsync(productReviewId, voter)
            : await votes.RemoveVoteAsync(productReviewId, voter);

        switch (result.Outcome)
        {
            case ReviewVoteOutcome.NotFound:
                return await JsonAsync(request, HttpStatusCode.NotFound, new { error = "Review not found." });
            case ReviewVoteOutcome.OwnReview:
                return await JsonAsync(request, HttpStatusCode.Forbidden,
                    new { error = "You cannot vote on your own review.", reason = "own-review" });
            case ReviewVoteOutcome.Changed:
                await publisher.SendToGroupAsync("reviews", new
                {
                    @event = "review-votes-changed",
                    productReviewId = result.ProductReviewId,
                    productId = result.ProductId,
                });
                break;
        }

        return await JsonAsync(request, HttpStatusCode.OK, new
        {
            productReviewId = result.ProductReviewId,
            helpfulVotes = result.HelpfulVotes,
            voted = result.Voted,
            changed = result.Outcome == ReviewVoteOutcome.Changed,
        });
    }

    private static async Task<HttpResponseData> JsonAsync(HttpRequestData request, HttpStatusCode status, object body)
    {
        var response = request.CreateResponse(status);
        await response.WriteAsJsonAsync(body);
        response.StatusCode = status;
        return response;
    }
}
