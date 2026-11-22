using System.Net;
using System.Security.Claims;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.Functions;
using api_functions.Services;
using Azure.Core.Serialization;
using Azure.Identity;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class ReviewVoteFunctionsTests
{
    [Theory]
    [InlineData(71)]
    [InlineData(72)]
    public async Task Vote_is_bound_to_the_signed_consumer_and_ignores_forged_inputs(int owner)
    {
        var store = new Store();
        var publisher = new Publisher();
        using var context = new Context(owner);
        var request = new Request(context, "POST", """{"businessEntityId":999,"HelpfulVotes":500}""");
        request.Headers.Add("X-MS-CLIENT-PRINCIPAL-ID", "999");
        request.Headers.Add("X-MS-API-ROLE", "executive-admin");

        var response = await Handler(store, publisher).VoteReviewHelpful(request, 7, context);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal((7, owner, true), store.Calls.Single());
        using var body = await Body(response);
        Assert.Equal(4, body.RootElement.GetProperty("helpfulVotes").GetInt32());
        Assert.True(body.RootElement.GetProperty("voted").GetBoolean());
        Assert.True(body.RootElement.GetProperty("changed").GetBoolean());
        var (group, payload) = Assert.Single(publisher.Sent);
        Assert.Equal("reviews", group);
        Assert.Equal("""{"event":"review-votes-changed","productReviewId":7,"productId":680}""", JsonSerializer.Serialize(payload));
    }

    [Theory]
    [InlineData(71)]
    [InlineData(72)]
    public async Task Removing_a_vote_is_bound_to_the_signed_consumer(int owner)
    {
        var store = new Store();
        var publisher = new Publisher();
        using var context = new Context(owner);

        var response = await Handler(store, publisher).RemoveReviewHelpfulVote(new Request(context, "DELETE"), 7, context);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal((7, owner, false), store.Calls.Single());
        using var body = await Body(response);
        Assert.False(body.RootElement.GetProperty("voted").GetBoolean());
        Assert.Single(publisher.Sent);
    }

    [Theory]
    [InlineData(null, true, "consumer")]
    [InlineData(0, true, "consumer")]
    [InlineData(41, false, "consumer")]
    [InlineData(41, true, "employee")]
    [InlineData(41, true, "unknown")]
    public async Task Untrusted_unbound_or_internal_callers_never_reach_storage(int? voter, bool authenticated, string category)
    {
        var store = new Store();
        var publisher = new Publisher();
        using var context = new Context(voter, authenticated, category);

        var response = await Handler(store, publisher).VoteReviewHelpful(new Request(context, "POST"), 7, context);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Empty(store.Calls);
        Assert.Empty(publisher.Sent);
    }

    [Fact]
    public async Task Repeat_vote_is_idempotent_and_publishes_nothing()
    {
        var store = new Store { Outcome = ReviewVoteOutcome.Unchanged };
        var publisher = new Publisher();
        using var context = new Context(41);

        var response = await Handler(store, publisher).VoteReviewHelpful(new Request(context, "POST"), 7, context);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = await Body(response);
        Assert.False(body.RootElement.GetProperty("changed").GetBoolean());
        Assert.Equal(4, body.RootElement.GetProperty("helpfulVotes").GetInt32());
        Assert.Empty(publisher.Sent);
    }

    [Theory]
    [InlineData(ReviewVoteOutcome.OwnReview, HttpStatusCode.Forbidden)]
    [InlineData(ReviewVoteOutcome.NotFound, HttpStatusCode.NotFound)]
    public async Task Own_or_missing_reviews_are_rejected_without_an_event(ReviewVoteOutcome outcome, HttpStatusCode expected)
    {
        var store = new Store { Outcome = outcome };
        var publisher = new Publisher();
        using var context = new Context(41);

        var response = await Handler(store, publisher).VoteReviewHelpful(new Request(context, "POST"), 7, context);

        Assert.Equal(expected, response.StatusCode);
        Assert.Empty(publisher.Sent);
    }

    [Fact]
    public async Task Invalid_review_id_is_rejected_before_storage()
    {
        var store = new Store();
        using var context = new Context(41);

        var response = await Handler(store, new Publisher()).VoteReviewHelpful(new Request(context, "POST"), 0, context);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(store.Calls);
    }

    private static ReviewVoteFunctions Handler(Store store, Publisher publisher) =>
        new(store, publisher, NullLogger<ReviewVoteFunctions>.Instance);

    private static async Task<JsonDocument> Body(HttpResponseData response)
    {
        response.Body.Position = 0;
        return await JsonDocument.ParseAsync(response.Body);
    }

    private sealed class Store : IReviewVoteStore
    {
        public ReviewVoteOutcome Outcome { get; init; } = ReviewVoteOutcome.Changed;
        public List<(int Review, int Voter, bool Add)> Calls { get; } = [];

        public Task<ReviewVoteResult> AddVoteAsync(int productReviewId, int voterBusinessEntityId) =>
            Record(productReviewId, voterBusinessEntityId, true);

        public Task<ReviewVoteResult> RemoveVoteAsync(int productReviewId, int voterBusinessEntityId) =>
            Record(productReviewId, voterBusinessEntityId, false);

        private Task<ReviewVoteResult> Record(int review, int voter, bool add)
        {
            Calls.Add((review, voter, add));
            return Task.FromResult(new ReviewVoteResult(Outcome, review, 680, 4, add));
        }
    }

    private sealed class Publisher() : WebPubSubService(null, new DefaultAzureCredential(), NullLogger<WebPubSubService>.Instance)
    {
        public List<(string Group, object Payload)> Sent { get; } = [];

        public override Task SendToGroupAsync(string group, object payload)
        {
            Sent.Add((group, payload));
            return Task.CompletedTask;
        }
    }

    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            })).BuildServiceProvider();

        public Context(int? voter, bool authenticated = true, string category = "consumer")
        {
            InstanceServices = _services;
            Items[FunctionUser.ContextKey] = new FunctionUser
            {
                IsAuthenticated = authenticated, Category = category, BusinessEntityId = voter,
            };
        }

        public override string InvocationId => "review-vote-test";
        public override string FunctionId => "review-vote-test";
        public override TraceContext TraceContext => throw new NotSupportedException();
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
        public void Dispose() => _services.Dispose();
    }

    private sealed class Request(FunctionContext context, string method, string? body = null) : HttpRequestData(context)
    {
        public override Stream Body { get; } = body is null ? Stream.Null : new MemoryStream(System.Text.Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new("https://functions.example.test/api/reviews/7/vote?businessEntityId=999");
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => method;
        public override HttpResponseData CreateResponse() => new Response(FunctionContext);
    }

    private sealed class Response(FunctionContext context) : HttpResponseData(context)
    {
        public override HttpStatusCode StatusCode { get; set; }
        public override HttpHeadersCollection Headers { get; set; } = new();
        public override Stream Body { get; set; } = new MemoryStream();
        public override HttpCookies Cookies => throw new NotSupportedException();
    }
}
