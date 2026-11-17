using System.Net;
using System.Security.Claims;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.Functions;
using api_functions.Services;
using Azure.Core.Serialization;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class PaymentMethodFunctionsTests
{
    [Theory]
    [InlineData(71)]
    [InlineData(72)]
    public async Task Reads_only_the_signed_person_even_with_foreign_query_and_headers(int owner)
    {
        var store = new Store();
        using var context = new Context(owner);
        var request = new Request(context);
        request.Headers.Add("X-MS-CLIENT-PRINCIPAL-ID", "999");
        request.Headers.Add("X-MS-API-ROLE", "executive-admin");
        var handler = new PaymentMethodFunctions(store, NullLogger<PaymentMethodFunctions>.Instance);
        var response = await handler.GetPaymentMethods(request, context);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(owner, store.Owner);
        response.Body.Position = 0;
        using var body = await JsonDocument.ParseAsync(response.Body);
        var card = Assert.Single(body.RootElement.EnumerateArray());
        Assert.Equal("1234", card.GetProperty("last4").GetString());
        Assert.Equal(new[] { "cardType", "expMonth", "expYear", "id", "last4" },
            card.EnumerateObject().Select(property => property.Name).Order());
    }

    [Theory]
    [InlineData(null, true, "consumer")]
    [InlineData(0, true, "consumer")]
    [InlineData(-1, true, "consumer")]
    [InlineData(71, false, "consumer")]
    [InlineData(71, true, "unknown")]
    [InlineData(null, true, "service")]
    public async Task Untrusted_or_unbound_people_never_read_storage(int? owner, bool authenticated, string category)
    {
        var store = new Store();
        using var context = new Context(owner, authenticated, category);
        var response = await new PaymentMethodFunctions(store, NullLogger<PaymentMethodFunctions>.Instance)
            .GetPaymentMethods(new Request(context), context);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(store.Owner);
    }

    [Fact]
    public async Task Storage_failure_is_not_reported_as_an_empty_payment_list()
    {
        using var context = new Context(71);
        var handler = new PaymentMethodFunctions(new FailingStore(), NullLogger<PaymentMethodFunctions>.Instance);
        await Assert.ThrowsAsync<InvalidOperationException>(() => handler.GetPaymentMethods(new Request(context), context));
    }

    private sealed class Store : IPaymentMethodService
    {
        public int? Owner { get; private set; }
        public Task<IReadOnlyList<SavedPaymentCard>> GetForPersonAsync(int businessEntityId)
        {
            Owner = businessEntityId;
            return Task.FromResult<IReadOnlyList<SavedPaymentCard>>([new(1, "Vista", "1234", 12, 2030)]);
        }
    }

    private sealed class FailingStore : IPaymentMethodService
    {
        public Task<IReadOnlyList<SavedPaymentCard>> GetForPersonAsync(int businessEntityId) =>
            throw new InvalidOperationException("Synthetic storage failure.");
    }

    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            })).BuildServiceProvider();

        public Context(int? owner, bool authenticated = true, string category = "consumer")
        {
            InstanceServices = _services;
            Items[FunctionUser.ContextKey] = new FunctionUser
            {
                IsAuthenticated = authenticated, Category = category, BusinessEntityId = owner,
            };
        }

        public override string InvocationId => "payment-test";
        public override string FunctionId => "payment-test";
        public override TraceContext TraceContext => throw new NotSupportedException();
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
        public void Dispose() => _services.Dispose();
    }

    private sealed class Request(FunctionContext context) : HttpRequestData(context)
    {
        public override Stream Body { get; } = Stream.Null;
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new("https://functions.example.test/api/payment-methods?businessEntityId=999");
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => "GET";
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
