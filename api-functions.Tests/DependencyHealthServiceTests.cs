using System.Text.Json;
using System.Net;
using api_functions.Services;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class DependencyHealthServiceTests
{
    private static readonly NullLogger Logger = NullLogger.Instance;

    [Fact]
    public async Task Failure_returns_sanitized_status_not_exception_or_secrets()
    {
        var probe = new DependencyProbe("sql", "SQL", "services", true,
            _ => throw new InvalidOperationException("secret connection-string"));
        var result = await DependencyHealthService.RunProbeAsync(probe, Logger, CancellationToken.None);
        Assert.Equal("unhealthy", result.Status);
        Assert.DoesNotContain("secret", JsonSerializer.Serialize(result));
        Assert.Contains("Application Insights", result.Message);
    }

    [Fact]
    public async Task Unresponsive_probe_reaches_timeout_state()
    {
        var probe = new DependencyProbe("sql", "SQL", "services", true,
            async ct => { await Task.Delay(Timeout.Infinite, ct); return ("healthy", "done"); });
        var result = await DependencyHealthService.RunProbeAsync(probe, Logger, CancellationToken.None,
            TimeSpan.FromMilliseconds(20));
        Assert.Equal("timeout", result.Status);
    }

    [Fact]
    public async Task Caller_cancellation_is_not_cached_as_a_dependency_failure()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var probe = new DependencyProbe("sql", "SQL", "services", true,
            async ct => { await Task.Delay(Timeout.Infinite, ct); return ("healthy", "done"); });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            DependencyHealthService.RunProbeAsync(probe, Logger, cancelled.Token));
    }

    [Fact]
    public void Optional_unconfigured_capabilities_do_not_fail_core_availability()
    {
        var report = new DependencyHealthReport(DateTimeOffset.UtcNow, [
            new("sql", "SQL", "services", true, "healthy", "OK", 1),
            new("email", "Email", "capabilities", false, "not-configured", "Missing", 1)
        ]);
        Assert.Equal("healthy", report.Status);
        Assert.Equal("unhealthy", new DependencyHealthReport(report.CheckedAt, [
            report.Checks[0] with { Status = "not-configured" }
        ]).Status);
    }

    [Fact]
    public async Task Missing_configuration_is_explicit_and_report_is_cached()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection().Build();
        var service = new DependencyHealthService(config, new DefaultAzureCredential(),
            new UnusedHttpFactory(), NullLogger<DependencyHealthService>.Instance);
        var reports = await Task.WhenAll(service.GetReportAsync(CancellationToken.None),
            service.GetReportAsync(CancellationToken.None));
        Assert.Same(reports[0], reports[1]);
        Assert.Equal("unhealthy", reports[0].Status);
        Assert.Contains(reports[0].Checks, c => c.Id == "sql" && c.Status == "not-configured");
        Assert.Contains(reports[0].Checks, c => c.Id == "webpubsub-service" && c.Status == "not-configured");
        Assert.Contains(reports[0].Checks, c => c.Id == "order-emails" && c.Message.Contains("intentionally disabled"));
        Assert.DoesNotContain("connection-string", JsonSerializer.Serialize(reports[0]));
    }

    [Theory]
    [InlineData(200, true)]
    [InlineData(200, false)]
    [InlineData(404, true)]
    [InlineData(401, true)]
    [InlineData(503, true)]
    public async Task Mcp_checks_require_success_and_valid_dependency_and_discovery_payloads(
        int httpStatus, bool validPayload)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["MCP_SERVICE_URL"] = "https://mcp.test/mcp/"
        }).Build();
        var factory = new McpHttpFactory(httpStatus, validPayload);
        var service = new DependencyHealthService(config, new DefaultAzureCredential(),
            factory, NullLogger<DependencyHealthService>.Instance);
        var report = await service.GetReportAsync(CancellationToken.None);
        var expected = httpStatus == 200 && validPayload ? "healthy" : "unhealthy";
        Assert.Equal(expected, report.Checks.Single(c => c.Id == "mcp-ready").Status);
        Assert.Equal(expected, report.Checks.Single(c => c.Id == "oauth").Status);
        Assert.Equal(3, factory.Calls);
        await service.GetReportAsync(CancellationToken.None);
        Assert.Equal(3, factory.Calls);
    }

    private class McpHttpFactory(int httpStatus, bool validPayload) : IHttpClientFactory
    {
        public int Calls { get; private set; }
        public HttpClient CreateClient(string name) => new(new Handler(this, httpStatus, validPayload));

        private class Handler(McpHttpFactory factory, int status, bool valid) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                factory.Calls++;
                var body = request.RequestUri!.AbsolutePath switch
                {
                    "/health" => "Healthy",
                    "/ready" when valid => """{"status":"healthy","checks":[{"id":"sql","status":"healthy"},{"id":"tasks","status":"healthy"}]}""",
                    "/.well-known/oauth-authorization-server" when valid =>
                        """{"issuer":"https://mcp.test","token_endpoint":"https://mcp.test/token","authorization_endpoint":"https://mcp.test/authorize","jwks_uri":"https://mcp.test/jwks","code_challenge_methods_supported":["S256"]}""",
                    _ => """{"status":"healthy"}"""
                };
                return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status)
                {
                    Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json")
                });
            }
        }
    }

    private class UnusedHttpFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => throw new InvalidOperationException("No HTTP should run without config.");
    }
}
