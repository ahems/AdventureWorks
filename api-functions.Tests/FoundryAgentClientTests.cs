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
    [Theory]
    [InlineData("""{"error":{"code":"content_filter","message":"private prompt must not be echoed"}}""", 400)]
    [InlineData("""{"error":{"innererror":{"code":"ResponsibleAIPolicyViolation"}}}""", 400)]
    [InlineData("""{"status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[{"type":"message","content":[{"type":"output_text","text":"partial code that must never escape"}]}]}""", 200)]
    public async Task Foundry_blocks_never_return_partial_content_or_retry_with_weaker_tools(string body, int status)
    {
        using var handler = new FoundryHandler { CustomResponse = body, ResponseStatus = (HttpStatusCode)status };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        var error = await Assert.ThrowsAsync<FoundryGuardrailException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Misuse prompt", mcpAccessToken: "user", contentFilterPolicy: "AdventureWorks-Eshop"));

        Assert.DoesNotContain("private", error.Message);
        Assert.DoesNotContain("partial", error.Message);
        Assert.Single(handler.ResponseRequests);
        Assert.Equal("AdventureWorks-Eshop", handler.Policies.Single());
    }

    [Fact]
    public async Task Guarded_chat_applies_policy_on_continuation_without_affecting_other_agents()
    {
        using var handler = new FoundryHandler { FirstResponseIsToolOnly = true };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);
        await client.InvokeAsync("eshop-chat-agent", "Orders", mcpAccessToken: "user",
            contentFilterPolicy: "AdventureWorks-Eshop", conversationOwner: "signed-subject");

        Assert.Equal(new[] { "AdventureWorks-Eshop", "AdventureWorks-Eshop" }, handler.Policies);
        Assert.All(handler.ResponseRequests, body =>
            Assert.Equal("signed-subject", body.GetProperty("metadata").GetProperty("aw_chat_owner").GetString()));
        await client.InvokeAsync("promotion-agent", "Generate", toolChoice: "none");
        Assert.Null(handler.Policies.Last());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Guardrail_blocks_on_approval_or_empty_text_continuations_never_expose_partial_output(bool approval)
    {
        using var handler = new FoundryHandler
        {
            FirstResponseNeedsApproval = approval,
            FirstResponseIsToolOnly = !approval,
            CustomResponseRound = 2,
            CustomResponse = """{"status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[{"type":"message","content":[{"type":"output_text","text":"partial code"}]}]}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        await Assert.ThrowsAsync<FoundryGuardrailException>(() => CreateClient(handler, telemetry).InvokeAsync(
            "eshop-chat-agent", "Misuse", mcpAccessToken: "user", contentFilterPolicy: "AdventureWorks-Eshop"));
        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.All(handler.Policies, policy => Assert.Equal("AdventureWorks-Eshop", policy));
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public async Task Guarded_chat_rejects_missing_instructions_or_tools(bool instructions, bool tools)
    {
        using var handler = new FoundryHandler { DefinitionHasInstructions = instructions, DefinitionHasTools = tools };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        await Assert.ThrowsAsync<InvalidOperationException>(() => CreateClient(handler, telemetry).InvokeAsync(
            "eshop-chat-agent", "Hello", contentFilterPolicy: "AdventureWorks-Eshop"));
        Assert.Empty(handler.ResponseRequests);
    }

    [Fact]
    public async Task Guarded_chat_rejects_a_cached_instructionless_fallback()
    {
        using var handler = new FoundryHandler { DefinitionStatus = HttpStatusCode.Forbidden };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);
        await client.InvokeAsync("eshop-chat-agent", "Unguarded call", toolChoice: "none");
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Guarded call", contentFilterPolicy: "AdventureWorks-Eshop"));
        Assert.Single(handler.ResponseRequests);
    }

    [Fact]
    public async Task Chat_resumes_only_responses_owned_by_the_same_subject_and_agent()
    {
        using var handler = new FoundryHandler();
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);
        await client.InvokeAsync("eshop-chat-agent", "Continue", previousResponseId: "resp-owned",
            conversationOwner: "owner", contentFilterPolicy: "AdventureWorks-Eshop", mcpAccessToken: "user");
        Assert.Equal(1, handler.OwnershipRequests);
        Assert.Single(handler.ResponseRequests);

        await Assert.ThrowsAsync<ChatConversationException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Read another person's chat", previousResponseId: "resp-owned",
            conversationOwner: "someone-else", contentFilterPolicy: "AdventureWorks-Eshop"));
        await Assert.ThrowsAsync<ChatConversationException>(() => client.InvokeAsync(
            "admin-chat-agent", "Read consumer chat", previousResponseId: "resp-owned", conversationOwner: "owner"));
        Assert.Single(handler.ResponseRequests);
    }

    [Fact]
    public async Task Missing_policy_is_a_configuration_error_not_a_friendly_safety_refusal()
    {
        using var handler = new FoundryHandler
        {
            ResponseStatus = HttpStatusCode.BadRequest,
            CustomResponse = """{"error":{"code":"InvalidContentFilterPolicy"}}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Hello", contentFilterPolicy: "missing"));
        Assert.Contains("400", error.Message);
        Assert.Single(handler.ResponseRequests);
    }

    [Fact]
    public async Task Guarded_chat_does_not_restore_unrestricted_fallback_tools_on_enumeration_failure()
    {
        using var handler = new FoundryHandler { ResponseStatus = HttpStatusCode.BadRequest };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Orders", contentFilterPolicy: "AdventureWorks-Eshop", mcpAccessToken: "user"));
        Assert.Equal(3, handler.ResponseRequests.Count);
        Assert.All(handler.ResponseRequests, body =>
            Assert.Equal("https://mcp.test/mcp", body.GetProperty("tools")[0].GetProperty("server_url").GetString()));
    }

    [Fact]
    public async Task Workflow_definitions_are_rejected_instead_of_becoming_instructionless_prompts()
    {
        using var handler = new FoundryHandler { DefinitionKind = "workflow" };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.InvokeAsync("eshop-workflow-agent", "Show my orders"));

        Assert.Contains("not a prompt agent", error.Message);
        Assert.Empty(handler.ResponseRequests);
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData("""{"error":{"type":"http_error","message":"401 Unauthorized"}}""")]
    [InlineData("""{"output":{"isError":true,"content":[{"type":"text","text":"Access denied"}]}}""")]
    [InlineData("""{"output":"{\"isError\":true,\"content\":[]}"}""")]
    public async Task Failed_mcp_tools_do_not_report_chat_success(string toolResult)
    {
        using var handler = new FoundryHandler { ToolResult = toolResult };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.InvokeAsync("eshop-chat-agent", "Show my orders", mcpAccessToken: "test-user"));

        Assert.Contains("get_customer_orders", error.Message);
        Assert.Single(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("""{"output":"Order history"}""")]
    [InlineData("""{"output":"{\"isError\":false,\"content\":[]}","error":null}""")]
    public async Task Successful_mcp_tools_preserve_the_answer(string toolResult)
    {
        using var handler = new FoundryHandler { ToolResult = toolResult };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var response = await CreateClient(handler, telemetry).InvokeAsync(
            "eshop-chat-agent", "Show my orders", mcpAccessToken: "test-user");

        Assert.Equal("Generated promotion", response.ResponseText);
        Assert.Contains("get_customer_orders", response.ToolsUsed);
    }

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

    [Fact]
    public async Task Service_token_is_injected_only_for_api_mcp_tools_without_delegated_token()
    {
        using var handler = new FoundryHandler();
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider);

        await client.InvokeAsync("customer-agent", "Generate", toolChoice: "required");
        var auth = handler.ResponseRequests[0].GetProperty("tools")[0].GetProperty("headers").GetProperty("Authorization").GetString();
        Assert.EndsWith(" svc-token", auth);

        // A delegated user token always wins over the service token.
        await client.InvokeAsync("customer-agent", "Generate", toolChoice: "required", mcpAccessToken: "user-token");
        auth = handler.ResponseRequests[1].GetProperty("tools")[0].GetProperty("headers").GetProperty("Authorization").GetString();
        Assert.EndsWith(" user-token", auth);
        Assert.Equal(1, provider.Calls);
    }

    [Fact]
    public async Task Service_token_is_not_sent_to_other_mcp_servers()
    {
        using var handler = new FoundryHandler();
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry, new StubServiceTokenProvider(handler, "https://other-mcp.test/mcp"));

        await client.InvokeAsync("customer-agent", "Generate", toolChoice: "required");
        Assert.False(handler.ResponseRequests[0].GetProperty("tools")[0].TryGetProperty("headers", out _));
    }

    private static FoundryAgentClient CreateClient(
        FoundryHandler handler, TelemetryConfiguration telemetry, McpServiceTokenProvider? provider = null) =>
        new(NullLogger<FoundryAgentClient>.Instance, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            fallbackMcpServiceUrl: "https://fallback.test/mcp", serviceTokenProvider: provider);

    private sealed class StubServiceTokenProvider(FoundryHandler handler, string mcpUrl)
        : McpServiceTokenProvider(new TestCredential(), new TestHttpClientFactory(handler),
            NullLogger<McpServiceTokenProvider>.Instance, mcpUrl)
    {
        public int Calls { get; private set; }

        public override Task<string?> GetTokenAsync(CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult<string?>("svc-token");
        }
    }

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
        public bool FirstResponseNeedsApproval { get; init; }
        public string DefinitionKind { get; init; } = "prompt";
        public bool DefinitionHasInstructions { get; init; } = true;
        public bool DefinitionHasTools { get; init; } = true;
        public HttpStatusCode DefinitionStatus { get; init; } = HttpStatusCode.OK;
        public string? ToolResult { get; init; }
        public string? CustomResponse { get; init; }
        public int CustomResponseRound { get; init; }
        public List<string?> Policies { get; } = [];
        public int OwnershipRequests { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Get && path.Contains("/responses/", StringComparison.Ordinal))
            {
                OwnershipRequests++;
                return JsonResponse(HttpStatusCode.OK, """
                    {"metadata":{"aw_chat_owner":"owner","aw_chat_agent":"eshop-chat-agent"}}
                    """);
            }
            if (path.Contains("/agents/", StringComparison.Ordinal))
            {
                DefinitionRequests++;
                return JsonResponse(DefinitionStatus, JsonSerializer.Serialize(new
                {
                    versions = new { latest = new { definition = new
                    {
                        kind = DefinitionKind,
                        model = "chat",
                        instructions = DefinitionHasInstructions ? "Generate JSON." : null,
                        tools = DefinitionHasTools
                            ? new[] { new { type = "mcp", server_label = "aw", server_url = "https://mcp.test/mcp" } }
                            : []
                    } } }
                }));
            }

            if (path == "/mcp")
            {
                McpRequests++;
                return JsonResponse(HttpStatusCode.OK, "{}");
            }

            Assert.EndsWith("/openai/v1/responses", path);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            ResponseRequests.Add(body.RootElement.Clone());
            Policies.Add(request.Headers.TryGetValues("x-policy-id", out var policies) ? policies.Single() : null);
            if (CustomResponse is not null && (CustomResponseRound == 0 || CustomResponseRound == ResponseRequests.Count))
                return JsonResponse(ResponseStatus, CustomResponse);

            if (ResponseStatus != HttpStatusCode.OK)
            {
                return JsonResponse(ResponseStatus, """{"error":{"message":"tool_user_error enumerating tools"}}""");
            }
            if (FirstResponseNeedsApproval && ResponseRequests.Count == 1)
                return JsonResponse(HttpStatusCode.OK, """
                    {"id":"resp-approval","output":[{"type":"mcp_approval_request","id":"approval-1","name":"get_customer_orders","server_label":"aw"}]}
                    """);
            if (FirstResponseIsToolOnly && ResponseRequests.Count == 1)
            {
                return JsonResponse(HttpStatusCode.OK, """
                    {"id":"resp-tool","status":"completed","output":[{"type":"mcp_call","name":"GetProductsForPromotion"}]}
                    """);
            }
            if (ToolResult is not null)
            {
                var tool = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(ToolResult)!;
                tool["type"] = JsonSerializer.SerializeToElement("mcp_call");
                tool["name"] = JsonSerializer.SerializeToElement("get_customer_orders");
                return JsonResponse(HttpStatusCode.OK, JsonSerializer.Serialize(new
                {
                    id = "resp-test",
                    status = "completed",
                    output = new object[]
                    {
                        tool,
                        new { type = "message", content = new[] { new { type = "output_text", text = "Generated promotion" } } }
                    }
                }));
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
