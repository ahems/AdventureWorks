using System.Diagnostics;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using api_functions.Functions;
using api_functions.Services;
using Azure.Core.Serialization;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Channel;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace ApiFunctions.Tests;

public class HelpMeChoosePublicContractTests
{
    [Fact]
    public void Public_requests_do_not_bind_caller_customer_or_foundry_response_ids()
    {
        var questions = JsonSerializer.Deserialize<HelpMeQuestionsRequest>(
            """{"context":"mountain bike","cultureId":"en","customerId":29825,"previousThreadId":"resp-private"}""");
        var recommendations = JsonSerializer.Deserialize<HelpMeRecommendRequest>(
            """{"answers":[{"questionId":1,"question":"Use?","answer":"Trail"}],"customerId":29825,"previousThreadId":"resp-private"}""");

        Assert.NotNull(questions);
        Assert.NotNull(recommendations);
        Assert.DoesNotContain(typeof(HelpMeQuestionsRequest).GetProperties(),
            property => property.Name is "CustomerId" or "PreviousThreadId");
        Assert.DoesNotContain(typeof(HelpMeRecommendRequest).GetProperties(),
            property => property.Name is "CustomerId" or "PreviousThreadId");
    }

    [Fact]
    public void Public_responses_do_not_expose_foundry_response_ids()
    {
        var questions = JsonSerializer.Serialize(new WizardQuestionsResponse
        {
            SessionId = "opaque-local-session",
            Questions = []
        });
        var recommendations = JsonSerializer.Serialize(new RecommendationsResponse());

        Assert.DoesNotContain("threadId", questions, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("threadId", recommendations, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Public_handler_correlates_worker_telemetry_to_the_host_trace(bool questions)
    {
        const string traceId = "8d454f22361140e8b3f05a33c8f11d1f";
        const string traceParent = "00-" + traceId + "-0123456789abcdef-01";
        var channel = new Channel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        telemetry.TelemetryInitializers.Add(new OperationCorrelationTelemetryInitializer());
        var client = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SQL_CONNECTION_STRING"] = "unused",
            ["AI_AGENT_HELP_ME_CHOOSE_ID"] = "agent"
        }).Build();
        var service = new HelpMeChooseService(NullLogger<HelpMeChooseService>.Instance, config, null!, client);
        var limiter = new AiRateLimitService(new AllowAllStore(), new AiRateLimitOptions(), TimeProvider.System,
            NullLogger<AiRateLimitService>.Instance);
        var handler = new HelpMeChooseFunctions(NullLogger<HelpMeChooseFunctions>.Instance, service, client, limiter);
        using var context = new Context(traceParent);
        using var outer = new Activity("unrelated").SetIdFormat(ActivityIdFormat.W3C).Start();

        var response = questions
            ? await handler.GetQuestions(new Request(context))
            : await handler.GetRecommendations(new Request(context));

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var exception = Assert.Single(channel.Items.OfType<ExceptionTelemetry>());
        Assert.Equal(traceId, exception.Context.Operation.Id);
        Assert.Same(outer, Activity.Current);
    }

    [Fact]
    public async Task Chat_handler_correlates_worker_telemetry_to_the_host_trace()
    {
        const string traceId = "8d454f22361140e8b3f05a33c8f11d1f";
        const string traceParent = "00-" + traceId + "-0123456789abcdef-01";
        var channel = new Channel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        telemetry.TelemetryInitializers.Add(new OperationCorrelationTelemetryInitializer());
        var client = new TelemetryClient(telemetry);
        var handler = new AIAgentFunctions(NullLogger<AIAgentFunctions>.Instance, null!, client, null!);
        using var context = new Context(traceParent);
        using var outer = new Activity("unrelated").SetIdFormat(ActivityIdFormat.W3C).Start();

        var response = await handler.Chat(new Request(context));

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var exception = Assert.Single(channel.Items.OfType<ExceptionTelemetry>());
        Assert.Equal(traceId, exception.Context.Operation.Id);
        Assert.Same(outer, Activity.Current);
    }

    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            })).BuildServiceProvider();

        public Context(string traceParent)
        {
            TraceContext = new Trace(traceParent);
            InstanceServices = _services;
        }

        public override string InvocationId => "helpme-test";
        public override string FunctionId => "helpme-test";
        public override TraceContext TraceContext { get; }
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
        public void Dispose() => _services.Dispose();
    }

    private sealed class Trace(string traceParent) : TraceContext
    {
        public override string TraceParent => traceParent;
        public override string TraceState => string.Empty;
        public override IReadOnlyDictionary<string, string> Attributes { get; } = new Dictionary<string, string>();
    }

    private sealed class Request(Context context) : HttpRequestData(context)
    {
        public override Stream Body { get; } = new MemoryStream(Encoding.UTF8.GetBytes("{"));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url => new("https://functions.example.test/api/helpme");
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => "POST";
        public override HttpResponseData CreateResponse() => new Response(FunctionContext);
    }

    private sealed class Response(FunctionContext context) : HttpResponseData(context)
    {
        public override HttpStatusCode StatusCode { get; set; }
        public override HttpHeadersCollection Headers { get; set; } = new();
        public override Stream Body { get; set; } = new MemoryStream();
        public override HttpCookies Cookies => throw new NotSupportedException();
    }

    private sealed class AllowAllStore : IAiRateLimitCounterStore
    {
        public Task<long> IncrementAsync(string partitionKey, string rowKey, int limit, DateTimeOffset expiresAt, CancellationToken cancellationToken) =>
            Task.FromResult(1L);
    }

    private sealed class Channel : ITelemetryChannel
    {
        public List<ITelemetry> Items { get; } = [];
        public bool? DeveloperMode { get; set; }
        public string? EndpointAddress { get; set; }
        public void Send(ITelemetry item) => Items.Add(item);
        public void Flush() { }
        public void Dispose() { }
    }
}
