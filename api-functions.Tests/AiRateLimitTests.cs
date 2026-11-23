using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using api_functions.Functions;
using api_functions.Services;
using Azure;
using Azure.Core;
using Azure.Core.Serialization;
using Azure.Data.Tables;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace ApiFunctions.Tests;

public class AiRateLimitTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 22, 10, 2, 30, TimeSpan.Zero);

    [Theory]
    [InlineData("203.0.113.5", "203.0.113.5")]
    [InlineData("203.0.113.5:4433", "203.0.113.5")]
    [InlineData("::ffff:198.51.100.7", "198.51.100.7")]
    [InlineData("[2001:db8:1:2:3:4:5:6]:443", "2001:db8:1:2::/64")]
    [InlineData("2001:db8:1:2:aaaa::1", "2001:db8:1:2::/64")]
    [InlineData("not-an-ip", null)]
    [InlineData("", null)]
    public void Normalizes_client_addresses(string candidate, string? expected) =>
        Assert.Equal(expected, AiRateLimitService.NormalizeAddress(candidate));

    [Fact]
    public void Uses_the_first_forwarded_hop_and_falls_back_to_unknown()
    {
        var headers = new HttpHeadersCollection { { "X-Forwarded-For", "198.51.100.7:1234, 10.0.0.4" } };
        Assert.Equal("198.51.100.7", AiRateLimitService.ResolveClientAddress(headers));
        Assert.Equal("unknown", AiRateLimitService.ResolveClientAddress(new HttpHeadersCollection()));
        Assert.Equal("unknown", AiRateLimitService.ResolveClientAddress(
            new HttpHeadersCollection { { "X-Forwarded-For", "<script>" } }));
    }

    [Fact]
    public async Task Per_client_window_refuses_after_the_limit_with_retry_after_until_window_end()
    {
        var store = new MemoryStore();
        var limiter = CreateLimiter(store, new AiRateLimitOptions { HelpMePerClientLimit = 2 });

        Assert.True((await limiter.CheckAsync("198.51.100.7", AiRateLimitBucket.HelpMe)).Allowed);
        Assert.True((await limiter.CheckAsync("198.51.100.7", AiRateLimitBucket.HelpMe)).Allowed);
        var refused = await limiter.CheckAsync("198.51.100.7", AiRateLimitBucket.HelpMe);

        Assert.False(refused.Allowed);
        Assert.Equal("client", refused.Scope);
        Assert.Equal(150, refused.RetryAfterSeconds); // 10:02:30 → window ends 10:05:00
        Assert.True((await limiter.CheckAsync("203.0.113.9", AiRateLimitBucket.HelpMe)).Allowed);
        Assert.True((await limiter.CheckAsync("198.51.100.7", AiRateLimitBucket.Search)).Allowed);
        Assert.DoesNotContain(store.Keys, key => key.Contains("198.51.100.7", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Global_daily_budget_refuses_every_client_until_utc_midnight()
    {
        var limiter = CreateLimiter(new MemoryStore(), new AiRateLimitOptions { SearchDailyBudget = 2 });

        Assert.True((await limiter.CheckAsync("198.51.100.1", AiRateLimitBucket.Search)).Allowed);
        Assert.True((await limiter.CheckAsync("198.51.100.2", AiRateLimitBucket.Search)).Allowed);
        var refused = await limiter.CheckAsync("198.51.100.3", AiRateLimitBucket.Search);

        Assert.False(refused.Allowed);
        Assert.Equal("daily", refused.Scope);
        Assert.Equal((int)(new DateTimeOffset(2026, 11, 23, 0, 0, 0, TimeSpan.Zero) - Now).TotalSeconds, refused.RetryAfterSeconds);
    }

    [Fact]
    public async Task Allows_requests_when_the_counter_store_is_unavailable()
    {
        var limiter = CreateLimiter(new FailingStore(), new AiRateLimitOptions());
        Assert.True((await limiter.CheckAsync("198.51.100.7", AiRateLimitBucket.HelpMe)).Allowed);
    }

    [Fact]
    public void Reads_limits_from_configuration()
    {
        var options = AiRateLimitOptions.FromConfiguration(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_RATE_LIMIT_HELPME_PER_WINDOW"] = "3",
            ["AI_RATE_LIMIT_SEARCH_PER_WINDOW"] = "7",
            ["AI_RATE_LIMIT_WINDOW_SECONDS"] = "60",
            ["AI_RATE_LIMIT_HELPME_DAILY_BUDGET"] = "11",
            ["AI_RATE_LIMIT_SEARCH_DAILY_BUDGET"] = "-1"
        }).Build());

        Assert.Equal(3, options.HelpMePerClientLimit);
        Assert.Equal(7, options.SearchPerClientLimit);
        Assert.Equal(TimeSpan.FromMinutes(1), options.Window);
        Assert.Equal(11, options.HelpMeDailyBudget);
        Assert.Equal(new AiRateLimitOptions().SearchDailyBudget, options.SearchDailyBudget);
    }

    [Fact]
    public async Task Table_store_uses_etags_so_concurrent_increments_are_never_lost()
    {
        var table = new FakeTableClient();
        var store = new TableAiRateLimitCounterStore(table);

        var counts = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ =>
            Task.Run(() => store.IncrementAsync("budget", "search-20261122", 6, Now.AddDays(1), CancellationToken.None))));

        Assert.Equal(Enumerable.Range(1, 6).Select(i => (long)i), counts.Where(count => count <= 6).Order());
        Assert.All(counts.Where(count => count > 6), count => Assert.Equal(7L, count));
        Assert.Equal(6L, table.Count("budget", "search-20261122"));
    }

    [Fact]
    public async Task HelpMe_rejects_oversized_and_overlong_requests_before_calling_ai()
    {
        var handler = CreateHelpMeHandler(new MemoryStore());

        var tooLarge = await handler.GetQuestions(Request("""{"context":"x"}""", contentLength: AiRequestGuard.MaxBodyBytes + 1));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooLarge.StatusCode);

        var streamedTooLarge = await handler.GetQuestions(Request("{\"context\":\"" + new string('x', AiRequestGuard.MaxBodyBytes) + "\"}"));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, streamedTooLarge.StatusCode);

        var longContext = await handler.GetQuestions(Request(JsonSerializer.Serialize(new { context = new string('x', AiRequestGuard.MaxContextLength + 1) })));
        Assert.Equal(HttpStatusCode.BadRequest, longContext.StatusCode);

        var tooManyAnswers = await handler.GetRecommendations(Request(JsonSerializer.Serialize(new
        {
            answers = Enumerable.Range(1, AiRequestGuard.MaxAnswers + 1).Select(i => new { questionId = i, question = "Q", answer = "A" })
        })));
        Assert.Equal(HttpStatusCode.BadRequest, tooManyAnswers.StatusCode);
    }

    [Fact]
    public async Task HelpMe_returns_429_with_retry_after_when_the_client_is_over_its_limit()
    {
        var handler = CreateHelpMeHandler(new MemoryStore(), new AiRateLimitOptions { HelpMePerClientLimit = 1 }, primeClient: true);

        var response = await handler.GetQuestions(Request("""{"context":"trail bike","cultureId":"en"}"""));

        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
        Assert.True(response.Headers.TryGetValues("Retry-After", out var retryAfter));
        Assert.Equal("150", Assert.Single(retryAfter));
        response.Body.Position = 0;
        using var body = JsonDocument.Parse(response.Body);
        Assert.Equal("rate_limited", body.RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public async Task Semantic_search_validates_size_and_applies_the_search_limit()
    {
        var store = new MemoryStore();
        var limiter = CreateLimiter(store, new AiRateLimitOptions { SearchPerClientLimit = 1 });
        await limiter.CheckAsync("198.51.100.7", AiRateLimitBucket.Search);
        var handler = new SemanticSearchFunction(NullLogger<SemanticSearchFunction>.Instance, null!, null!, null!, limiter);

        var longQuery = await handler.Run(Request(JsonSerializer.Serialize(new { query = new string('q', AiRequestGuard.MaxSearchQueryLength + 1), cultureId = "en" })));
        Assert.Equal(HttpStatusCode.BadRequest, longQuery.StatusCode);

        var badTopN = await handler.Run(Request("""{"query":"bike","cultureId":"en","topN":500}"""));
        Assert.Equal(HttpStatusCode.BadRequest, badTopN.StatusCode);

        var limited = await handler.Run(Request("""{"query":"bike","cultureId":"en"}"""));
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
    }

    [Fact]
    public async Task Search_suggestions_rejects_overlong_queries_and_applies_the_search_limit()
    {
        var limiter = CreateLimiter(new MemoryStore(), new AiRateLimitOptions { SearchPerClientLimit = 1 });
        await limiter.CheckAsync("198.51.100.7", AiRateLimitBucket.Search);
        var handler = new SearchSuggestionsFunction(NullLogger<SearchSuggestionsFunction>.Instance, null!, null!, null!, limiter);

        var longQuery = await handler.Run(Request(string.Empty, method: "GET",
            url: "https://functions.example.test/api/search/suggestions?q=" + new string('q', AiRequestGuard.MaxSuggestionQueryLength + 1)));
        Assert.Equal(HttpStatusCode.BadRequest, longQuery.StatusCode);

        var limited = await handler.Run(Request(string.Empty, method: "GET", url: "https://functions.example.test/api/search/suggestions?q=bike"));
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
    }

    private static AiRateLimitService CreateLimiter(IAiRateLimitCounterStore store, AiRateLimitOptions options) =>
        new(store, options, new FixedTimeProvider(Now), NullLogger<AiRateLimitService>.Instance);

    private static HelpMeChooseFunctions CreateHelpMeHandler(IAiRateLimitCounterStore store, AiRateLimitOptions? options = null, bool primeClient = false)
    {
        var limiter = CreateLimiter(store, options ?? new AiRateLimitOptions());
        if (primeClient)
            limiter.CheckAsync("198.51.100.7", AiRateLimitBucket.HelpMe).GetAwaiter().GetResult();
        var telemetry = new TelemetryClient(new TelemetryConfiguration { DisableTelemetry = true });
        return new HelpMeChooseFunctions(NullLogger<HelpMeChooseFunctions>.Instance, null!, telemetry, limiter);
    }

    private static HttpRequestData Request(string body, long? contentLength = null, string method = "POST",
        string url = "https://functions.example.test/api/helpme/questions")
    {
        var request = new FakeRequest(new Context(), body, method, new Uri(url));
        request.Headers.Add("X-Forwarded-For", "198.51.100.7:50123");
        if (contentLength is { } length)
            request.Headers.Add("Content-Length", length.ToString());
        return request;
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class MemoryStore : IAiRateLimitCounterStore
    {
        private readonly ConcurrentDictionary<string, long> _counts = new();
        public IEnumerable<string> Keys => _counts.Keys;

        public Task<long> IncrementAsync(string partitionKey, string rowKey, int limit, DateTimeOffset expiresAt, CancellationToken cancellationToken)
        {
            var key = partitionKey + "|" + rowKey;
            var current = _counts.GetOrAdd(key, 0);
            if (current >= limit) return Task.FromResult(current + 1);
            return Task.FromResult(_counts.AddOrUpdate(key, 1, (_, value) => value + 1));
        }
    }

    private sealed class FailingStore : IAiRateLimitCounterStore
    {
        public Task<long> IncrementAsync(string partitionKey, string rowKey, int limit, DateTimeOffset expiresAt, CancellationToken cancellationToken) =>
            throw new RequestFailedException(503, "unavailable");
    }

    private sealed class FakeTableClient : TableClient
    {
        private readonly object _gate = new();
        private readonly Dictionary<(string, string), (long Count, ETag ETag)> _rows = new();

        public long Count(string pk, string rk) { lock (_gate) return _rows[(pk, rk)].Count; }

        public override async Task<NullableResponse<T>> GetEntityIfExistsAsync<T>(string partitionKey, string rowKey,
            IEnumerable<string>? select = null, CancellationToken cancellationToken = default)
        {
            await Task.Yield();
            lock (_gate)
            {
                if (!_rows.TryGetValue((partitionKey, rowKey), out var row))
                    return new Missing<T>();
                var entity = new TableEntity(partitionKey, rowKey) { ["Count"] = row.Count, ETag = row.ETag };
                return Azure.Response.FromValue((T)(object)entity, new FakeResponse(200));
            }
        }

        public override async Task<Azure.Response> AddEntityAsync<T>(T entity, CancellationToken cancellationToken = default)
        {
            await Task.Yield();
            lock (_gate)
            {
                if (_rows.ContainsKey((entity.PartitionKey, entity.RowKey)))
                    throw new RequestFailedException(409, "exists");
                _rows[(entity.PartitionKey, entity.RowKey)] = (((TableEntity)(object)entity).GetInt64("Count")!.Value, new ETag(Guid.NewGuid().ToString()));
                return new FakeResponse(204);
            }
        }

        public override async Task<Azure.Response> UpdateEntityAsync<T>(T entity, ETag ifMatch, TableUpdateMode mode = TableUpdateMode.Merge,
            CancellationToken cancellationToken = default)
        {
            await Task.Yield();
            lock (_gate)
            {
                var key = (entity.PartitionKey, entity.RowKey);
                if (!_rows.TryGetValue(key, out var row) || row.ETag != ifMatch)
                    throw new RequestFailedException(412, "precondition failed");
                _rows[key] = (((TableEntity)(object)entity).GetInt64("Count")!.Value, new ETag(Guid.NewGuid().ToString()));
                return new FakeResponse(204);
            }
        }
    }

    private sealed class Missing<T> : NullableResponse<T>
    {
        public override bool HasValue => false;
        public override T? Value => default;
        public override Azure.Response GetRawResponse() => new FakeResponse(404);
    }

    private sealed class FakeResponse(int status) : Azure.Response
    {
        public override int Status => status;
        public override string ReasonPhrase => string.Empty;
        public override Stream? ContentStream { get; set; }
        public override string ClientRequestId { get; set; } = string.Empty;
        public override void Dispose() { }
        protected override bool ContainsHeader(string name) => false;
        protected override IEnumerable<HttpHeader> EnumerateHeaders() => [];
        protected override bool TryGetHeader(string name, [NotNullWhen(true)] out string? value) { value = null; return false; }
        protected override bool TryGetHeaderValues(string name, [NotNullWhen(true)] out IEnumerable<string>? values) { values = null; return false; }
    }

    private sealed class Context : FunctionContext
    {
        public override string InvocationId => "ai-rate-limit-test";
        public override string FunctionId => "ai-rate-limit-test";
        public override TraceContext TraceContext => null!;
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; } = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            })).BuildServiceProvider();
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
    }

    private sealed class FakeRequest(Context context, string body, string method, Uri url) : HttpRequestData(context)
    {
        public override Stream Body { get; } = new MemoryStream(Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url => url;
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => method;
        public override HttpResponseData CreateResponse() => new FunctionResponse(FunctionContext);
    }

    private sealed class FunctionResponse(FunctionContext context) : HttpResponseData(context)
    {
        public override HttpStatusCode StatusCode { get; set; }
        public override HttpHeadersCollection Headers { get; set; } = new();
        public override Stream Body { get; set; } = new MemoryStream();
        public override HttpCookies Cookies => throw new NotSupportedException();
    }
}
