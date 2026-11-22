using System.Net;
using System.Security.Claims;
using System.Text;
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

public sealed class CheckoutPricingCalculatorTests
{
    private static readonly DiscountCodeInfo Save10 = new("SAVE10", "10% off", DiscountCodeType.Percent, 0.10m);
    private static readonly DiscountCodeInfo FreeShip = new("FREESHIP", "Free shipping", DiscountCodeType.FreeShipping, 0m);

    [Fact]
    public void Sale_and_code_discounts_combine_multiplicatively_and_record_the_sale_offer()
    {
        var pricing = CheckoutPricingCalculator.Calculate(
            [(new CheckoutProductPrice(1, 100m, 16, 0.20m), (short)2), (new CheckoutProductPrice(2, 10m, 1, 0m), (short)1)],
            Save10, taxRatePercent: 5m, shipBase: 4m);

        var sale = pricing.Lines[0];
        Assert.Equal(0.28m, sale.UnitPriceDiscount);
        Assert.Equal(16, sale.SpecialOfferId);
        Assert.Equal(100m, sale.UnitPrice);
        Assert.Equal(144m, sale.LineTotal);
        Assert.Equal(1, pricing.Lines[1].SpecialOfferId);
        Assert.Equal(0.10m, pricing.Lines[1].UnitPriceDiscount);

        Assert.Equal(210m, pricing.ListSubTotal);
        Assert.Equal(40m, pricing.SaleDiscount);
        Assert.Equal(17m, pricing.CodeDiscount);
        Assert.Equal(153m, pricing.SubTotal);
        Assert.Equal(0.05m, pricing.TaxRate);
        Assert.Equal(7.65m, pricing.TaxAmt);
        Assert.Equal(0m, pricing.Freight);
        Assert.Equal(160.65m, pricing.TotalDue);
    }

    [Fact]
    public void Store_order_lines_are_priced_from_the_catalogue_offer_only()
    {
        var lines = OrderGenerationService.PriceStoreOrderLines(
            [new StoreOrderLineItem { ProductId = 1, Quantity = 3 }, new StoreOrderLineItem { ProductId = 2, Quantity = 1 }],
            [new CheckoutProductPrice(1, 200m, 9, 0.15m), new CheckoutProductPrice(2, 40m, 1, 0m)]);

        Assert.Equal(new PricedCheckoutLine(1, 3, 200m, 0.15m, 9, 510m), lines[0]);
        Assert.Equal(new PricedCheckoutLine(2, 1, 40m, 0m, 1, 40m), lines[1]);
    }

    [Fact]
    public void Store_order_lines_reject_products_that_are_not_for_sale()
    {
        var error = Assert.Throws<InvalidOperationException>(() => OrderGenerationService.PriceStoreOrderLines(
            [new StoreOrderLineItem { ProductId = 7, Quantity = 1 }], []));
        Assert.Contains("7", error.Message);
    }

    [Fact]
    public void Orders_at_or_under_the_threshold_pay_freight_and_default_tax()
    {
        var pricing = CheckoutPricingCalculator.Calculate(
            [(new CheckoutProductPrice(1, 50m, 1, 0m), (short)1)], null, taxRatePercent: null, shipBase: null);

        Assert.Equal(CheckoutPricingCalculator.DefaultShipBase, pricing.Freight);
        Assert.Equal(CheckoutPricingCalculator.DefaultTaxRate, pricing.TaxRate);
        Assert.Equal(4m, pricing.TaxAmt);
        Assert.Equal(63.99m, pricing.TotalDue);
    }

    [Fact]
    public void Freeship_code_removes_freight_without_discounting_lines()
    {
        var pricing = CheckoutPricingCalculator.Calculate(
            [(new CheckoutProductPrice(1, 20m, 1, 0m), (short)1)], FreeShip, 8m, 7.5m);

        Assert.Equal(0m, pricing.Freight);
        Assert.Equal(20m, pricing.SubTotal);
        Assert.Equal(0m, pricing.CodeDiscount);
    }

    [Fact]
    public void Display_totals_convert_usd_values_with_the_currency_rate()
    {
        var pricing = CheckoutPricingCalculator.Calculate(
            [(new CheckoutProductPrice(1, 20m, 1, 0m), (short)1)], null, 10m, 5m);

        var display = CheckoutPricingCalculator.ToDisplay(pricing, new CheckoutCurrencyRate(9, "EUR", 0.9m));

        Assert.Equal("EUR", display.CurrencyCode);
        Assert.Equal(18m, display.SubTotal);
        Assert.Equal(1.8m, display.TaxAmt);
        Assert.Equal(4.5m, display.Freight);
        Assert.Equal(24.3m, display.TotalDue);
    }

    [Theory]
    [InlineData(0, 1, "lines")]
    [InlineData(1, 0, "quantity")]
    [InlineData(1, 1000, "quantity")]
    public void Validator_rejects_bad_lines(int lineCount, int quantity, string _)
    {
        var lines = Enumerable.Range(1, lineCount).Select(i => new CheckoutLineRequest(i, quantity)).ToList();
        Assert.NotNull(CheckoutRequestValidator.Validate(new CheckoutRequest(lines, 1, 1, 5), placingOrder: true));
    }

    [Fact]
    public void Validator_requires_addresses_only_when_placing_an_order()
    {
        var request = new CheckoutRequest([new(1, 1)], DiscountCode: " save10 ", DisplayCurrency: "eur");
        Assert.Null(CheckoutRequestValidator.Validate(request, placingOrder: false));
        Assert.NotNull(CheckoutRequestValidator.Validate(request, placingOrder: true));
        Assert.NotNull(CheckoutRequestValidator.Validate(request with { DiscountCode = "bad code!" }, false));
        Assert.NotNull(CheckoutRequestValidator.Validate(
            new CheckoutRequest([new(1, 1), new(1, 2)], 1, 1, 5), placingOrder: true));
    }
}

public sealed class CheckoutServiceTests
{
    private readonly FakeStore _store = new();
    private CheckoutService Service => new(_store);

    private static CheckoutRequest Order(string? code = null, string currency = "USD") =>
        new([new(1, 2)], BillToAddressId: 11, ShipToAddressId: 11, ShipMethodId: 5, DiscountCode: code, DisplayCurrency: currency);

    [Fact]
    public async Task Place_order_prices_server_side_inserts_once_and_commits()
    {
        _store.Session.Codes["SAVE10"] = new("SAVE10", "10% off", DiscountCodeType.Percent, 0.10m);
        _store.Session.Rates["EUR"] = new(42, "EUR", 0.9m);

        var outcome = await Service.PlaceOrderAsync(30, 20, Order("save10", "EUR"));

        Assert.Equal(CheckoutFailure.None, outcome.Failure);
        Assert.Equal(900, outcome.Result!.SalesOrderId);
        Assert.Equal(72m, outcome.Result.Pricing.SubTotal);
        Assert.Equal("EUR", outcome.Result.Display.CurrencyCode);
        var insert = Assert.Single(_store.Session.Inserts);
        Assert.Equal((30, 11, 11, 5, (int?)42), (insert.CustomerId, insert.Bill, insert.Ship, insert.ShipMethod, insert.RateId));
        Assert.True(_store.Session.Committed);
        Assert.True(_store.Session.Disposed);
        Assert.True(_store.ForWrite);
    }

    [Fact]
    public async Task Quote_never_inserts_or_commits()
    {
        var outcome = await Service.QuoteAsync(20, new CheckoutRequest([new(1, 1)]));

        Assert.Equal(CheckoutFailure.None, outcome.Failure);
        Assert.Null(outcome.Result!.SalesOrderId);
        Assert.Empty(_store.Session.Inserts);
        Assert.False(_store.Session.Committed);
        Assert.False(_store.ForWrite);
    }

    [Fact]
    public async Task Unknown_discount_code_is_rejected_server_side()
    {
        var outcome = await Service.QuoteAsync(20, new CheckoutRequest([new(1, 1)], DiscountCode: "SAVE99"));

        Assert.Equal(CheckoutFailure.InvalidDiscountCode, outcome.Failure);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task Foreign_customer_or_address_is_forbidden(bool customerOwned, bool addressOwned)
    {
        _store.Session.CustomerOwned = customerOwned;
        _store.Session.AddressOwned = addressOwned;

        var outcome = await Service.PlaceOrderAsync(30, 20, Order());

        Assert.Equal(CheckoutFailure.Forbidden, outcome.Failure);
        Assert.Empty(_store.Session.Inserts);
        Assert.False(_store.Session.Committed);
    }

    [Fact]
    public async Task Unavailable_product_is_rejected()
    {
        _store.Session.Products.Clear();

        var outcome = await Service.PlaceOrderAsync(30, 20, Order());

        Assert.Equal(CheckoutFailure.UnavailableProduct, outcome.Failure);
        Assert.Empty(_store.Session.Inserts);
    }

    [Fact]
    public async Task Insert_failure_is_not_committed_and_the_transaction_is_disposed()
    {
        _store.Session.FailInsert = true;

        await Assert.ThrowsAsync<InvalidOperationException>(() => Service.PlaceOrderAsync(30, 20, Order()));

        Assert.False(_store.Session.Committed);
        Assert.True(_store.Session.Disposed);
    }

    internal sealed class FakeStore : ICheckoutStore
    {
        public FakeSession Session { get; } = new();
        public bool ForWrite { get; private set; }
        public Task<ICheckoutSession> BeginAsync(bool forWrite)
        {
            ForWrite = forWrite;
            return Task.FromResult<ICheckoutSession>(Session);
        }
    }

    internal sealed class FakeSession : ICheckoutSession
    {
        public bool CustomerOwned { get; set; } = true;
        public bool AddressOwned { get; set; } = true;
        public bool FailInsert { get; set; }
        public bool Committed { get; private set; }
        public bool Disposed { get; private set; }
        public Dictionary<int, CheckoutProductPrice> Products { get; } = new() { [1] = new(1, 40m, 1, 0m) };
        public Dictionary<string, DiscountCodeInfo> Codes { get; } = new();
        public Dictionary<string, CheckoutCurrencyRate> Rates { get; } = new();
        public List<(int CustomerId, int Bill, int Ship, int ShipMethod, int? RateId)> Inserts { get; } = [];
        public List<int> OwnershipChecks { get; } = [];

        public Task<bool> CustomerBelongsToAsync(int customerId, int businessEntityId)
        {
            OwnershipChecks.Add(businessEntityId);
            return Task.FromResult(CustomerOwned);
        }
        public Task<bool> AddressBelongsToAsync(int addressId, int businessEntityId)
        {
            OwnershipChecks.Add(businessEntityId);
            return Task.FromResult(AddressOwned);
        }
        public Task<decimal?> GetShipBaseAsync(int shipMethodId) => Task.FromResult<decimal?>(3.95m);
        public Task<decimal?> GetTaxRatePercentAsync(int shipToAddressId) => Task.FromResult<decimal?>(null);
        public Task<IReadOnlyList<CheckoutProductPrice>> GetProductPricesAsync(IReadOnlyCollection<int> productIds) =>
            Task.FromResult<IReadOnlyList<CheckoutProductPrice>>(
                productIds.Where(Products.ContainsKey).Select(id => Products[id]).ToList());
        public Task<DiscountCodeInfo?> GetDiscountCodeAsync(string code) =>
            Task.FromResult(Codes.GetValueOrDefault(code));
        public Task<CheckoutCurrencyRate?> GetCurrencyRateAsync(string currencyCode) =>
            Task.FromResult(Rates.GetValueOrDefault(currencyCode));
        public Task<int> InsertOrderAsync(int customerId, int billToAddressId, int shipToAddressId, int shipMethodId,
            int? currencyRateId, CheckoutPricing pricing)
        {
            if (FailInsert)
                throw new InvalidOperationException("detail insert failed");
            Inserts.Add((customerId, billToAddressId, shipToAddressId, shipMethodId, currencyRateId));
            return Task.FromResult(900);
        }
        public void Commit() => Committed = true;
        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }
}

public sealed class CheckoutFunctionsTests
{
    private readonly CheckoutServiceTests.FakeStore _store = new();
    private CheckoutFunctions Functions => new(NullLogger<CheckoutFunctions>.Instance, new CheckoutService(_store));

    private const string Body = """{"lines":[{"productId":1,"quantity":1}],"billToAddressId":11,"shipToAddressId":11,"shipMethodId":5,"customerId":999,"unitPrice":0.01}""";

    [Theory]
    [InlineData(30, 20)]
    [InlineData(31, 21)]
    public async Task Consumer_places_order_bound_to_signed_customer_and_ignores_forged_fields(int customer, int person)
    {
        using var context = new FunctionTestContext("consumer", customerId: customer, businessEntityId: person);

        var response = await Functions.PlaceCheckoutOrder(new FunctionTestRequest(context, Body), context);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal(customer, Assert.Single(_store.Session.Inserts).CustomerId);
        Assert.All(_store.Session.OwnershipChecks, owner => Assert.Equal(person, owner));
        Assert.NotEmpty(_store.Session.OwnershipChecks);
        using var json = await ReadJsonAsync(response);
        Assert.Equal(900, json.RootElement.GetProperty("salesOrderId").GetInt32());
        Assert.Equal(40m, json.RootElement.GetProperty("subTotal").GetDecimal());
    }

    [Theory]
    [InlineData(30, 20)]
    [InlineData(31, 21)]
    public async Task Foreign_address_or_customer_binding_returns_denial(int customer, int person)
    {
        _store.Session.AddressOwned = false;
        using var context = new FunctionTestContext("consumer", customer, person);

        var response = await Functions.PlaceCheckoutOrder(new FunctionTestRequest(context, Body), context);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Empty(_store.Session.Inserts);
        Assert.False(_store.Session.Committed);
    }

    [Theory]
    [InlineData("employee", 30, 20)]
    [InlineData("consumer", null, 20)]
    [InlineData("consumer", 30, null)]
    public async Task Non_consumer_or_unbound_tokens_cannot_place_orders(string category, int? customerId, int? businessEntityId)
    {
        using var context = new FunctionTestContext(category, customerId, businessEntityId);

        var response = await Functions.PlaceCheckoutOrder(new FunctionTestRequest(context, Body), context);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Empty(_store.Session.Inserts);
    }

    [Fact]
    public async Task Quote_returns_invalid_discount_reason()
    {
        using var context = new FunctionTestContext("consumer", 30, 20);
        var body = """{"lines":[{"productId":1,"quantity":1}],"discountCode":"NOPE"}""";

        var response = await Functions.QuoteCheckout(new FunctionTestRequest(context, body), context);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        using var json = await ReadJsonAsync(response);
        Assert.Equal("invalid-discount-code", json.RootElement.GetProperty("reason").GetString());
    }

    internal static async Task<JsonDocument> ReadJsonAsync(HttpResponseData response)
    {
        response.Body.Position = 0;
        return await JsonDocument.ParseAsync(response.Body);
    }
}

public sealed class OrderCancelFunctionsTests
{
    private readonly FakeCancellation _cancellation = new();
    private readonly Publisher _publisher = new();
    private OrderCancelFunctions Functions => new(NullLogger<OrderCancelFunctions>.Instance, _cancellation, _publisher);

    [Theory]
    [InlineData(OrderCancelResult.Cancelled, HttpStatusCode.OK)]
    [InlineData(OrderCancelResult.NotFound, HttpStatusCode.NotFound)]
    [InlineData(OrderCancelResult.NotCancellable, HttpStatusCode.Conflict)]
    public async Task Internal_caller_gets_transition_result(OrderCancelResult result, HttpStatusCode expected)
    {
        _cancellation.Result = result;
        using var context = new FunctionTestContext("employee", null, null);

        var response = await Functions.CancelOrder(new FunctionTestRequest(context, ""), 123, context);

        Assert.Equal(expected, response.StatusCode);
        Assert.Equal(123, _cancellation.LastId);
        if (result == OrderCancelResult.Cancelled)
        {
            var (group, payload) = Assert.Single(_publisher.Events);
            Assert.Equal("orders", group);
            Assert.DoesNotContain("123", payload.GetRawText());
        }
        else
        {
            Assert.Empty(_publisher.Events);
        }
    }

    [Fact]
    public async Task Consumer_cannot_cancel_orders()
    {
        using var context = new FunctionTestContext("consumer", 30, 20);

        var response = await Functions.CancelOrder(new FunctionTestRequest(context, ""), 123, context);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(_cancellation.LastId);
    }

    [Theory]
    [InlineData(true, (byte)6, OrderCancelResult.Cancelled)]
    [InlineData(false, null, OrderCancelResult.NotFound)]
    [InlineData(false, (byte)4, OrderCancelResult.NotCancellable)]
    [InlineData(false, (byte)5, OrderCancelResult.NotCancellable)]
    [InlineData(false, (byte)6, OrderCancelResult.NotCancellable)]
    [InlineData(false, (byte)7, OrderCancelResult.NotCancellable)]
    public void Classify_maps_sql_outcome(bool cancelled, byte? status, OrderCancelResult expected)
    {
        Assert.Equal(expected, OrderCancellationService.Classify(cancelled, status).Result);
    }

    [Fact]
    public void Only_open_statuses_are_cancellable()
    {
        Assert.Equal(new byte[] { 1, 2, 3 }, OrderCancellationService.CancellableStatuses.Order());
    }

    private sealed class FakeCancellation : IOrderCancellationService
    {
        public OrderCancelResult Result { get; set; }
        public int? LastId { get; private set; }
        public Task<(OrderCancelResult Result, byte? Status)> CancelAsync(int salesOrderId)
        {
            LastId = salesOrderId;
            return Task.FromResult<(OrderCancelResult, byte?)>((Result, Result == OrderCancelResult.Cancelled ? (byte)6 : (byte)5));
        }
    }

    private sealed class Publisher() : WebPubSubService(null, new DefaultAzureCredential(), NullLogger<WebPubSubService>.Instance)
    {
        public List<(string Group, JsonElement Payload)> Events { get; } = [];
        public override Task SendToGroupAsync(string group, object payload)
        {
            Events.Add((group, JsonSerializer.SerializeToElement(WebPubSubService.SanitizePayloadForGroup(group, payload))));
            return Task.CompletedTask;
        }
    }
}

public sealed class OrderPipelineTransitionTests
{
    [Theory]
    [InlineData(101, 3, 7)]
    [InlineData(102, 3, 7)]
    [InlineData(103, 5, 10)]
    [InlineData(104, 5, 5)]
    [InlineData(105, 8, 2)]
    public void Delivery_threshold_stays_within_the_configured_window(int orderId, int min, int max)
    {
        var days = OrderService.DeliveryThresholdDays(orderId, min, max);
        var (lo, hi) = OrderService.NormalizeDeliveryWindow(min, max);

        Assert.InRange(days, lo, hi);
        Assert.Equal(days, OrderService.DeliveryThresholdDays(orderId, min, max));
    }

    [Fact]
    public void Delivery_thresholds_spread_across_the_window()
    {
        var thresholds = Enumerable.Range(1000, 50).Select(id => OrderService.DeliveryThresholdDays(id, 3, 7)).ToHashSet();
        Assert.Equal(new[] { 3, 4, 5, 6, 7 }, thresholds.Order());
    }

    [Theory]
    [InlineData(4, new byte[] { 1 })]
    [InlineData(5, new byte[] { 1, 2, 3 })]
    [InlineData(6, null)]
    [InlineData(7, null)]
    public void Terminal_queue_messages_only_apply_from_eligible_statuses(int status, byte[]? expected)
    {
        Assert.Equal(expected, ProcessSalesOrderStatus.ExpectedStatusesForTerminal(status)?.ToArray());
    }
}

internal sealed class FunctionTestContext : FunctionContext, IDisposable
{
    private readonly ServiceProvider _services = new ServiceCollection()
        .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
        {
            Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
        }))
        .BuildServiceProvider();

    public FunctionTestContext(string category, int? customerId, int? businessEntityId)
    {
        InstanceServices = _services;
        Items[FunctionUser.ContextKey] = new FunctionUser
        {
            IsAuthenticated = true,
            Category = category,
            CustomerId = customerId,
            BusinessEntityId = businessEntityId,
        };
    }

    public override string InvocationId => "checkout-test";
    public override string FunctionId => "checkout-test";
    public override TraceContext TraceContext => throw new NotSupportedException();
    public override BindingContext BindingContext => throw new NotSupportedException();
    public override RetryContext RetryContext => null!;
    public override IServiceProvider InstanceServices { get; set; }
    public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
    public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
    public override IInvocationFeatures Features => throw new NotSupportedException();
    public void Dispose() => _services.Dispose();
}

internal sealed class FunctionTestRequest(FunctionContext context, string body) : HttpRequestData(context)
{
    public override Stream Body { get; } = new MemoryStream(Encoding.UTF8.GetBytes(body));
    public override HttpHeadersCollection Headers { get; } = new();
    public override IReadOnlyCollection<IHttpCookie> Cookies => [];
    public override Uri Url { get; } = new("https://functions.example.test/api/orders/checkout");
    public override IEnumerable<ClaimsIdentity> Identities => [];
    public override string Method => "POST";
    public override HttpResponseData CreateResponse() => new FunctionTestResponse(FunctionContext);
}

internal sealed class FunctionTestResponse(FunctionContext context) : HttpResponseData(context)
{
    public override HttpStatusCode StatusCode { get; set; }
    public override HttpHeadersCollection Headers { get; set; } = new();
    public override Stream Body { get; set; } = new MemoryStream();
    public override HttpCookies Cookies => throw new NotSupportedException();
}
