using api_functions.Services;
using Azure.Core;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class AIAgentServiceTests
{
    [Fact]
    public async Task Chat_uses_prompt_agent_even_when_workflow_is_configured()
    {
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        using var handler = new RecordingHandler();
        var client = new FoundryAgentClient(NullLogger<FoundryAgentClient>.Instance,
            new TelemetryClient(telemetry), new TestCredential(), "https://foundry.test", new TestFactory(handler));
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_CHAT_ID"] = "eshop-chat-agent",
            ["AI_AGENT_WORKFLOW_CHAT_ID"] = "eshop-workflow-agent",
            ["AI_AGENT_ADMIN_CHAT_ID"] = "admin-chat-agent"
        }).Build();
        var service = new AIAgentService(NullLogger<AIAgentService>.Instance, config, client, new TelemetryClient(telemetry));

        await service.ProcessMessageAsync("Show my orders", [], customerId: 123, mcpAccessToken: "user-token");
        Assert.Equal("eshop-chat-agent", handler.AgentId);
        Assert.Equal("123", handler.UserId);
        Assert.EndsWith(" user-token", handler.Authorization);

        await service.ProcessMessageAsync("Sales overview", [], isAdmin: true, mcpAccessToken: "admin-token");
        Assert.Equal("admin-chat-agent", handler.AgentId);
        Assert.EndsWith(" admin-token", handler.Authorization);
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public string? AgentId { get; private set; }
        public string? UserId { get; private set; }
        public string? Authorization { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath.StartsWith("/agents/"))
            {
                AgentId = request.RequestUri.AbsolutePath.Split('/').Last();
                return JsonResponse("""
                    {"versions":{"latest":{"definition":{"kind":"prompt","model":"chat","instructions":"Customer {{userId}}",
                    "tools":[{"type":"mcp","server_label":"aw","server_url":"https://mcp.test/mcp"}]}}}}
                    """);
            }
            if (request.RequestUri.AbsolutePath == "/mcp") return JsonResponse("{}");
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            Authorization = body.RootElement.GetProperty("tools")[0].GetProperty("headers").GetProperty("Authorization").GetString();
            UserId = request.Headers.TryGetValues("x-memory-user-id", out var values) ? values.Single() : null;
            return JsonResponse("""
                {"id":"resp-test","status":"completed","output":[{"type":"message",
                "content":[{"type":"output_text","text":"Your orders"}]}]}
                """);
        }

        private static HttpResponseMessage JsonResponse(string json) =>
            new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    }

    private sealed class TestCredential : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new("foundry-token", DateTimeOffset.UtcNow.AddHours(1));
        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class TestFactory(RecordingHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}
