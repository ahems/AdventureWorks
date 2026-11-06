using System.Net;
using System.Text;
using Azure.Core;
using McpTools;
using Xunit;

namespace ApiFunctions.Tests;

public class ManufacturingMcpAuthenticationTests
{
    [Fact]
    public async Task Exchanges_managed_identity_assertion_for_the_correct_mcp_resource_each_invocation()
    {
        var credential = new TestCredential();
        using var handler = new TokenHandler();
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(credential, http, "https://mcp.example.test/mcp");

        Assert.Equal("Bearer service-token-1", await authentication.GetTokenAsync(default));
        Assert.Equal("Bearer service-token-2", await authentication.GetTokenAsync(default));
        Assert.Equal(2, credential.Requests);
        Assert.Equal(2, handler.Requests.Count);
        Assert.All(handler.Requests, request =>
        {
            Assert.Equal("https://mcp.example.test/token", request.Url);
            Assert.Contains("grant_type=urn%3Aadventureworks%3Aparams%3Aoauth%3Agrant-type%3Amanaged-identity", request.Body);
            Assert.Contains("client_id=adventureworks-agents", request.Body);
            Assert.Contains("assertion=test-identity-assertion", request.Body);
            Assert.Contains("resource=https%3A%2F%2Fmcp.example.test%2Fmcp", request.Body);
        });
        Assert.Equal("api://AzureADTokenExchange/.default", credential.Scope);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.Found)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task Authentication_failure_is_fail_closed_and_does_not_expose_token_response(HttpStatusCode status)
    {
        using var handler = new TokenHandler { Status = status };
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(new TestCredential(), http, "https://mcp.example.test/mcp");
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => authentication.GetTokenAsync(default));
        Assert.Contains("verify the hosted agent identity is trusted", error.Message);
        Assert.DoesNotContain("service-token", error.Message);
        Assert.DoesNotContain("test-identity-assertion", error.Message);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("""{"access_token":"","token_type":"Bearer","expires_in":600}""")]
    [InlineData("""{"access_token":"token","token_type":"Basic","expires_in":600}""")]
    [InlineData("""{"access_token":"token","token_type":"Bearer","expires_in":0}""")]
    [InlineData("""{"access_token":"token","token_type":"Bearer","expires_in":"600"}""")]
    public async Task Invalid_token_response_never_reaches_mcp_tools(string body)
    {
        using var handler = new TokenHandler { Body = body };
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(new TestCredential(), http, "https://mcp.example.test/mcp");
        await Assert.ThrowsAsync<InvalidOperationException>(() => authentication.GetTokenAsync(default));
    }

    [Fact]
    public async Task Cancellation_prevents_token_exchange()
    {
        using var handler = new TokenHandler();
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(new TestCredential(), http, "https://mcp.example.test/mcp");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => authentication.GetTokenAsync(cancellation.Token));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Insecure_endpoint_is_rejected_before_credentials_are_acquired()
    {
        var credential = new TestCredential();
        using var handler = new TokenHandler();
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(credential, http, "http://mcp.example.test/mcp");
        await Assert.ThrowsAsync<InvalidOperationException>(() => authentication.GetTokenAsync(default));
        Assert.Equal(0, credential.Requests);
    }

    private sealed class TestCredential : TokenCredential
    {
        public int Requests { get; private set; }
        public string? Scope { get; private set; }
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Requests++;
            Scope = Assert.Single(requestContext.Scopes);
            return ValueTask.FromResult(new AccessToken("test-identity-assertion", DateTimeOffset.UtcNow.AddMinutes(10)));
        }
    }

    private sealed class TokenHandler : HttpMessageHandler
    {
        public HttpStatusCode Status { get; init; } = HttpStatusCode.OK;
        public string? Body { get; init; }
        public List<(string Url, string Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((request.RequestUri!.ToString(), await request.Content!.ReadAsStringAsync(cancellationToken)));
            return new HttpResponseMessage(Status)
            {
                Content = new StringContent(Body ??
                    $$"""{"access_token":"service-token-{{Requests.Count}}","token_type":"Bearer","expires_in":600}""",
                    Encoding.UTF8, "application/json")
            };
        }
    }
}
