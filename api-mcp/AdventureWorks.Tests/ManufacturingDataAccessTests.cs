using System.Net;
using System.Text;
using AdventureWorks.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace AdventureWorks.Tests;

public class ManufacturingDataAccessTests
{
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

    private sealed class WorkflowHandler : HttpMessageHandler
    {
        public List<(HttpMethod Method, string Path)> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((request.Method, request.RequestUri!.AbsolutePath));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"message\":\"Stopped.\"}", Encoding.UTF8, "application/json"),
            });
        }
    }
}
