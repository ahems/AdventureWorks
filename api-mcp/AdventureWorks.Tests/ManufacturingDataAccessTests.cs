using System.Net;
using System.Text;
using System.Text.Json;
using AdventureWorks.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace AdventureWorks.Tests;

public class ManufacturingDataAccessTests
{
    [Fact]
    public void Manufacturing_order_context_includes_store_only_customers_and_product_ids()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "azure.yaml")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var source = File.ReadAllText(Path.Combine(directory.FullName, "api-mcp/AdventureWorks/Services/OrderService.cs"));
        var details = source.Split("public async Task<string> GetOrderDetailsAsync(", 2)[1]
            .Split("public async Task<string> FindComplementaryProductsAsync(", 2)[0];
        Assert.Contains("LEFT JOIN Person.Person", details);
        Assert.Contains("LEFT JOIN Sales.Store", details);
        Assert.DoesNotContain("INNER JOIN Person.Person", details);
        Assert.Contains("COALESCE(store.Name, c.FirstName + ' ' + c.LastName)", details);
        Assert.Contains("(@CustomerId IS NULL OR cust.CustomerID = @CustomerId)", details);
        Assert.Contains("sod.ProductID", details);
        Assert.Contains("item.ProductID", details);
        Assert.Contains("WHEN soh.Status = 7 THEN 'Delivered'", details);
    }

    private static IConfiguration Configuration() =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:AdventureWorks"] = "invalid-connection-string",
        }).Build();

    [Fact]
    public async Task Sql_reads_surface_database_errors_without_calling_removed_functions()
    {
        using var handler = new WorkflowHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://functions.invalid/") };
        var manufacturing = new ManufacturingService(http, Configuration());
        var supply = new SupplyChainService(http, Configuration());

        await Assert.ThrowsAsync<ArgumentException>(() => manufacturing.GetActiveOperationsAsync());
        await Assert.ThrowsAsync<ArgumentException>(() => supply.GetOrdersAsync());
        await Assert.ThrowsAsync<ArgumentException>(() => supply.GetOrdersAsync(includeHistory: true));
        await Assert.ThrowsAsync<ArgumentException>(() => supply.GetOrderAsync("1"));
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData("ORD-ABC123")]
    [InlineData("-1")]
    [InlineData("0")]
    [InlineData("1 OR 1=1")]
    public async Task Order_detail_requires_a_positive_sql_id(string orderId)
    {
        using var handler = new WorkflowHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://functions.invalid/") };
        var supply = new SupplyChainService(http, Configuration());

        var error = await Assert.ThrowsAsync<ArgumentException>(() => supply.GetOrderAsync(orderId));
        Assert.Equal("orderId", error.ParamName);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Stop_and_cancellation_remain_functions_workflows()
    {
        using var handler = new WorkflowHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://functions.invalid/") };
        var manufacturing = new ManufacturingService(http, Configuration());
        var supply = new SupplyChainService(http, Configuration());

        Assert.Equal("Stopped.", await manufacturing.StopManufacturingAsync());
        Assert.Contains("cancelled", await supply.CancelOrderAsync("1"));
        Assert.Equal(new[]
        {
            (HttpMethod.Post, "/api/manufacturing/stop"),
            (HttpMethod.Delete, "/api/supply/order/1"),
        }, handler.Requests);
    }

    [Theory]
    [InlineData(249, true)]
    [InlineData(2, true)]
    [InlineData(1, false)]
    [InlineData(0, false)]
    [InlineData(-1, true)]
    public async Task Feasibility_maps_actual_contract_and_exposes_component_ids(int maximum, bool canMeet)
    {
        var body = JsonSerializer.Serialize(new
        {
            productId = 838, name = "HL Road Frame - Black, 44", requestedQty = 2,
            maxProducibleNow = maximum, maxProducibleWithProcurement = 300,
            procurementCostToMeetRequest = 47.87m,
            components = new[]
            {
                new { productId = 484, name = "Metal Sheet 7", requiredForQty = 8,
                    currentStock = 4, canSupportUnits = 1, shortfallForQty = 4, isBottleneck = true },
            },
        });
        using var handler = new WorkflowHandler(body);
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://functions.invalid/") };
        var service = new ManufacturingService(http, Configuration());
        var result = await service.GetFeasibilityAsync(838, 2);

        Assert.Contains("Product: HL Road Frame - Black, 44", result);
        Assert.Contains("Requested Qty: 2", result);
        Assert.Contains($"Can Meet Request: {canMeet}", result);
        Assert.Contains("Max Producible With Procurement: 300", result);
        Assert.Contains("Procurement Cost To Meet Request: $47.87", result);
        Assert.Contains("Metal Sheet 7 (ProductID 484): need 8, available 4, shortfall 4", result);
        Assert.Contains("bottleneck: True", result);
        Assert.Equal("/api/plan/feasibility/838", Assert.Single(handler.Requests).Path);
    }

    [Fact]
    public async Task Feasibility_does_not_fabricate_results_when_contract_or_request_fails()
    {
        using var invalidHandler = new WorkflowHandler("{}");
        using var invalidHttp = new HttpClient(invalidHandler) { BaseAddress = new Uri("https://functions.invalid/") };
        var invalid = new ManufacturingService(invalidHttp, Configuration());
        await Assert.ThrowsAsync<KeyNotFoundException>(() => invalid.GetFeasibilityAsync(838));

        using var deniedHandler = new WorkflowHandler("{}", HttpStatusCode.Forbidden);
        using var deniedHttp = new HttpClient(deniedHandler) { BaseAddress = new Uri("https://functions.invalid/") };
        var denied = new ManufacturingService(deniedHttp, Configuration());
        await Assert.ThrowsAsync<HttpRequestException>(() => denied.GetFeasibilityAsync(838));
    }

    private sealed class WorkflowHandler(
        string body = "{\"message\":\"Stopped.\"}",
        HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        public List<(HttpMethod Method, string Path)> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((request.Method, request.RequestUri!.AbsolutePath));
            return Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
        }
    }
}
