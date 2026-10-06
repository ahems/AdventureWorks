using System.Net;
using System.Text;
using System.Text.Json;
using api_functions.Services;
using Azure.Core;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class FoundryAgentClientTests
{
    [Fact]
    public async Task Data_supplied_calls_omit_tools_and_warmup_on_initial_and_refinement_turns()
    {
        using var handler = new FoundryHandler();
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        foreach (var previousId in new string?[] { null, "resp-previous" })
        {
            var response = await client.InvokeAsync(
                "promotion-agent", "Live product data", previousResponseId: previousId,
                toolChoice: "none", additionalInstructions: "Use server-loaded data only.");

            Assert.Equal("resp-test", response.ResponseId);
            Assert.Equal("Generated promotion", response.ResponseText);
        }

        Assert.Equal(1, handler.DefinitionRequests);
        Assert.Equal(0, handler.McpRequests);
        Assert.Equal(2, handler.ResponseRequests.Count);
        foreach (var body in handler.ResponseRequests)
        {
            Assert.False(body.TryGetProperty("tools", out _));
            Assert.Equal("none", body.GetProperty("tool_choice").GetString());
            Assert.EndsWith("Use server-loaded data only.", body.GetProperty("instructions").GetString());
        }
        Assert.Equal("resp-previous", handler.ResponseRequests[1].GetProperty("previous_response_id").GetString());

        await client.InvokeAsync("promotion-agent", "Use MCP", toolChoice: "required", mcpAccessToken: "test-user");
        var tools = handler.ResponseRequests[2].GetProperty("tools");
        Assert.Equal("Bearer test-user", tools[0].GetProperty("headers").GetProperty("Authorization").GetString());
        Assert.Equal(1, handler.McpRequests);

        await client.InvokeAsync("promotion-agent", "Another user", toolChoice: "required");
        Assert.False(handler.ResponseRequests[3].GetProperty("tools")[0].TryGetProperty("headers", out _));
    }

    [Fact]
    public async Task Data_supplied_calls_do_not_restore_fallback_mcp_tools_on_failure()
    {
        using var handler = new FoundryHandler { ResponseStatus = HttpStatusCode.BadRequest };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.InvokeAsync("promotion-agent", "Live product data", toolChoice: "none"));

        Assert.Contains("400", error.Message);
        Assert.Single(handler.ResponseRequests);
        Assert.Equal(0, handler.McpRequests);
    }

    [Fact]
    public async Task Empty_text_recovery_does_not_send_unauthenticated_cached_tools()
    {
        using var handler = new FoundryHandler { FirstResponseIsToolOnly = true };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        var response = await client.InvokeAsync(
            "promotion-agent", "Use MCP", toolChoice: "required", mcpAccessToken: "test-user");

        Assert.Equal("Generated promotion", response.ResponseText);
        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.False(handler.ResponseRequests[1].TryGetProperty("tools", out _));
        Assert.Equal("none", handler.ResponseRequests[1].GetProperty("tool_choice").GetString());
    }

    private static FoundryAgentClient CreateClient(FoundryHandler handler, TelemetryConfiguration telemetry) =>
        new(NullLogger<FoundryAgentClient>.Instance, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            fallbackMcpServiceUrl: "https://fallback.test/mcp");

    private sealed class TestCredential : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new("test-foundry-token", DateTimeOffset.UtcNow.AddHours(1));

        public override ValueTask<AccessToken> GetTokenAsync(
            TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class TestHttpClientFactory(FoundryHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class FoundryHandler : HttpMessageHandler
    {
        public int DefinitionRequests { get; private set; }
        public int McpRequests { get; private set; }
        public List<JsonElement> ResponseRequests { get; } = [];
        public HttpStatusCode ResponseStatus { get; init; } = HttpStatusCode.OK;
        public bool FirstResponseIsToolOnly { get; init; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.Contains("/agents/", StringComparison.Ordinal))
            {
                DefinitionRequests++;
                return JsonResponse(HttpStatusCode.OK, """
                    {"versions":{"latest":{"definition":{"model":"chat","instructions":"Generate JSON.",
                    "tools":[{"type":"mcp","server_label":"aw","server_url":"https://mcp.test/mcp"}]}}}}
                    """);
            }

            if (path == "/mcp")
            {
                McpRequests++;
                return JsonResponse(HttpStatusCode.OK, "{}");
            }

            Assert.EndsWith("/openai/v1/responses", path);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            ResponseRequests.Add(body.RootElement.Clone());

            if (ResponseStatus != HttpStatusCode.OK)
            {
                return JsonResponse(ResponseStatus, """{"error":{"message":"tool_user_error enumerating tools"}}""");
            }
            if (FirstResponseIsToolOnly && ResponseRequests.Count == 1)
            {
                return JsonResponse(HttpStatusCode.OK, """
                    {"id":"resp-tool","status":"completed","output":[{"type":"mcp_call","name":"GetProductsForPromotion"}]}
                    """);
            }

            return JsonResponse(HttpStatusCode.OK, """
                {"id":"resp-test","status":"completed","output":[{"type":"message",
                "content":[{"type":"output_text","text":"Generated promotion"}]}]}
                """);
        }

        private static HttpResponseMessage JsonResponse(HttpStatusCode status, string json) =>
            new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    }
}
