using System.Net;
using System.Security.Claims;
using System.Text;
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

public sealed class OrderHeaderFunctionsTests
{
    private readonly Store _store = new();
    private OrderHeaderFunctions Functions => new(NullLogger<OrderHeaderFunctions>.Instance, _store);
    private const string Valid = """
        {"billToAddressId":101,"shipToAddressId":102,"shipMethodId":5,"subTotal":10.25,"taxAmt":1,"freight":2,"customerId":999,"businessEntityId":999}
        """;

    [Theory]
    [InlineData(7, 71)]
    [InlineData(8, 72)]
    public async Task Consumer_header_uses_signed_customer_and_person_not_forged_inputs(int customer, int person)
    {
        using var context = new Context("consumer", customer, person);
        var request = new Request(context, Valid);
        request.Headers.Add("X-MS-API-ROLE", "executive-admin");
        var response = await Functions.CreateOrderHeader(request, context);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal((customer, person), _store.Owner);
        Assert.Equal(101, _store.Request!.BillToAddressId);
        Assert.Equal(102, _store.Request.ShipToAddressId);
        response.Body.Position = 0;
        using var body = await JsonDocument.ParseAsync(response.Body);
        Assert.Equal(123, body.RootElement.GetProperty("salesOrderId").GetInt32());
    }

    [Theory]
    [InlineData(7, 71)]
    [InlineData(8, 72)]
    public async Task Foreign_address_or_customer_binding_returns_denial(int customer, int person)
    {
        _store.Result = null;
        using var context = new Context("consumer", customer, person);
        var response = await Functions.CreateOrderHeader(new Request(context, Valid), context);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal((customer, person), _store.Owner);
    }

    [Theory]
    [InlineData("anonymous", false, 7, 71)]
    [InlineData("consumer", false, 7, 71)]
    [InlineData("unknown", true, 7, 71)]
    [InlineData("consumer", true, null, 71)]
    [InlineData("consumer", true, 0, 71)]
    [InlineData("consumer", true, -1, 71)]
    [InlineData("consumer", true, 7, null)]
    [InlineData("consumer", true, 7, 0)]
    [InlineData("consumer", true, 7, -1)]
    public async Task Untrusted_or_unbound_caller_never_reaches_storage(
        string category, bool authenticated, int? customer, int? person)
    {
        using var context = new Context(category, customer, person, authenticated);
        var response = await Functions.CreateOrderHeader(new Request(context, Valid), context);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(_store.Owner);
    }

    [Theory]
    [InlineData("{")]
    [InlineData("null")]
    [InlineData("""{"billToAddressId":0,"shipToAddressId":102,"shipMethodId":5}""")]
    [InlineData("""{"billToAddressId":101,"shipToAddressId":0,"shipMethodId":5}""")]
    [InlineData("""{"billToAddressId":101,"shipToAddressId":102,"shipMethodId":0}""")]
    [InlineData("""{"billToAddressId":101,"shipToAddressId":102,"shipMethodId":5,"subTotal":-1}""")]
    [InlineData("""{"billToAddressId":101,"shipToAddressId":102,"shipMethodId":5,"subTotal":922337203685477.5808}""")]
    [InlineData("""{"billToAddressId":101,"shipToAddressId":102,"shipMethodId":5,"subTotal":922337203685477.5807,"freight":1}""")]
    public async Task Invalid_payload_never_reaches_storage(string payload)
    {
        using var context = new Context("consumer", 7, 71);
        var response = await Functions.CreateOrderHeader(new Request(context, payload), context);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(_store.Owner);
    }

    [Fact]
    public async Task Internal_caller_can_supply_a_customer_person_pair_for_validation()
    {
        using var context = new Context("employee", null, null);
        var response = await Functions.CreateOrderHeader(new Request(context, Valid), context);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal((999, 999), _store.Owner);
    }

    [Fact]
    public async Task Internal_caller_without_explicit_owner_pair_is_denied()
    {
        using var context = new Context("employee", null, null);
        var response = await Functions.CreateOrderHeader(new Request(context,
            """{"billToAddressId":101,"shipToAddressId":102,"shipMethodId":5}"""), context);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(_store.Owner);
    }

    private sealed class Store : IOrderHeaderService
    {
        public int? Result { get; set; } = 123;
        public (int Customer, int Person)? Owner { get; private set; }
        public CreateOrderHeaderRequest? Request { get; private set; }
        public Task<int?> CreateAsync(int customerId, int businessEntityId, CreateOrderHeaderRequest request)
        {
            Owner = (customerId, businessEntityId);
            Request = request;
            return Task.FromResult(Result);
        }
    }

    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            }))
            .BuildServiceProvider();

        public Context(string category, int? customerId, int? businessEntityId, bool authenticated = true)
        {
            InstanceServices = _services;
            Items[FunctionUser.ContextKey] = new FunctionUser
            {
                IsAuthenticated = authenticated,
                Category = category,
                CustomerId = customerId,
                BusinessEntityId = businessEntityId
            };
        }
        public override string InvocationId => "order-header-test";
        public override string FunctionId => "order-header-test";
        public override TraceContext TraceContext => throw new NotSupportedException();
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
        public void Dispose() => _services.Dispose();
    }

    private sealed class Request(FunctionContext context, string body) : HttpRequestData(context)
    {
        public override Stream Body { get; } = new MemoryStream(Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new("https://functions.example.test/api/orders");
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
}
