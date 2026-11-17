using System.Net;
using System.Text;
using Azure.Core;
using api_functions.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class McpServiceTokenProviderTests
{
    [Fact]
    public async Task Requested_scopes_are_sent_and_cached_separately()
    {
        using var handler = new TokenHandler();
        var provider = new McpServiceTokenProvider(
            new TestCredential(),
            new TestHttpClientFactory(handler),
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

    private sealed class TestCredential : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new("entra-assertion", DateTimeOffset.UtcNow.AddMinutes(10));

        public override ValueTask<AccessToken> GetTokenAsync(
            TokenRequestContext requestContext,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class TestHttpClientFactory(TokenHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class TokenHandler : HttpMessageHandler
    {
        public List<string> RequestBodies { get; } = [];
        public string? GrantedScopeOverride { get; init; }
        public bool OmitGrantedScope { get; init; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var requestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            RequestBodies.Add(requestBody);
            var encodedScope = requestBody.Split('&')
                .Single(part => part.StartsWith("scope=", StringComparison.Ordinal))["scope=".Length..];
            var scope = Uri.UnescapeDataString(encodedScope.Replace("+", " ", StringComparison.Ordinal));
            var token = $"service-token-{RequestBodies.Count}";
            var responseBody = OmitGrantedScope
                ? $$"""{"access_token":"{{token}}","expires_in":600}"""
                : $$"""{"access_token":"{{token}}","expires_in":600,"scope":"{{GrantedScopeOverride ?? scope}}"}""";
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    responseBody,
                    Encoding.UTF8,
                    "application/json")
            };
        }
    }

    private static string FormScope(string body)
    {
        var encoded = body.Split('&')
            .Single(part => part.StartsWith("scope=", StringComparison.Ordinal))["scope=".Length..];
        return Uri.UnescapeDataString(encoded.Replace("+", " ", StringComparison.Ordinal));
    }
}
