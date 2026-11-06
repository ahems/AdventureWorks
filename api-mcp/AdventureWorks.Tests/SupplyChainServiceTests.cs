using System.Net;
using System.Text;
using AdventureWorks.Services;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AdventureWorks.Tests;

[Collection(OAuthServerCollection.Name)]
public class SupplyChainServiceTests(OAuthTestFactory factory) : IClassFixture<OAuthTestFactory>
{
    private const string Quote = """
        {"vendorId":"1580","vendorName":"Litware","productId":1,"productName":"Adjustable Race",
         "qtyRequested":1,"stockAvailable":36,"unitCost":47.87,"shippingCost":9.74,
         "totalCost":57.61,"leadTimeDays":17,"minOrderQty":1,"maxOrderQty":5}
        """;

    [Theory]
    [InlineData(null, "api/supply/catalog")]
    [InlineData(1, "api/supply/catalog/1")]
    public async Task Catalog_uses_actual_unit_cost_not_missing_unit_price(int? productId, string path)
    {
        var (service, handler) = Create($"[{Quote}]");
        var result = await service.GetSupplyCatalogAsync(productId);
        Assert.EndsWith(path, handler.Path);
        Assert.Contains("47.8700", result);
        Assert.DoesNotContain("$0.0000", result);
        Assert.Contains("Litware (1580) | 36", result);
    }

    [Fact]
    public async Task Quote_preserves_price_and_order_constraints_without_inventing_discounts()
    {
        var (service, _) = Create(Quote);
        var result = await service.GetQuoteAsync("1580", 1);
        Assert.Contains("47.8700", result);
        Assert.Contains("Min order qty: 1", result);
        Assert.Contains("Max order qty: 5", result);
        Assert.Contains("Stock available: 36", result);
        Assert.DoesNotContain("Discount applied:", result);
    }

    [Fact]
    public async Task Catalog_does_not_turn_errors_or_missing_prices_into_successful_data()
    {
        var (denied, _) = Create("{}", HttpStatusCode.Forbidden);
        await Assert.ThrowsAsync<HttpRequestException>(() => denied.GetSupplyCatalogAsync());
        var (invalid, _) = Create("{}");
        await Assert.ThrowsAsync<System.Text.Json.JsonException>(() => invalid.GetSupplyCatalogAsync());
        var (missingPrice, _) = Create("[{\"productId\":1}]");
        await Assert.ThrowsAsync<KeyNotFoundException>(() => missingPrice.GetSupplyCatalogAsync());
    }

    [Fact]
    public async Task Vendors_use_actual_summary_component_counts()
    {
        var (service, _) = Create("""
            [{"vendor":{"vendorId":"1580","name":"Litware","creditRating":1,"activeFlag":true,
             "preferredVendorStatus":true},"totalComponents":4,"inStockComponents":3}]
            """);
        var result = await service.GetVendorsAsync();
        Assert.Contains("Components supplied: 4 | In stock: 3", result);
        Assert.DoesNotContain("Active:", result);
    }

    [Theory]
    [InlineData(nameof(SupplyChainService))]
    [InlineData(nameof(ManufacturingService))]
    public async Task Real_planning_pipeline_allows_slow_reads_and_never_retries_mutations(string clientName)
    {
        using var handler = new SlowWorkflowHandler();
        using var app = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            services.AddHttpClient(clientName).ConfigurePrimaryHttpMessageHandler(() => handler)));
        using var http = app.Services.GetRequiredService<IHttpClientFactory>().CreateClient(clientName);

        Assert.Equal(Timeout.InfiniteTimeSpan, http.Timeout);
        using var read = await http.GetAsync("api/supply/catalog");
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);
        using var mutation = await http.PostAsync("api/supply/order", new StringContent("{}"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, mutation.StatusCode);
        Assert.Equal(1, handler.Reads);
        Assert.Equal(1, handler.Mutations);
    }

    [Fact]
    public void Supply_http_budget_allows_cold_initialization_without_replaying_mutations()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "azure.yaml")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var source = File.ReadAllText(Path.Combine(directory.FullName, "api-mcp/AdventureWorks/Program.cs"));
        Assert.Contains("AddPlanningClient<ManufacturingService>();", source);
        Assert.Contains("AddPlanningClient<SupplyChainService>();", source);
        var registration = source.Split("void AddPlanningClient<TService>()", 2)[1]
            .Split("AddHttpClient<BankService>", 2)[0];
        Assert.Contains("RemoveAllResilienceHandlers()", registration);
        Assert.Contains("AttemptTimeout.Timeout = TimeSpan.FromSeconds(90)", registration);
        Assert.Contains("TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(90)", registration);
        Assert.Contains("Retry.ShouldHandle = _ => ValueTask.FromResult(false)", registration);
    }

    private static (SupplyChainService Service, Handler Handler) Create(string body, HttpStatusCode status = HttpStatusCode.OK)
    {
        var handler = new Handler(body, status);
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://functions.example.test/") };
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:AdventureWorks"] = "unused",
        }).Build();
        return (new SupplyChainService(http, config), handler);
    }

    private sealed class Handler(string body, HttpStatusCode status) : HttpMessageHandler
    {
        public string? Path { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Path = request.RequestUri?.AbsolutePath;
            return Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class SlowWorkflowHandler : HttpMessageHandler
    {
        public int Reads { get; private set; }
        public int Mutations { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get)
            {
                Reads++;
                await Task.Delay(TimeSpan.FromSeconds(11), cancellationToken);
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("[]") };
            }

            Mutations++;
            return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
        }
    }
}
