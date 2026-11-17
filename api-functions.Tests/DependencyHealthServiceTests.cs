using System.Text.Json;
using System.Net;
using api_functions.Services;
using Azure;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;
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

    [Theory]
    [InlineData(1, "healthy")]
    [InlineData(0, "unhealthy")]
    [InlineData(null, "unknown")]
    public void Sql_identity_requires_positive_current_principal_evidence(object? value, string expected)
    {
        Assert.Equal(expected, DependencyHealthService.EvaluateSqlIdentity(value).Status);
        Assert.Equal("unknown", DependencyHealthService.EvaluateSqlIdentity(DBNull.Value).Status);
        Assert.Throws<InvalidOperationException>(() => DependencyHealthService.EvaluateSqlIdentity(2));
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
        Assert.Contains(reports[0].Checks, c => c.Id == "sql-identity" && c.Status == "not-configured"
            && !c.Required);
        foreach (var id in new[] { "blob-identity", "queue-identity", "table-identity",
                     "file-identity", "webpubsub-identity" })
            Assert.Contains(reports[0].Checks, c => c.Id == id && c.Status == "not-configured" && !c.Required);
        Assert.Contains(reports[0].Checks, c => c.Id == "webpubsub-service" && c.Status == "not-configured");
        Assert.Contains(reports[0].Checks, c => c.Id == "order-emails" && c.Message.Contains("intentionally disabled"));
        Assert.DoesNotContain("connection-string", JsonSerializer.Serialize(reports[0]));
    }

    [Fact]
    public async Task Invalid_sql_identity_configuration_is_reported_without_connecting()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SQL_CONNECTION_STRING"] = "invalid connection string",
            ["AZURE_CLIENT_ID"] = "invalid client id"
        }).Build();
        var service = new DependencyHealthService(config, new DefaultAzureCredential(),
            new UnusedHttpFactory(), NullLogger<DependencyHealthService>.Instance);
        var report = await service.GetReportAsync(CancellationToken.None);
        var identity = report.Checks.Single(c => c.Id == "sql-identity");
        Assert.Equal("unhealthy", identity.Status);
        Assert.DoesNotContain("invalid client id", JsonSerializer.Serialize(identity));
    }

    [Theory]
    [InlineData("appid")]
    [InlineData("azp")]
    public async Task Runtime_identity_credential_verifies_the_token_used_by_the_sdk(string claim)
    {
        var clientId = Guid.NewGuid();
        var token = MakeToken(new Dictionary<string, object> { [claim] = clientId.ToString() });
        var credential = new SelectedIdentityCredential(new TestCredential(token), clientId);
        var context = new TokenRequestContext(["https://storage.azure.com/.default"]);
        Assert.Equal(token, credential.GetToken(context, CancellationToken.None).Token);
        Assert.Equal(token, (await credential.GetTokenAsync(context, CancellationToken.None)).Token);
        Assert.True(credential.Verified);
    }

    [Fact]
    public async Task Runtime_identity_credential_fails_closed_before_a_foreign_token_reaches_storage()
    {
        var expected = Guid.NewGuid();
        var foreign = MakeToken(new Dictionary<string, object> { ["appid"] = Guid.NewGuid().ToString() });
        var credential = new SelectedIdentityCredential(new TestCredential(foreign), expected);
        var transport = new RecordingStorageHandler();
        using var http = new HttpClient(transport);
        var options = new TableClientOptions { Transport = new HttpClientTransport(http) };
        options.Retry.MaxRetries = 0;
        var client = new TableClient(new Uri("https://example.table.core.windows.net"), "example",
            credential, options);

        await Assert.ThrowsAsync<IdentityTokenMismatchException>(() =>
            client.GetAccessPoliciesAsync(cancellationToken: CancellationToken.None));
        Assert.False(credential.Verified);
        Assert.Equal(0, transport.Calls);
    }

    [Fact]
    public async Task Runtime_identity_credential_passes_the_verified_token_to_the_storage_sdk()
    {
        var clientId = Guid.NewGuid();
        var token = MakeToken(new Dictionary<string, object> { ["appid"] = clientId.ToString() });
        var credential = new SelectedIdentityCredential(new TestCredential(token), clientId);
        var transport = new RecordingStorageHandler(HttpStatusCode.OK);
        using var http = new HttpClient(transport);
        var options = new TableClientOptions { Transport = new HttpClientTransport(http) };
        options.Retry.MaxRetries = 0;
        var client = new TableClient(new Uri("https://example.table.core.windows.net"), "example",
            credential, options);

        await client.GetAccessPoliciesAsync(cancellationToken: CancellationToken.None);
        Assert.True(credential.Verified);
        Assert.Equal(1, transport.Calls);
        Assert.Equal("Bearer", transport.AuthorizationScheme);
    }

    [Theory]
    [InlineData("malformed")]
    [InlineData("missing")]
    [InlineData("invalid")]
    [InlineData("conflicting")]
    public async Task Runtime_identity_credential_rejects_unverifiable_or_conflicting_claims(string defect)
    {
        var expected = Guid.NewGuid();
        var token = defect switch
        {
            "malformed" => "private.invalid.token",
            "missing" => MakeToken(new Dictionary<string, object>()),
            "invalid" => MakeToken(new Dictionary<string, object> { ["appid"] = "not-a-guid" }),
            _ => MakeToken(new Dictionary<string, object>
                { ["appid"] = expected.ToString(), ["azp"] = Guid.NewGuid().ToString() })
        };
        var credential = new SelectedIdentityCredential(new TestCredential(token), expected);
        var context = new TokenRequestContext(["https://storage.azure.com/.default"]);
        var error = await Assert.ThrowsAnyAsync<InvalidOperationException>(async () =>
            await credential.GetTokenAsync(context, CancellationToken.None));
        Assert.IsType(defect == "conflicting" ? typeof(IdentityTokenMismatchException)
            : typeof(UnverifiableIdentityTokenException), error);
        Assert.False(credential.Verified);
        Assert.DoesNotContain(token, error.ToString());
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

    private static string MakeToken(Dictionary<string, object> claims) =>
        Base64UrlEncoder.Encode("""{"alg":"none"}""") + "." +
        Base64UrlEncoder.Encode(JsonSerializer.Serialize(claims)) + ".AA";

    private sealed class TestCredential(string token) : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new(token, DateTimeOffset.UtcNow.AddHours(1));
        public override ValueTask<AccessToken> GetTokenAsync(
            TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class RecordingStorageHandler(HttpStatusCode status = HttpStatusCode.Forbidden) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public string? AuthorizationScheme { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            AuthorizationScheme = request.Headers.Authorization?.Scheme;
            return Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent("<?xml version=\"1.0\"?><SignedIdentifiers/>")
            });
        }
    }
}
