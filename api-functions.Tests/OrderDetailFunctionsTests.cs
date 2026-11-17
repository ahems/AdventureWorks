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

public sealed class OrderDetailFunctionsTests
{
    private readonly Store _store = new();
    private OrderDetailFunctions Functions => new(NullLogger<OrderDetailFunctions>.Instance, _store);

    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Consumer_order_detail_uses_the_validated_customer_claim(int owner)
    {
        using var context = new Context("consumer", owner);
        var request = new Request(context,
            """{"productId":5,"orderQty":2,"unitPrice":10.25,"unitPriceDiscount":0.1,"customerId":99}""");
        request.Headers.Add("X-MS-API-ROLE", "executive-admin");
        var response = await Functions.CreateOrderDetail(
            request, 123, context);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal((123, owner), _store.LastOwner);
        Assert.Equal(new CreateOrderDetailRequest(5, 2, 10.25m, 0.1m), _store.LastRequest);
    }

    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Other_owner_order_is_denied_without_a_success_response(int owner)
    {
        _store.Created = false;
        using var context = new Context("consumer", owner);
        var response = await Functions.CreateOrderDetail(
            new Request(context, """{"productId":5,"orderQty":2,"unitPrice":10.25,"unitPriceDiscount":0}"""),
            456,
            context);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal((456, owner), _store.LastOwner);
    }

    [Theory]
    [InlineData("anonymous", false, 7)]
    [InlineData("consumer", true, null)]
    [InlineData("consumer", true, 0)]
    [InlineData("consumer", true, -1)]
    [InlineData("consumer", false, 7)]
    [InlineData("unknown", true, 7)]
    public async Task Untrusted_or_ownerless_user_is_denied_before_storage(
        string category,
        bool authenticated,
        int? customerId)
    {
        using var context = new Context(category, customerId, authenticated);
        var response = await Functions.CreateOrderDetail(
            new Request(context, """{"productId":5,"orderQty":2,"unitPrice":10.25,"unitPriceDiscount":0}"""),
            123,
            context);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(_store.LastOwner);
    }

    [Theory]
    [InlineData("""{"productId":0,"orderQty":1,"unitPrice":1,"unitPriceDiscount":0}""")]
    [InlineData("""{"productId":5,"orderQty":0,"unitPrice":1,"unitPriceDiscount":0}""")]
    [InlineData("""{"productId":5,"orderQty":1,"unitPrice":1,"unitPriceDiscount":1.1}""")]
    [InlineData("{")]
    public async Task Invalid_payload_never_reaches_order_storage(string body)
    {
        using var context = new Context("consumer", 7);
        var response = await Functions.CreateOrderDetail(new Request(context, body), 123, context);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(_store.LastOwner);
    }

    [Fact]
    public async Task Internal_user_can_write_without_consumer_owner_filter()
    {
        using var context = new Context("employee", 99);
        var response = await Functions.CreateOrderDetail(
            new Request(context, """{"productId":5,"orderQty":2,"unitPrice":10.25,"unitPriceDiscount":0}"""),
            123,
            context);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal((123, (int?)null), _store.LastOwner);
    }

    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Consumer_reads_only_signed_owner_even_with_forged_inputs(int owner)
    {
        using var context = new Context("consumer", owner);
        _store.ReadResult = [new(123, 5, 2, 10.25m, 0.1m, 18.45m, "Fixture product")];
        var request = new Request(context, "", "?orderIds=123,124&customerId=99");
        request.Headers.Add("X-MS-API-ROLE", "executive-admin");

        var response = await Functions.GetOwnedOrderDetails(request, context);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(owner, _store.ReadOwner);
        Assert.Equal(new[] { 123, 124 }, _store.ReadIds);
        response.Body.Position = 0;
        using var body = await JsonDocument.ParseAsync(response.Body);
        var line = Assert.Single(body.RootElement.EnumerateArray());
        Assert.Equal(123, line.GetProperty("salesOrderId").GetInt32());
        Assert.Equal("Fixture product", line.GetProperty("productName").GetString());
    }

    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Consumer_cannot_read_other_or_mixed_orders(int owner)
    {
        using var context = new Context("consumer", owner);
        _store.ReadResult = null;
        foreach (var query in new[] { "?orderIds=456", "?orderIds=123,456" })
        {
            var response = await Functions.GetOwnedOrderDetails(new Request(context, "", query), context);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal(owner, _store.ReadOwner);
            response.Body.Position = 0;
            using var body = await JsonDocument.ParseAsync(response.Body);
            Assert.Equal("Order access is not allowed.", body.RootElement.GetProperty("error").GetString());
        }
    }

    [Theory]
    [InlineData("consumer", true, null)]
    [InlineData("consumer", true, 0)]
    [InlineData("consumer", true, -1)]
    [InlineData("consumer", false, 7)]
    [InlineData("unknown", true, 7)]
    public async Task Untrusted_or_ownerless_read_never_reaches_storage(
        string category, bool authenticated, int? customerId)
    {
        using var context = new Context(category, customerId, authenticated);
        var response = await Functions.GetOwnedOrderDetails(
            new Request(context, "", "?orderIds=123"), context);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(_store.ReadIds);
    }

    [Theory]
    [InlineData("")]
    [InlineData("?orderIds=")]
    [InlineData("?orderIds=0")]
    [InlineData("?orderIds=-1")]
    [InlineData("?orderIds=1,1")]
    [InlineData("?orderIds=1,,2")]
    [InlineData("?orderIds=1,%202")]
    [InlineData("?orderIds=2147483648")]
    [InlineData("?orderIds=1&orderIds=2")]
    public async Task Invalid_read_batch_never_reaches_storage(string query)
    {
        using var context = new Context("consumer", 7);
        var response = await Functions.GetOwnedOrderDetails(new Request(context, "", query), context);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(_store.ReadIds);
    }

    [Fact]
    public async Task Read_batch_accepts_100_order_ids_but_rejects_101()
    {
        using var context = new Context("consumer", 7);
        var valid = "?orderIds=" + string.Join(",", Enumerable.Range(1, 100));
        var response = await Functions.GetOwnedOrderDetails(new Request(context, "", valid), context);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(100, _store.ReadIds!.Count);

        var otherStore = new Store();
        var functions = new OrderDetailFunctions(NullLogger<OrderDetailFunctions>.Instance, otherStore);
        var invalid = "?orderIds=" + string.Join(",", Enumerable.Range(1, 101));
        response = await functions.GetOwnedOrderDetails(new Request(context, "", invalid), context);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(otherStore.ReadIds);
    }

    [Fact]
    public async Task Internal_read_remains_unrestricted_by_consumer_owner()
    {
        using var context = new Context("employee", 99);
        var response = await Functions.GetOwnedOrderDetails(
            new Request(context, "", "?orderIds=123"), context);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(_store.ReadOwner);
        Assert.Equal(new[] { 123 }, _store.ReadIds);
    }

    private sealed class Store : IOrderDetailService
    {
        public bool Created { get; set; } = true;
        public (int OrderId, int? OwnerId)? LastOwner { get; private set; }
        public CreateOrderDetailRequest? LastRequest { get; private set; }
        public IReadOnlyList<OrderDetailRead>? ReadResult { get; set; } = [];
        public IReadOnlyCollection<int>? ReadIds { get; private set; }
        public int? ReadOwner { get; private set; }

        public Task<bool> CreateAsync(int salesOrderId, int? ownerCustomerId, CreateOrderDetailRequest request)
        {
            LastOwner = (salesOrderId, ownerCustomerId);
            LastRequest = request;
            return Task.FromResult(Created);
        }

        public Task<IReadOnlyList<OrderDetailRead>?> ReadAsync(
            IReadOnlyCollection<int> salesOrderIds, int? ownerCustomerId)
        {
            ReadIds = salesOrderIds;
            ReadOwner = ownerCustomerId;
            return Task.FromResult(ReadResult);
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

        public Context(string category, int? customerId, bool authenticated = true)
        {
            InstanceServices = _services;
            Items[FunctionUser.ContextKey] = new FunctionUser
            {
                IsAuthenticated = authenticated,
                Category = category,
                CustomerId = customerId,
            };
        }

        public override string InvocationId => "order-detail-test";
        public override string FunctionId => "order-detail-test";
        public override TraceContext TraceContext => throw new NotSupportedException();
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
        public void Dispose() => _services.Dispose();
    }

    private sealed class Request(FunctionContext context, string body, string query = "") : HttpRequestData(context)
    {
        public override Stream Body { get; } = new MemoryStream(Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new("https://functions.example.test/api/orders/details" + query);
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
