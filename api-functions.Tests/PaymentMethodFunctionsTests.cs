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

    [Theory]
    [InlineData(71)]
    [InlineData(72)]
    public async Task Create_links_a_masked_card_to_the_signed_consumer_only(int owner)
    {
        var store = new Store();
        using var context = new Context(owner);
        var request = new Request(context, "POST",
            $$"""{"cardType":"Vista","last4":"4242","expMonth":12,"expYear":{{DateTime.UtcNow.Year + 2}}}""");
        request.Headers.Add("X-MS-CLIENT-PRINCIPAL-ID", "999");
        var response = await new PaymentMethodFunctions(store, NullLogger<PaymentMethodFunctions>.Instance)
            .CreatePaymentMethod(request, context);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal(owner, store.Owner);
        Assert.Equal("************4242", store.Saved!.MaskedCardNumber);
        Assert.True(store.Saved.MaskedCardNumber.Length <= 25);
    }

    [Theory]
    [InlineData(null, true, "consumer")]
    [InlineData(71, false, "consumer")]
    [InlineData(71, true, "internal")]
    [InlineData(71, true, "service")]
    public async Task Create_requires_a_signed_consumer(int? owner, bool authenticated, string category)
    {
        var store = new Store();
        using var context = new Context(owner, authenticated, category);
        var response = await new PaymentMethodFunctions(store, NullLogger<PaymentMethodFunctions>.Instance)
            .CreatePaymentMethod(new Request(context, "POST", "{}"), context);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(store.Saved);
    }

    [Theory]
    [InlineData("""{"cardType":"Vista","last4":"4242","expMonth":12,"expYear":2099,"cardNumber":"4242424242424242"}""")]
    [InlineData("""{"cardType":"Vista","last4":"4242424242424242","expMonth":12,"expYear":2040}""")]
    [InlineData("""{"cardType":"Vista","last4":"42a2","expMonth":12,"expYear":2040}""")]
    [InlineData("""{"cardType":"Visa","last4":"4242","expMonth":12,"expYear":2040}""")]
    [InlineData("""{"cardType":"Vista","last4":"4242","expMonth":13,"expYear":2040}""")]
    [InlineData("""{"cardType":"Vista","last4":"4242","expMonth":"12","expYear":2040}""")]
    [InlineData("""{"cardType":"Vista","last4":"4242","expMonth":1,"expYear":2020}""")]
    [InlineData("""[]""")]
    [InlineData("""{""")]
    public async Task Create_rejects_full_numbers_and_invalid_cards_before_storage(string body)
    {
        var store = new Store();
        using var context = new Context(71);
        var response = await new PaymentMethodFunctions(store, NullLogger<PaymentMethodFunctions>.Instance)
            .CreatePaymentMethod(new Request(context, "POST", body), context);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(store.Saved);
    }

    [Fact]
    public void Expiry_in_the_current_month_is_accepted_but_last_month_is_not()
    {
        var now = new DateTimeOffset(2030, 6, 15, 0, 0, 0, TimeSpan.Zero);
        using var current = JsonDocument.Parse("""{"cardType":"ColonialVoice","last4":"0005","expMonth":6,"expYear":2030}""");
        using var expired = JsonDocument.Parse("""{"cardType":"ColonialVoice","last4":"0005","expMonth":5,"expYear":2030}""");
        Assert.NotNull(PaymentMethodFunctions.TryParseCard(current.RootElement, now, out _));
        Assert.Null(PaymentMethodFunctions.TryParseCard(expired.RootElement, now, out var error));
        Assert.NotNull(error);
    }

    private sealed class Store : IPaymentMethodService
    {
        public int? Owner { get; private set; }
        public NewPaymentCard? Saved { get; private set; }
        public Task<IReadOnlyList<SavedPaymentCard>> GetForPersonAsync(int businessEntityId)
        {
            Owner = businessEntityId;
            return Task.FromResult<IReadOnlyList<SavedPaymentCard>>([new(1, "Vista", "1234", 12, 2030)]);
        }

        public Task<SavedPaymentCard> AddForPersonAsync(int businessEntityId, NewPaymentCard card)
        {
            Owner = businessEntityId;
            Saved = card;
            return Task.FromResult(new SavedPaymentCard(5, card.CardType, card.Last4, card.ExpMonth, card.ExpYear));
        }
    }

    private sealed class FailingStore : IPaymentMethodService
    {
        public Task<IReadOnlyList<SavedPaymentCard>> GetForPersonAsync(int businessEntityId) =>
            throw new InvalidOperationException("Synthetic storage failure.");
        public Task<SavedPaymentCard> AddForPersonAsync(int businessEntityId, NewPaymentCard card) =>
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

    private sealed class Request(FunctionContext context, string method = "GET", string? body = null) : HttpRequestData(context)
    {
        public override Stream Body { get; } = body is null ? Stream.Null : new MemoryStream(System.Text.Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new("https://functions.example.test/api/payment-methods?businessEntityId=999");
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
