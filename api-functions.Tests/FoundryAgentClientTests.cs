using System.Net;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using api_functions.Services;
using Azure.Core;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Channel;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class FoundryAgentClientTests
{
    [Theory]
    [InlineData(false, 1)]
    [InlineData(true, 3)]
    public async Task Draft_generation_retries_transient_failures_only_when_requested(bool retry, int attempts)
    {
        using var handler = new FoundryHandler { ResponseStatus = HttpStatusCode.ServiceUnavailable };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        await Assert.ThrowsAsync<InvalidOperationException>(() => CreateClient(handler, telemetry).InvokeAsync(
            "manufacturing-content-agent", "Draft", toolChoice: "none",
            requireConfiguredDefinition: true, retryTransientResponses: retry));
        Assert.Equal(attempts, handler.ResponseRequests.Count);
        Assert.Equal(0, handler.McpRequests);
    }

    [Fact]
    public async Task Draft_generation_rejects_missing_agent_definition_without_fallback()
    {
        using var handler = new FoundryHandler { DefinitionStatus = HttpStatusCode.Forbidden };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        await Assert.ThrowsAsync<InvalidOperationException>(() => CreateClient(handler, telemetry).InvokeAsync(
            "manufacturing-content-agent", "Draft", toolChoice: "none", requireConfiguredDefinition: true));
        Assert.Empty(handler.ResponseRequests);
    }

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
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider);

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

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.InvokeAsync("promotion-agent", "Another user", toolChoice: "required"));
        Assert.Contains("no explicit service-token scopes", error.Message);
        Assert.Equal(3, handler.ResponseRequests.Count);
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

        await client.InvokeAsync("customer-agent", "Generate", toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.AdminWriteScope]);
        var auth = handler.ResponseRequests[0].GetProperty("tools")[0].GetProperty("headers").GetProperty("Authorization").GetString();
        Assert.EndsWith(" svc-token", auth);

        // A delegated user token always wins over the service token.
        await client.InvokeAsync("customer-agent", "Generate", toolChoice: "required", mcpAccessToken: "user-token");
        auth = handler.ResponseRequests[1].GetProperty("tools")[0].GetProperty("headers").GetProperty("Authorization").GetString();
        Assert.EndsWith(" user-token", auth);
        Assert.Equal(1, provider.Calls);
    }

    [Fact]
    public async Task Requested_service_scopes_are_forwarded_to_the_token_provider()
    {
        using var handler = new FoundryHandler();
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider);

        await client.InvokeAsync("eshop-help-me-choose-agent", "Recommend a product",
            toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope]);

        Assert.Equal([McpServiceTokenProvider.ProductsReadScope], provider.RequestedScopes);
    }

    private const string PublicCatalogTool = """
        {"type":"mcp","server_label":"adventureworks_mcp","server_url":"https://mcp.test/mcp",
         "allowed_tools":{"tool_names":["search_products","get_product_details",
         "find_complementary_products","get_categories_with_products"]},"require_approval":"never"}
        """;

    private const string CustomerChatTool = """
        {"type":"mcp","server_label":"adventureworks_mcp","server_url":"https://mcp.test/mcp",
         "allowed_tools":["get_customer_orders","get_order_details","find_complementary_products","search_products",
         "get_product_details","get_personalized_recommendations","analyze_product_reviews","get_product_availability"],
         "require_approval":"never"}
        """;

    private const string AdminChatTool = """
         {"type":"mcp","server_label":"adventureworks_mcp","server_url":"https://mcp.test/mcp",
          "allowed_tools":["get_business_stats","get_top_customers","get_orders_by_status",
          "get_sales_report_by_status","get_product_performance_summary","get_recent_customers_without_orders",
          "search_customers","get_top_selling_products","search_products","get_product_details",
          "check_inventory_availability","get_categories_with_products","get_products_for_promotion",
          "get_active_promotions","analyze_product_reviews"],"require_approval":"never"}
         """;

    [Fact]
    public async Task Customer_chat_delegates_request_scoped_tokens_and_traces_without_caching_them()
    {
        using var handler = new FoundryHandler { DefinitionToolsJson = "[" + CustomerChatTool + "]" };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        var traces = new List<string>();
        for (var index = 0; index < 2; index++)
        {
            using var activity = new Activity("customer-chat-test").SetIdFormat(ActivityIdFormat.W3C).Start();
            traces.Add(activity.Id!);
            await client.InvokeAsync("eshop-chat-agent", "Check availability",
                mcpAccessToken: $"user-{index}", requireCustomerChatTools: true);
        }

        Assert.Equal(1, handler.DefinitionRequests);
        Assert.Equal(0, provider.Calls);
        Assert.NotEqual(traces[0], traces[1]);
        for (var index = 0; index < 2; index++)
        {
            var headers = handler.ResponseRequests[index].GetProperty("tools")[0].GetProperty("headers");
            Assert.Equal($"Bearer user-{index}", headers.GetProperty("Authorization").GetString());
            Assert.Equal(traces[index], headers.GetProperty("traceparent").GetString());
        }
        var completions = channel.Items.OfType<EventTelemetry>()
            .Where(item => item.Name == "Foundry.Responses.Completed").ToArray();
        Assert.Equal(2, completions.Length);
        Assert.All(completions,
            item => Assert.Equal("customer-chat", item.Properties["ToolPolicy"]));
    }

    [Fact]
    public async Task Admin_chat_uses_only_delegated_tokens_and_records_guarded_policy()
    {
        using var handler = new FoundryHandler { DefinitionToolsJson = "[" + AdminChatTool + "]" };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        using var activity = new Activity("admin-chat-test").SetIdFormat(ActivityIdFormat.W3C).Start();

        await client.InvokeAsync("admin-chat-agent", "Show business stats",
            mcpAccessToken: "admin-token", requireAdminChatTools: true);

        Assert.Equal(0, provider.Calls);
        var headers = handler.ResponseRequests.Single().GetProperty("tools")[0].GetProperty("headers");
        Assert.Equal("Bearer admin-token", headers.GetProperty("Authorization").GetString());
        Assert.Equal(activity.Id, headers.GetProperty("traceparent").GetString());
        var completed = Assert.Single(channel.Items.OfType<EventTelemetry>(),
            item => item.Name == "Foundry.Responses.Completed");
        Assert.Equal("admin-chat", completed.Properties["ToolPolicy"]);
    }

    [Theory]
    [InlineData("missing-token")]
    [InlineData("service-scopes")]
    [InlineData("extra-tool")]
    [InlineData("missing-tool")]
    [InlineData("wrong-server")]
    [InlineData("static-header")]
    [InlineData("additional-server")]
    [InlineData("multiple-policies")]
    public async Task Admin_chat_rejects_unreviewed_credentials_and_tools_before_execution(string change)
    {
        var tool = JsonNode.Parse(AdminChatTool)!.AsObject();
        var tools = new JsonArray(tool);
        switch (change)
        {
            case "extra-tool": tool["allowed_tools"]!.AsArray().Add("create_order"); break;
            case "missing-tool": tool["allowed_tools"]!.AsArray().RemoveAt(0); break;
            case "wrong-server": tool["server_url"] = "https://other.test/mcp"; break;
            case "static-header": tool["headers"] = new JsonObject { ["Authorization"] = "preconfigured" }; break;
            case "additional-server": tools.Add(JsonNode.Parse(AdminChatTool)); break;
        }
        using var handler = new FoundryHandler { DefinitionToolsJson = tools.ToJsonString() };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "admin-chat-agent", "Show business stats",
            mcpAccessToken: change == "missing-token" ? null : "admin-token",
            mcpServiceScopes: change == "service-scopes" ? [McpServiceTokenProvider.ProductsReadScope] : null,
            requireAdminChatTools: true, requireCustomerChatTools: change == "multiple-policies"));

        Assert.Equal(0, provider.Calls);
        Assert.Equal(0, handler.McpRequests);
        Assert.Empty(handler.ResponseRequests);
    }

    [Fact]
    public async Task Admin_chat_never_falls_back_to_unrestricted_tools_after_enumeration_failure()
    {
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = "[" + AdminChatTool + "]",
            ResponseStatus = HttpStatusCode.BadRequest
        };
        var client = CreateClient(handler, telemetry, fallbackMcpUrl: "https://mcp.test/mcp");

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "admin-chat-agent", "Show business stats", mcpAccessToken: "admin-token",
            requireAdminChatTools: true));

        Assert.Equal(3, handler.ResponseRequests.Count);
        Assert.All(handler.ResponseRequests, body =>
            Assert.Equal(15, body.GetProperty("tools")[0].GetProperty("allowed_tools").GetArrayLength()));
    }

    [Fact]
    public async Task Guarded_admin_chat_does_not_log_private_tool_errors()
    {
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = "[" + AdminChatTool + "]",
            ResponseStatus = HttpStatusCode.BadRequest,
            CustomResponse = """{"error":{"message":"tool_user_error private-tool-data"}}"""
        };
        var logger = new CapturingLogger();
        var client = new FoundryAgentClient(logger, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            fallbackMcpServiceUrl: "https://mcp.test/mcp");

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "admin-chat-agent", "Show business stats", mcpAccessToken: "admin-token",
            requireAdminChatTools: true));

        Assert.Contains(logger.Messages, message => message.Contains("guarded chat payload omitted"));
        Assert.DoesNotContain(logger.Messages, message => message.Contains("private-tool-data"));
    }

    [Theory]
    [InlineData("create_order", "adventureworks_mcp")]
    [InlineData("get_business_stats", "other_mcp")]
    public async Task Admin_chat_never_approves_unreviewed_tools(string name, string server)
    {
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = "[" + AdminChatTool + "]",
            FirstResponseNeedsApproval = true,
            ApprovalToolName = name,
            ApprovalServer = server
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry, fallbackMcpUrl: "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "admin-chat-agent", "Show business stats",
            mcpAccessToken: "admin-token", requireAdminChatTools: true));
        Assert.Single(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("missing-token")]
    [InlineData("service-scopes")]
    [InlineData("extra-tool")]
    [InlineData("internal-inventory")]
    [InlineData("wrong-server")]
    [InlineData("static-header")]
    [InlineData("additional-server")]
    public async Task Customer_chat_rejects_unreviewed_credentials_and_tools_before_execution(string change)
    {
        var tool = JsonNode.Parse(CustomerChatTool)!.AsObject();
        var tools = new JsonArray(tool);
        var names = tool["allowed_tools"]!.AsArray();
        switch (change)
        {
            case "extra-tool": names.Add("create_order"); break;
            case "internal-inventory":
                names.Remove(names.Single(node => node!.GetValue<string>() == "get_product_availability"));
                names.Add("check_inventory_availability");
                break;
            case "wrong-server": tool["server_url"] = "https://other.test/mcp"; break;
            case "static-header": tool["headers"] = new JsonObject { ["Authorization"] = "preconfigured" }; break;
            case "additional-server": tools.Add(JsonNode.Parse(CustomerChatTool)); break;
        }
        using var handler = new FoundryHandler { DefinitionToolsJson = tools.ToJsonString() };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Check availability",
            mcpAccessToken: change == "missing-token" ? null : "user-token",
            mcpServiceScopes: change == "service-scopes" ? [McpServiceTokenProvider.ProductsReadScope] : null,
            requireCustomerChatTools: true));

        Assert.Equal(0, provider.Calls);
        Assert.Equal(0, handler.McpRequests);
        Assert.Empty(handler.ResponseRequests);
    }

    [Fact]
    public async Task Customer_chat_rejects_a_cached_fallback_and_never_uses_one_after_enumeration_failure()
    {
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        using var fallbackHandler = new FoundryHandler { DefinitionStatus = HttpStatusCode.Forbidden };
        var fallbackClient = CreateClient(fallbackHandler, telemetry, fallbackMcpUrl: "https://mcp.test/mcp");
        await fallbackClient.InvokeAsync("eshop-chat-agent", "Unguarded", toolChoice: "none");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => fallbackClient.InvokeAsync(
            "eshop-chat-agent", "Check availability", mcpAccessToken: "user-token",
            requireCustomerChatTools: true));
        Assert.Single(fallbackHandler.ResponseRequests);
        Assert.Equal(0, fallbackHandler.McpRequests);

        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = "[" + CustomerChatTool + "]",
            ResponseStatus = HttpStatusCode.BadRequest
        };
        var client = CreateClient(handler, telemetry, fallbackMcpUrl: "https://mcp.test/mcp");
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Check availability", mcpAccessToken: "user-token",
            requireCustomerChatTools: true));
        Assert.Equal(3, handler.ResponseRequests.Count);
        Assert.All(handler.ResponseRequests, body =>
            Assert.Equal(8, body.GetProperty("tools")[0].GetProperty("allowed_tools").GetArrayLength()));
    }

    [Theory]
    [InlineData("create_order", "adventureworks_mcp")]
    [InlineData("get_product_availability", "other_mcp")]
    public async Task Customer_chat_never_approves_unreviewed_tools(string name, string server)
    {
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = "[" + CustomerChatTool + "]",
            FirstResponseNeedsApproval = true,
            ApprovalToolName = name,
            ApprovalServer = server
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry, fallbackMcpUrl: "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Check availability",
            mcpAccessToken: "user-token", requireCustomerChatTools: true));
        Assert.Single(handler.ResponseRequests);
    }

    [Fact]
    public async Task Public_catalog_policy_sends_only_the_validated_definition_with_a_scoped_token()
    {
        using var handler = new FoundryHandler { DefinitionToolsJson = "[" + PublicCatalogTool + "]" };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await client.InvokeAsync("eshop-help-me-choose-agent", "Recommend", toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true);

        var tool = handler.ResponseRequests.Single().GetProperty("tools")[0];
        Assert.Equal("Bearer svc-token", tool.GetProperty("headers").GetProperty("Authorization").GetString());
        Assert.Equal(4, tool.GetProperty("allowed_tools").GetProperty("tool_names").GetArrayLength());
        Assert.Equal([McpServiceTokenProvider.ProductsReadScope], provider.RequestedScopes);
        var completed = Assert.Single(channel.Items.OfType<EventTelemetry>(), item => item.Name == "Foundry.Responses.Completed");
        Assert.Equal("eshop-help-me-choose-agent:1", completed.Properties["AgentVersionId"]);
        Assert.Equal("public-catalog", completed.Properties["ToolPolicy"]);
    }

    [Fact]
    public async Task Public_catalog_trace_is_request_scoped_and_never_cached_with_the_tool_definition()
    {
        using var handler = new FoundryHandler { DefinitionToolsJson = "[" + PublicCatalogTool + "]" };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        var traces = new List<string>();
        for (var index = 0; index < 2; index++)
        {
            using var activity = new Activity("public-catalog-test").SetIdFormat(ActivityIdFormat.W3C).Start();
            traces.Add(activity.Id!);
            await client.InvokeAsync("eshop-help-me-choose-agent", "Recommend", toolChoice: "required",
                mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true);
        }

        Assert.NotEqual(traces[0], traces[1]);
        Assert.Equal(1, handler.DefinitionRequests);
        Assert.Equal(traces, handler.ResponseRequests.Select(body =>
            body.GetProperty("tools")[0].GetProperty("headers").GetProperty("traceparent").GetString()).ToArray());
        await client.InvokeAsync("eshop-help-me-choose-agent", "Untraced", toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true);
        Assert.False(handler.ResponseRequests.Last().GetProperty("tools")[0].GetProperty("headers")
            .TryGetProperty("traceparent", out _));
    }

    [Theory]
    [InlineData("""{"output":"products","status":"completed"}""", "search_products")]
    [InlineData("""{"output":"products"}""", "")]
    [InlineData("""{"status":"completed"}""", "")]
    public async Task Completion_telemetry_only_confirms_mcp_calls_with_completed_status_and_output(string result, string expected)
    {
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = "[" + PublicCatalogTool + "]",
            ToolName = "search_products",
            ToolResult = result
        };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await client.InvokeAsync("eshop-help-me-choose-agent", "Recommend", toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true);

        var completed = Assert.Single(channel.Items.OfType<EventTelemetry>(), item => item.Name == "Foundry.Responses.Completed");
        Assert.Equal(expected, completed.Properties["CompletedMcpTools"]);
    }

    [Theory]
    [InlineData("delegated")]
    [InlineData("broader")]
    [InlineData("missing")]
    public async Task Public_catalog_policy_rejects_non_catalog_credentials_before_fetching_definition(string credential)
    {
        using var handler = new FoundryHandler { DefinitionToolsJson = "[" + PublicCatalogTool + "]" };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        var scopes = credential switch
        {
            "missing" => null,
            "broader" => new[] { McpServiceTokenProvider.ProductsReadScope, McpServiceTokenProvider.AdminWriteScope },
            _ => new[] { McpServiceTokenProvider.ProductsReadScope }
        };

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "eshop-help-me-choose-agent", "Recommend", mcpServiceScopes: scopes,
            mcpAccessToken: credential == "delegated" ? "user-token" : null, requirePublicCatalogTools: true));
        Assert.Equal(0, handler.DefinitionRequests);
        Assert.Equal(0, provider.Calls);
        Assert.Empty(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("missing-allow-list")]
    [InlineData("empty-allow-list")]
    [InlineData("extra-tool")]
    [InlineData("duplicate-tool")]
    [InlineData("different-server")]
    [InlineData("different-path")]
    [InlineData("static-header")]
    [InlineData("static-authorization")]
    [InlineData("project-connection")]
    [InlineData("additional-server")]
    public async Task Public_catalog_policy_rejects_unreviewed_tools_before_token_or_external_calls(string change)
    {
        var tool = JsonNode.Parse(PublicCatalogTool)!.AsObject();
        var tools = new JsonArray(tool);
        var names = tool["allowed_tools"]!["tool_names"]!.AsArray();
        switch (change)
        {
            case "missing-allow-list": tool.Remove("allowed_tools"); break;
            case "empty-allow-list": names.Clear(); break;
            case "extra-tool": names.Add("create_order"); break;
            case "duplicate-tool": names.Add("search_products"); break;
            case "different-server": tool["server_url"] = "https://other.test/mcp"; break;
            case "different-path": tool["server_url"] = "https://mcp.test/other"; break;
            case "static-header": tool["headers"] = new JsonObject { ["Authorization"] = "preconfigured" }; break;
            case "static-authorization": tool["authorization"] = "preconfigured"; break;
            case "project-connection": tool["project_connection_id"] = "connection"; break;
            case "additional-server": tools.Add(JsonNode.Parse(PublicCatalogTool)); break;
        }

        using var handler = new FoundryHandler { DefinitionToolsJson = tools.ToJsonString() };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "eshop-help-me-choose-agent", "Recommend", toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true));

        Assert.Equal(0, provider.Calls);
        Assert.Equal(0, handler.McpRequests);
        Assert.Empty(handler.ResponseRequests);
    }

    [Fact]
    public async Task Public_catalog_policy_checks_the_cached_definition_and_rejects_cached_fallbacks()
    {
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        using var handler = new FoundryHandler();
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        await client.InvokeAsync("eshop-help-me-choose-agent", "Cached", toolChoice: "none");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "eshop-help-me-choose-agent", "Recommend",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true));
        Assert.Equal(1, handler.DefinitionRequests);
        Assert.Single(handler.ResponseRequests);
        Assert.Equal(0, provider.Calls);

        using var fallbackHandler = new FoundryHandler { DefinitionStatus = HttpStatusCode.Forbidden };
        var fallbackProvider = new StubServiceTokenProvider(fallbackHandler, "https://mcp.test/mcp");
        var fallbackClient = CreateClient(fallbackHandler, telemetry, fallbackProvider, "https://mcp.test/mcp");
        await fallbackClient.InvokeAsync("eshop-help-me-choose-agent", "Cached fallback", toolChoice: "none");
        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => fallbackClient.InvokeAsync(
            "eshop-help-me-choose-agent", "Recommend",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true));
        Assert.Single(fallbackHandler.ResponseRequests);
        Assert.Equal(0, fallbackProvider.Calls);
    }

    [Fact]
    public async Task Public_catalog_policy_does_not_replace_validated_tools_with_fallback_after_enumeration_failure()
    {
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = "[" + PublicCatalogTool + "]",
            ResponseStatus = HttpStatusCode.BadRequest
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "eshop-help-me-choose-agent", "Recommend", toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true));

        Assert.Equal(3, handler.ResponseRequests.Count);
        Assert.All(handler.ResponseRequests, body =>
            Assert.Equal(4, body.GetProperty("tools")[0].GetProperty("allowed_tools").GetProperty("tool_names").GetArrayLength()));
    }

    [Theory]
    [InlineData("create_order", "adventureworks_mcp")]
    [InlineData("search_products", "other_mcp")]
    public async Task Public_catalog_policy_never_approves_unreviewed_tools(string name, string server)
    {
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = "[" + PublicCatalogTool + "]",
            FirstResponseNeedsApproval = true,
            ApprovalToolName = name,
            ApprovalServer = server
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "eshop-help-me-choose-agent", "Recommend", toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true));
        Assert.Single(handler.ResponseRequests);
    }

    [Fact]
    public async Task Public_catalog_policy_can_approve_a_reviewed_catalog_tool()
    {
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = "[" + PublicCatalogTool + "]",
            FirstResponseNeedsApproval = true,
            ApprovalToolName = "search_products",
            ApprovalServer = "adventureworks_mcp"
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await client.InvokeAsync("eshop-help-me-choose-agent", "Recommend", toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope], requirePublicCatalogTools: true);

        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.Equal("mcp_approval_response", handler.ResponseRequests[1].GetProperty("input")[0].GetProperty("type").GetString());
        Assert.True(handler.ResponseRequests[1].GetProperty("input")[0].GetProperty("approve").GetBoolean());
    }

    [Fact]
    public async Task Public_recommendations_surface_policy_failures_instead_of_returning_fallback_success()
    {
        using var handler = new FoundryHandler();
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SQL_CONNECTION_STRING"] = "unused",
            ["AI_AGENT_HELP_ME_CHOOSE_ID"] = "eshop-help-me-choose-agent"
        }).Build();
        var service = new HelpMeChooseService(NullLogger<HelpMeChooseService>.Instance, configuration,
            client, new TelemetryClient(telemetry));

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => service.GetRecommendationsAsync(
            [new WizardAnswer { QuestionId = 1, Question = "Use?", Answer = "Trail" }], "en"));
        Assert.Empty(handler.ResponseRequests);
        Assert.Equal(0, provider.Calls);
    }

    [Fact]
    public async Task Api_mcp_service_tools_require_explicit_scopes_before_foundry_invocation()
    {
        using var handler = new FoundryHandler();
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.InvokeAsync("customer-agent", "Generate", toolChoice: "required"));

        Assert.Contains("no explicit service-token scopes", error.Message);
        Assert.Empty(handler.ResponseRequests);
        Assert.Equal(0, provider.Calls);
    }

    [Fact]
    public async Task Service_token_is_not_sent_to_other_mcp_servers()
    {
        using var handler = new FoundryHandler();
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://other-mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider);

        await client.InvokeAsync("customer-agent", "Generate", toolChoice: "required");
        Assert.False(handler.ResponseRequests[0].GetProperty("tools")[0].TryGetProperty("headers", out _));
        Assert.Equal(0, provider.Calls);
    }

    [Fact]
    public async Task Delegated_mcp_token_is_not_sent_to_unrelated_mcp_servers()
    {
        using var handler = new FoundryHandler { ToolServerUrl = "https://external.example.test/mcp" };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider);

        using var activity = new Activity("unrelated-mcp").SetIdFormat(ActivityIdFormat.W3C).Start();
        await client.InvokeAsync("customer-agent", "Generate", toolChoice: "required",
            mcpAccessToken: "user-mcp-token");

        Assert.False(handler.ResponseRequests[0].GetProperty("tools")[0].TryGetProperty("headers", out _));
        Assert.Equal(0, provider.Calls);
    }

    private static FoundryAgentClient CreateClient(
        FoundryHandler handler, TelemetryConfiguration telemetry, McpServiceTokenProvider? provider = null,
        string fallbackMcpUrl = "https://fallback.test/mcp") =>
        new(NullLogger<FoundryAgentClient>.Instance, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            fallbackMcpServiceUrl: fallbackMcpUrl, serviceTokenProvider: provider);

    private sealed class CapturingTelemetryChannel : ITelemetryChannel
    {
        public List<ITelemetry> Items { get; } = [];
        public bool? DeveloperMode { get; set; }
        public string EndpointAddress { get; set; } = string.Empty;
        public void Send(ITelemetry item) => Items.Add(item);
        public void Flush() { }
        public void Dispose() { }
    }

    private sealed class CapturingLogger : ILogger<FoundryAgentClient>
    {
        public List<string> Messages { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Messages.Add(formatter(state, exception));
    }

    private sealed class StubServiceTokenProvider(FoundryHandler handler, string mcpUrl)
        : McpServiceTokenProvider(new TestCredential(), new TestHttpClientFactory(handler),
            NullLogger<McpServiceTokenProvider>.Instance, mcpUrl)
    {
        public int Calls { get; private set; }
        public IReadOnlyCollection<string>? RequestedScopes { get; private set; }

        public override Task<string?> GetTokenAsync(
            IReadOnlyCollection<string> scopes,
            CancellationToken cancellationToken)
        {
            Calls++;
            RequestedScopes = scopes.ToArray();
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
        public string ApprovalToolName { get; init; } = "get_customer_orders";
        public string ApprovalServer { get; init; } = "aw";
        public string DefinitionKind { get; init; } = "prompt";
        public bool DefinitionHasInstructions { get; init; } = true;
        public bool DefinitionHasTools { get; init; } = true;
        public HttpStatusCode DefinitionStatus { get; init; } = HttpStatusCode.OK;
        public string? ToolResult { get; init; }
        public string ToolName { get; init; } = "get_customer_orders";
        public string? CustomResponse { get; init; }
        public int CustomResponseRound { get; init; }
        public string ToolServerUrl { get; init; } = "https://mcp.test/mcp";
        public string? DefinitionToolsJson { get; init; }
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
                    versions = new { latest = new { id = "eshop-help-me-choose-agent:1", definition = new
                    {
                        kind = DefinitionKind,
                        model = "chat",
                        instructions = DefinitionHasInstructions ? "Generate JSON." : null,
                        tools = DefinitionHasTools
                            ? DefinitionToolsJson is null
                                ? (object)new[] { new { type = "mcp", server_label = "aw", server_url = ToolServerUrl } }
                                : JsonSerializer.Deserialize<JsonElement>(DefinitionToolsJson)
                            : Array.Empty<object>()
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
                return JsonResponse(HttpStatusCode.OK, JsonSerializer.Serialize(new
                {
                    id = "resp-approval",
                    output = new[] { new { type = "mcp_approval_request", id = "approval-1",
                        name = ApprovalToolName, server_label = ApprovalServer } }
                }));
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
                tool["name"] = JsonSerializer.SerializeToElement(ToolName);
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
