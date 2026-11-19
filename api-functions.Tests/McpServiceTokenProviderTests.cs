using System.Net;
using System.Text;
using Azure.Core;
using api_functions.Services;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class McpServiceTokenProviderTests
{
    [Theory]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/mcp", true)]
    [InlineData("https://mcp.test/mcp/", "https://MCP.TEST:443/mcp", true)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/mcp/", true)]
    [InlineData("http://localhost:5000/mcp", "http://localhost:5000/mcp", true)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/other", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/mcp/other", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/mcp//", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/MCP", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/a/../mcp", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/a/%2e%2e/mcp", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/mcp%2fother", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/mcp?x=1", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test/mcp#fragment", false)]
    [InlineData("https://mcp.test/mcp", "https://user@mcp.test/mcp", false)]
    [InlineData("https://mcp.test/mcp", "https://@mcp.test/mcp", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test\\@evil.test/mcp", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test:444/mcp", false)]
    [InlineData("https://mcp.test/mcp", "https://mcp.test.evil.test/mcp", false)]
    [InlineData("https://mcp.test/mcp", "http://mcp.test/mcp", false)]
    [InlineData("https://mcp.test/mcp?x=1", "https://mcp.test/mcp", false)]
    [InlineData("https://user@mcp.test/mcp", "https://mcp.test/mcp", false)]
    [InlineData("http://mcp.test/mcp", "http://mcp.test/mcp", false)]
    public void Mcp_server_matching_requires_the_exact_safe_endpoint(
        string configuredUrl, string targetUrl, bool expected)
    {
        using var handler = new TokenHandler();
        var provider = new McpServiceTokenProvider(
            new TestCredential(), new TestHttpClientFactory(handler),
            NullLogger<McpServiceTokenProvider>.Instance, configuredUrl);

        Assert.Equal(expected, provider.IsMcpServer(targetUrl));
    }

    [Theory]
    [InlineData("https://mcp.test/mcp?x=1")]
    [InlineData("https://user@mcp.test/mcp")]
    [InlineData("http://mcp.test/mcp")]
    public async Task Unsafe_configuration_never_requests_an_assertion_or_service_token(string configuredUrl)
    {
        using var handler = new TokenHandler();
        var credential = new TestCredential();
        var provider = new McpServiceTokenProvider(
            credential, new TestHttpClientFactory(handler),
            NullLogger<McpServiceTokenProvider>.Instance, configuredUrl);

        Assert.Null(await provider.GetTokenAsync(
            [McpServiceTokenProvider.ProductsReadScope], CancellationToken.None));
        Assert.Equal(0, credential.Calls);
        Assert.Empty(handler.RequestBodies);
    }

    [Fact]
    public async Task Requested_scopes_are_sent_and_cached_separately()
    {
        using var handler = new TokenHandler();
        var factory = new TestHttpClientFactory(handler);
        var provider = new McpServiceTokenProvider(
            new TestCredential(),
            factory,
            NullLogger<McpServiceTokenProvider>.Instance,
            "https://mcp.test/mcp");

        var productToken = await provider.GetTokenAsync(
            [McpServiceTokenProvider.ProductsReadScope], CancellationToken.None);
        var cachedProductToken = await provider.GetTokenAsync(
            [McpServiceTokenProvider.ProductsReadScope], CancellationToken.None);
        var adminToken = await provider.GetTokenAsync(
            [McpServiceTokenProvider.AdminWriteScope], CancellationToken.None);

        Assert.Equal("service-token-1", productToken);
        Assert.Equal(productToken, cachedProductToken);
        Assert.Equal("service-token-2", adminToken);
        Assert.Equal(2, handler.RequestBodies.Count);
        Assert.All(factory.ClientNames, name => Assert.Equal(nameof(McpServiceTokenProvider), name));
        Assert.Equal(2, factory.ClientNames.Count);
        Assert.Equal("mcp.access products.read", FormScope(handler.RequestBodies[0]));
        Assert.Equal("admin.write mcp.access", FormScope(handler.RequestBodies[1]));
    }

    [Fact]
    public async Task Provider_rejects_a_token_with_broader_or_missing_granted_scopes()
    {
        using var handler = new TokenHandler
        {
            GrantedScopeOverride = "mcp.access products.read customers.read",
        };
        var provider = new McpServiceTokenProvider(
            new TestCredential(),
            new TestHttpClientFactory(handler),
            NullLogger<McpServiceTokenProvider>.Instance,
            "https://mcp.test/mcp");

        Assert.Null(await provider.GetTokenAsync(
            [McpServiceTokenProvider.ProductsReadScope], CancellationToken.None));
    }

    [Fact]
    public async Task Provider_accepts_omitted_scope_when_token_endpoint_grants_the_requested_scopes()
    {
        using var handler = new TokenHandler { OmitGrantedScope = true };
        var provider = new McpServiceTokenProvider(
            new TestCredential(),
            new TestHttpClientFactory(handler),
            NullLogger<McpServiceTokenProvider>.Instance,
            "https://mcp.test/mcp");

        Assert.Equal(
            "service-token-1",
            await provider.GetTokenAsync([McpServiceTokenProvider.ProductsReadScope], CancellationToken.None));
    }

    [Theory]
    [InlineData("missing-type")]
    [InlineData("wrong-type")]
    [InlineData("missing-expiry")]
    [InlineData("zero-expiry")]
    [InlineData("negative-expiry")]
    [InlineData("string-expiry")]
    public async Task Invalid_token_type_or_expiry_is_never_returned(string defect)
    {
        var responseBody = defect switch
        {
            "missing-type" => """{"access_token":"token","expires_in":600}""",
            "wrong-type" => """{"access_token":"token","token_type":"Basic","expires_in":600}""",
            "missing-expiry" => """{"access_token":"token","token_type":"Bearer"}""",
            "zero-expiry" => """{"access_token":"token","token_type":"Bearer","expires_in":0}""",
            "negative-expiry" => """{"access_token":"token","token_type":"Bearer","expires_in":-1}""",
            "string-expiry" => """{"access_token":"token","token_type":"Bearer","expires_in":"600"}""",
            _ => throw new ArgumentOutOfRangeException(nameof(defect))
        };
        using var handler = new TokenHandler { SuccessBody = responseBody };
        var provider = new McpServiceTokenProvider(
            new TestCredential(), new TestHttpClientFactory(handler),
            NullLogger<McpServiceTokenProvider>.Instance, "https://mcp.test/mcp");

        Assert.Null(await provider.GetTokenAsync(
            [McpServiceTokenProvider.ProductsReadScope], CancellationToken.None));
    }

    [Fact]
    public async Task Empty_scope_set_is_rejected_without_requesting_a_token()
    {
        using var handler = new TokenHandler();
        var provider = new McpServiceTokenProvider(
            new TestCredential(),
            new TestHttpClientFactory(handler),
            NullLogger<McpServiceTokenProvider>.Instance,
            "https://mcp.test/mcp");

        await Assert.ThrowsAsync<ArgumentException>(() =>
            provider.GetTokenAsync(Array.Empty<string>(), CancellationToken.None));

        Assert.Empty(handler.RequestBodies);
    }

    [Fact]
    public async Task Failed_token_exchange_does_not_log_the_response_body()
    {
        using var handler = new TokenHandler { FailureBody = "sensitive-response-body" };
        var logger = new RecordingLogger<McpServiceTokenProvider>();
        var provider = new McpServiceTokenProvider(
            new TestCredential(), new TestHttpClientFactory(handler), logger, "https://mcp.test/mcp");

        Assert.Null(await provider.GetTokenAsync(
            [McpServiceTokenProvider.ProductsReadScope], CancellationToken.None));
        Assert.Contains(logger.Messages, message => message.Contains("HTTP 400", StringComparison.Ordinal));
        Assert.DoesNotContain(logger.Messages, message => message.Contains("sensitive-response-body", StringComparison.Ordinal));
    }

    private sealed class TestCredential : TokenCredential
    {
        public int Calls { get; private set; }

        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
        {
            Calls++;
            return new("entra-assertion", DateTimeOffset.UtcNow.AddMinutes(10));
        }

        public override ValueTask<AccessToken> GetTokenAsync(
            TokenRequestContext requestContext,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class TestHttpClientFactory(TokenHandler handler) : IHttpClientFactory
    {
        public List<string> ClientNames { get; } = [];
        public HttpClient CreateClient(string name)
        {
            ClientNames.Add(name);
            return new(handler, disposeHandler: false);
        }
    }

    private sealed class TokenHandler : HttpMessageHandler
    {
        public List<string> RequestBodies { get; } = [];
        public string? GrantedScopeOverride { get; init; }
        public bool OmitGrantedScope { get; init; }
        public string? FailureBody { get; init; }
        public string? SuccessBody { get; init; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var requestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            RequestBodies.Add(requestBody);
            if (FailureBody is not null)
                return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent(FailureBody) };

            var encodedScope = requestBody.Split('&')
                .Single(part => part.StartsWith("scope=", StringComparison.Ordinal))["scope=".Length..];
            var scope = Uri.UnescapeDataString(encodedScope.Replace("+", " ", StringComparison.Ordinal));
            var token = $"service-token-{RequestBodies.Count}";
            var responseBody = SuccessBody ?? (OmitGrantedScope
                ? $$"""{"access_token":"{{token}}","token_type":"Bearer","expires_in":600}"""
                : $$"""{"access_token":"{{token}}","token_type":"Bearer","expires_in":600,"scope":"{{GrantedScopeOverride ?? scope}}"}""");
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    responseBody,
                    Encoding.UTF8,
                    "application/json")
            };
        }
    }

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Messages.Add(formatter(state, exception));
    }

    private static string FormScope(string body)
    {
        var encoded = body.Split('&')
            .Single(part => part.StartsWith("scope=", StringComparison.Ordinal))["scope=".Length..];
        return Uri.UnescapeDataString(encoded.Replace("+", " ", StringComparison.Ordinal));
    }
}
