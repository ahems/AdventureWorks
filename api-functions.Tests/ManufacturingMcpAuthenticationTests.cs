using System.Net;
using System.Text;
using api_functions.Models;
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

        Assert.Equal("Bearer service-token-1", await authentication.GetTokenAsync("ReadOnly", default));
        Assert.Equal("Bearer service-token-2", await authentication.GetTokenAsync("ReadOnly", default));
        Assert.Equal(2, credential.Requests);
        Assert.Equal(2, handler.Requests.Count);
        Assert.All(handler.Requests, request =>
        {
            Assert.Equal("https://mcp.example.test/token", request.Url);
            Assert.Contains("grant_type=urn%3Aadventureworks%3Aparams%3Aoauth%3Agrant-type%3Amanaged-identity", request.Body);
            Assert.Contains("client_id=adventureworks-agents", request.Body);
            Assert.Contains("assertion=test-identity-assertion", request.Body);
            Assert.Contains("resource=https%3A%2F%2Fmcp.example.test%2Fmcp", request.Body);
            Assert.Contains("scope=", request.Body);
            Assert.DoesNotContain("manufacturing.write", request.Body);
        });
        Assert.Equal("api://AzureADTokenExchange/.default", credential.Scope);
    }

    [Fact]
    public async Task Autonomous_mode_alone_receives_manufacturing_write_scope()
    {
        using var handler = new TokenHandler();
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(new TestCredential(), http, "https://mcp.example.test/mcp");

        await authentication.GetTokenAsync("FullyAutonomous", default);

        Assert.Contains("manufacturing.write", handler.Requests[0].Body);
        Assert.Contains("scope=", handler.Requests[0].Body);
    }

    [Fact]
    public async Task Omitted_response_scope_means_the_requested_scope_set()
    {
        using var handler = new TokenHandler
        {
            Body = """{"access_token":"service-token","token_type":"Bearer","expires_in":600}"""
        };
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(new TestCredential(), http, "https://mcp.example.test/mcp");

        Assert.Equal("Bearer service-token", await authentication.GetTokenAsync("ReadOnly", default));
    }

    [Fact]
    public void Read_and_proposal_modes_do_not_receive_write_scopes()
    {
        foreach (var mode in new[] { "ReadOnly", "ProposePending" })
        {
            Assert.DoesNotContain("manufacturing.write", McpServiceAuthentication.GetScopesForMode(mode));
        }

        Assert.Throws<ArgumentOutOfRangeException>(() => McpServiceAuthentication.GetScopesForMode("unexpected"));
    }

    [Theory]
    [InlineData("ReadOnly")]
    [InlineData("ProposePending")]
    public void Read_and_proposal_modes_do_not_offer_autonomous_write_tools(string mode)
    {
        var tools = McpServiceAuthentication.GetToolsForMode(mode);
        Assert.Contains("get_order_details", tools);
        Assert.Contains("get_production_feasibility", tools);
        Assert.DoesNotContain("begin_manufacturing_run", tools);
        Assert.DoesNotContain("place_supply_order", tools);
        Assert.Equal(tools.Length, tools.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void Autonomous_mode_offers_write_tools_and_unknown_modes_fail_closed()
    {
        var readTools = McpServiceAuthentication.GetToolsForMode("ReadOnly");
        var autonomousTools = McpServiceAuthentication.GetToolsForMode("FullyAutonomous");
        Assert.Equal(
            new[] { "begin_manufacturing_run", "place_supply_order" },
            autonomousTools.Except(readTools, StringComparer.Ordinal).Order(StringComparer.Ordinal));
        Assert.Empty(readTools.Except(autonomousTools, StringComparer.Ordinal));
        Assert.Throws<ArgumentOutOfRangeException>(() => McpServiceAuthentication.GetToolsForMode("unexpected"));
    }

    [Fact]
    public void Manufacturing_invocation_mode_is_parsed_fail_closed()
    {
        Assert.Throws<InvalidOperationException>(() => McpServiceAuthentication.GetModeFromMessages(["order only"]));
        Assert.Throws<InvalidOperationException>(() =>
            McpServiceAuthentication.GetModeFromMessages(["Mode=ReadOnly (1)", "Mode=FullyAutonomous (3)"]));
        Assert.Throws<InvalidOperationException>(() =>
            McpServiceAuthentication.GetModeFromMessages(["Mode=FullyAutonomous (1)"]));
        Assert.Throws<InvalidOperationException>(() =>
            McpServiceAuthentication.GetModeFromMessages([$"Mode={ManufacturingAgentMode.Off} ({(int)ManufacturingAgentMode.Off})"]));
    }

    [Theory]
    [InlineData(ManufacturingAgentMode.ReadOnly)]
    [InlineData(ManufacturingAgentMode.ProposePending)]
    [InlineData(ManufacturingAgentMode.FullyAutonomous)]
    public void Hosted_agent_accepts_the_actual_queue_trigger_mode_format(ManufacturingAgentMode mode)
    {
        var message = $"order\nMode={mode} ({(int)mode})\nrun";
        Assert.Equal(mode.ToString(), McpServiceAuthentication.GetModeFromMessages([message]));
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
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => authentication.GetTokenAsync("ReadOnly", default));
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
    [InlineData("""{"access_token":"token","token_type":"Bearer","expires_in":600,"scope":"mcp.access"}""")]
    [InlineData("""{"access_token":"token","token_type":"Bearer","expires_in":600,"scope":null}""")]
    [InlineData("""{"access_token":"token","token_type":"Bearer","expires_in":600,"scope":123}""")]
    [InlineData("""{"access_token":"token","token_type":"Bearer","expires_in":600,"scope":""}""")]
    [InlineData("""{"access_token":"token","token_type":"Bearer","expires_in":600,"scope":"mcp.access products.read orders.read inventory.read manufacturing.read manufacturing.write"}""")]
    public async Task Invalid_token_response_never_reaches_mcp_tools(string body)
    {
        using var handler = new TokenHandler { Body = body };
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(new TestCredential(), http, "https://mcp.example.test/mcp");
        await Assert.ThrowsAsync<InvalidOperationException>(() => authentication.GetTokenAsync("ReadOnly", default));
    }

    [Fact]
    public async Task Cancellation_prevents_token_exchange()
    {
        using var handler = new TokenHandler();
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(new TestCredential(), http, "https://mcp.example.test/mcp");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => authentication.GetTokenAsync("ReadOnly", cancellation.Token));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Insecure_endpoint_is_rejected_before_credentials_are_acquired()
    {
        var credential = new TestCredential();
        using var handler = new TokenHandler();
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(credential, http, "http://mcp.example.test/mcp");
        await Assert.ThrowsAsync<InvalidOperationException>(() => authentication.GetTokenAsync("ReadOnly", default));
        Assert.Equal(0, credential.Requests);
    }

    [Theory]
    [InlineData("query")]
    [InlineData("fragment")]
    [InlineData("userinfo")]
    [InlineData("empty-userinfo")]
    [InlineData("dot-segment")]
    [InlineData("escaped-dot-segment")]
    [InlineData("backslash")]
    public async Task Ambiguous_endpoint_is_rejected_before_credentials_are_acquired(string defect)
    {
        var url = defect switch
        {
            "query" => "https://mcp.example.test/mcp?destination=other",
            "fragment" => "https://mcp.example.test/mcp#fragment",
            "userinfo" => "https://user@mcp.example.test/mcp",
            "empty-userinfo" => "https://@mcp.example.test/mcp",
            "dot-segment" => "https://mcp.example.test/a/../mcp",
            "escaped-dot-segment" => "https://mcp.example.test/a/%2e%2e/mcp",
            "backslash" => "https://mcp.example.test\\@other.test/mcp",
            _ => throw new ArgumentOutOfRangeException(nameof(defect))
        };
        var credential = new TestCredential();
        using var handler = new TokenHandler();
        using var http = new HttpClient(handler);
        var authentication = new McpServiceAuthentication(credential, http, url);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            authentication.GetTokenAsync("ReadOnly", default));
        Assert.Contains("MCP_SERVICE_URL", error.Message);
        Assert.Equal(0, credential.Requests);
        Assert.Empty(handler.Requests);
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
            var requestBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            Requests.Add((request.RequestUri!.ToString(), requestBody));
            var encodedScope = requestBody.Split('&')
                .Single(part => part.StartsWith("scope=", StringComparison.Ordinal))["scope=".Length..];
            var scope = Uri.UnescapeDataString(encodedScope.Replace("+", " ", StringComparison.Ordinal));
            return new HttpResponseMessage(Status)
            {
                Content = new StringContent(Body ??
                    $$"""{"access_token":"service-token-{{Requests.Count}}","token_type":"Bearer","expires_in":600,"scope":"{{scope}}"}""",
                    Encoding.UTF8, "application/json")
            };
        }
    }
}
