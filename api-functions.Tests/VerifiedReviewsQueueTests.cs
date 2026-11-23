using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using api_functions.Functions;
using api_functions.Models;
using api_functions.Services;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.Core.Serialization;
using Azure.Data.Tables;
using Azure.Identity;
using Azure.Storage.Queues;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class VerifiedReviewsQueueTests
{
    [Fact]
    public async Task Status_read_reports_a_stale_job_without_resetting_it()
    {
        using var table = new InMemoryTableHandler();
        table.Seed(InMemoryTableHandler.VerifiedReviewsState("job-1", totalCount: 3, productsTotal: 2,
            lastProgressAt: DateTimeOffset.UtcNow.AddMinutes(-20)));
        var function = CreateFunction(table, new QueueCaptureHandler(), out _);
        using var context = new Context();

        var response = await function.GetVerifiedReviewsStatus(new Request(context, "GET"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = await Body(response);
        Assert.True(body.RootElement.GetProperty("isRunning").GetBoolean());
        Assert.True(body.RootElement.GetProperty("isStale").GetBoolean());
        Assert.Equal("job-1", body.RootElement.GetProperty("jobId").GetString());
        Assert.Equal(0, table.Writes);
    }

    [Fact]
    public async Task Start_enqueues_one_plain_json_message_per_product_without_running_generation()
    {
        using var table = new InMemoryTableHandler();
        var queue = new QueueCaptureHandler();
        var function = CreateFunction(table, queue, out _);
        using var context = new Context();

        var response = await function.StartBatchVerifiedReviews(
            new Request(context, "POST", """{"productCount":2,"reviewsPerProduct":2}"""));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using var body = await Body(response);
        var jobId = body.RootElement.GetProperty("jobId").GetString();
        Assert.False(string.IsNullOrWhiteSpace(jobId));
        Assert.Equal(3, body.RootElement.GetProperty("totalCount").GetInt32());

        var state = table.Get("verifiedreviews", "state")!;
        Assert.True(state["IsRunning"]!.GetValue<bool>());
        Assert.Equal(jobId, state["JobId"]!.GetValue<string>());

        Assert.Equal(2, queue.Messages.Count);
        var messages = queue.Messages.Select(text => JsonSerializer.Deserialize<VerifiedReviewsQueueMessage>(text)!).ToList();
        Assert.All(messages, message => Assert.Equal(jobId, message.JobId));
        Assert.All(messages, message =>
        {
            Assert.Equal(Guid.Parse(jobId!).ToString("N"), message.Telemetry?.JobId);
            Assert.NotNull(message.Telemetry?.EnqueuedAt);
            Assert.Null(message.Telemetry?.CaptureId);
        });
        Assert.Equal([42, 43], messages.Select(m => m.Product.ProductID));
        Assert.Equal([11, 12], messages[0].CustomerIds);
        Assert.All(queue.Messages, text => Assert.DoesNotContain("example.invalid", text, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(-20, HttpStatusCode.Accepted)]
    [InlineData(-1, HttpStatusCode.Conflict)]
    public async Task Start_replaces_only_a_stale_running_job(int minutesSinceProgress, HttpStatusCode expected)
    {
        using var table = new InMemoryTableHandler();
        table.Seed(InMemoryTableHandler.VerifiedReviewsState("old-job", totalCount: 1, productsTotal: 1,
            lastProgressAt: DateTimeOffset.UtcNow.AddMinutes(minutesSinceProgress)));
        var queue = new QueueCaptureHandler();
        var function = CreateFunction(table, queue, out _);
        using var context = new Context();

        var response = await function.StartBatchVerifiedReviews(new Request(context, "POST", "{}"));

        Assert.Equal(expected, response.StatusCode);
        var jobId = table.Get("verifiedreviews", "state")!["JobId"]!.GetValue<string>();
        Assert.Equal(expected == HttpStatusCode.Conflict, jobId == "old-job");
        Assert.Equal(expected == HttpStatusCode.Conflict ? 0 : 2, queue.Messages.Count);
    }

    private static GenerateVerifiedReviewsFunction CreateFunction(
        InMemoryTableHandler tableHandler, QueueCaptureHandler queueHandler, out StubReviewService reviews)
    {
        var tableOptions = new TableClientOptions { Transport = new HttpClientTransport(new HttpClient(tableHandler, false)) };
        tableOptions.Retry.MaxRetries = 0;
        var table = new TableClient(new Uri("https://unit.table.core.windows.net"), "verifiedReviewsJob",
            new StaticCredential(), tableOptions);
        var queueOptions = new QueueClientOptions
        {
            MessageEncoding = QueueMessageEncoding.Base64,
            Transport = new HttpClientTransport(new HttpClient(queueHandler))
        };
        queueOptions.Retry.MaxRetries = 0;
        var queue = new QueueClient(new Uri("https://unit.queue.core.windows.net/verified-reviews-queue"),
            new StaticCredential(), queueOptions);
        var publisher = new WebPubSubService(null, new DefaultAzureCredential(), NullLogger<WebPubSubService>.Instance);
        reviews = new StubReviewService(publisher, table);
        var telemetry = new TelemetryClient(new TelemetryConfiguration { DisableTelemetry = true });
        // Agents are unused by the HTTP routes; generation only happens in the queue trigger.
        return new GenerateVerifiedReviewsFunction(NullLogger<GenerateVerifiedReviewsFunction>.Instance,
            null!, null!, reviews, telemetry, publisher, new VerifiedReviewsQueue(queue));
    }

    private static async Task<JsonDocument> Body(HttpResponseData response)
    {
        response.Body.Position = 0;
        return await JsonDocument.ParseAsync(response.Body);
    }

    private sealed class StubReviewService(WebPubSubService publisher, TableClient table)
        : ReviewService("not-a-connection-string", "unused", publisher, table)
    {
        public override Task<List<(ProductForReviewGeneration Product, List<CustomerWithDeliveredOrder> Customers)>>
            GetBatchVerifiedReviewsDataAsync(int productCount, int reviewsPerProduct) =>
            Task.FromResult(new List<(ProductForReviewGeneration, List<CustomerWithDeliveredOrder>)>
            {
                (new ProductForReviewGeneration { ProductID = 42, Name = "Synthetic" },
                 [Customer(11), Customer(12)]),
                (new ProductForReviewGeneration { ProductID = 43, Name = "Second" }, [Customer(13)])
            });

        private static CustomerWithDeliveredOrder Customer(int id) => new()
        {
            CustomerID = id, FirstName = "Test", LastName = "Customer", EmailAddress = $"c{id}@example.invalid"
        };
    }

    private sealed class QueueCaptureHandler : HttpMessageHandler
    {
        public List<string> Messages { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            var xml = XDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            var encoded = xml.Root!.Element("MessageText")!.Value;
            // Exactly one Base64 layer (applied by the client); the decoded text must be the JSON payload.
            Messages.Add(Encoding.UTF8.GetString(Convert.FromBase64String(encoded)));
            var now = DateTimeOffset.UtcNow.ToString("R");
            return new HttpResponseMessage(HttpStatusCode.Created)
            {
                Content = new StringContent(
                    $"<?xml version=\"1.0\" encoding=\"utf-8\"?><QueueMessagesList><QueueMessage><MessageId>{Guid.NewGuid()}</MessageId>" +
                    $"<InsertionTime>{now}</InsertionTime><ExpirationTime>{now}</ExpirationTime><PopReceipt>r</PopReceipt>" +
                    $"<TimeNextVisible>{now}</TimeNextVisible></QueueMessage></QueueMessagesList>",
                    Encoding.UTF8, "application/xml")
            };
        }
    }

    private sealed class StaticCredential : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new("unit-test-token", DateTimeOffset.UtcNow.AddHours(1));

        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            })).BuildServiceProvider();

        public Context() => InstanceServices = _services;

        public override string InvocationId => "verified-reviews-test";
        public override string FunctionId => "verified-reviews-test";
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
        public override Stream Body { get; } = body is null ? Stream.Null : new MemoryStream(Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new("https://functions.example.test/api/generate-verified-reviews");
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

/// <summary>Minimal in-memory Azure Table entity endpoint: get, insert (409 on duplicates) and ETag-checked replace.</summary>
internal sealed class InMemoryTableHandler : HttpMessageHandler
{
    private static readonly Regex KeyPattern = new(@"\(PartitionKey='(?<pk>[^']*)',RowKey='(?<rk>[^']*)'\)");
    private readonly Dictionary<(string, string), (JsonObject Entity, int Version)> _rows = [];

    public int Writes { get; private set; }

    public static JsonObject VerifiedReviewsState(string jobId, int totalCount, int productsTotal,
        DateTimeOffset? lastProgressAt = null) => new()
    {
        ["PartitionKey"] = "verifiedreviews", ["RowKey"] = "state", ["IsRunning"] = true, ["JobId"] = jobId,
        ["ProductId"] = 0, ["ProductName"] = "Synthetic", ["ProcessedCount"] = 0, ["TotalCount"] = totalCount,
        ["ProductsProcessed"] = 0, ["ProductsTotal"] = productsTotal, ["CompletedReviewCount"] = 0,
        ["StartedAt"] = (lastProgressAt ?? DateTimeOffset.UtcNow).ToString("O"), ["StartedAt@odata.type"] = "Edm.DateTime",
        ["LastProgressAt"] = (lastProgressAt ?? DateTimeOffset.UtcNow).ToString("O"), ["LastProgressAt@odata.type"] = "Edm.DateTime"
    };

    public void Seed(JsonObject entity) =>
        _rows[(entity["PartitionKey"]!.GetValue<string>(), entity["RowKey"]!.GetValue<string>())] = (entity, 1);

    public JsonObject? Get(string partitionKey, string rowKey) =>
        _rows.TryGetValue((partitionKey, rowKey), out var row) ? row.Entity : null;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var match = KeyPattern.Match(Uri.UnescapeDataString(request.RequestUri!.AbsolutePath));
        var key = match.Success ? (match.Groups["pk"].Value, match.Groups["rk"].Value) : default;

        if (request.Method == HttpMethod.Get)
        {
            if (!match.Success || !_rows.TryGetValue(key, out var row))
                return Error(HttpStatusCode.NotFound, "ResourceNotFound");
            var result = row.Entity.DeepClone().AsObject();
            result["odata.etag"] = Tag(row.Version);
            return WithTag(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(result.ToJsonString(), Encoding.UTF8, "application/json")
            }, row.Version);
        }

        var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
        Writes++;
        if (request.Method == HttpMethod.Post)
        {
            key = (body["PartitionKey"]!.GetValue<string>(), body["RowKey"]!.GetValue<string>());
            if (_rows.ContainsKey(key))
                return Error(HttpStatusCode.Conflict, "EntityAlreadyExists");
            _rows[key] = (body, 1);
            return WithTag(new HttpResponseMessage(HttpStatusCode.NoContent), 1);
        }

        Assert.Equal(HttpMethod.Put, request.Method);
        var ifMatch = request.Headers.IfMatch.ToString();
        var exists = _rows.TryGetValue(key, out var current);
        if (!string.IsNullOrEmpty(ifMatch) && ifMatch != "*" && (!exists || ifMatch != Tag(current.Version)))
            return Error(HttpStatusCode.PreconditionFailed, "UpdateConditionNotSatisfied");
        body["PartitionKey"] = key.Item1;
        body["RowKey"] = key.Item2;
        var version = exists ? current.Version + 1 : 1;
        _rows[key] = (body, version);
        return WithTag(new HttpResponseMessage(HttpStatusCode.NoContent), version);
    }

    private static string Tag(int version) => $"W/\"v{version}\"";

    private static HttpResponseMessage WithTag(HttpResponseMessage response, int version)
    {
        response.Headers.TryAddWithoutValidation("ETag", Tag(version));
        return response;
    }

    private static HttpResponseMessage Error(HttpStatusCode status, string code)
    {
        var response = new HttpResponseMessage(status)
        {
            Content = new StringContent(
                new JsonObject
                {
                    ["odata.error"] = new JsonObject
                    {
                        ["code"] = code,
                        ["message"] = new JsonObject { ["lang"] = "en-US", ["value"] = code }
                    }
                }.ToJsonString(),
                Encoding.UTF8, "application/json")
        };
        response.Headers.TryAddWithoutValidation("x-ms-error-code", code);
        return response;
    }
}
