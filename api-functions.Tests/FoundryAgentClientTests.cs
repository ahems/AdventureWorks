using System.Net;
using System.Diagnostics;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using api_functions.Functions;
using api_functions.Models;
using api_functions.Services;
using ApiFunctions.Auth;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.Core.Serialization;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Channel;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace ApiFunctions.Tests;

public class FoundryAgentClientTests
{
    [Theory]
    [InlineData("match")]
    [InlineData("mismatch")]
    [InlineData("unverifiable")]
    [InlineData("unconfigured")]
    public async Task Completed_response_records_only_the_result_of_the_credential_client_check(string expected)
    {
        var clientId = Guid.NewGuid();
        var token = expected == "unverifiable"
            ? "private.invalid.token"
            : MakeToken(expected == "mismatch" ? Guid.NewGuid() : clientId);
        using var handler = new FoundryHandler();
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var client = new FoundryAgentClient(NullLogger<FoundryAgentClient>.Instance,
            new TelemetryClient(telemetry), new SequencedCredential(token, token),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            expectedClientId: expected == "unconfigured" ? null : clientId);

        await client.InvokeAsync("agent", "Use supplied data", toolChoice: "none");

        var completed = Assert.Single(channel.Items.OfType<EventTelemetry>(),
            item => item.Name == "Foundry.Responses.Completed");
        Assert.Equal(expected, completed.Properties["CredentialClientMatch"]);
        var clientHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(clientId.ToString("D"))))
            .ToLowerInvariant();
        Assert.Equal(expected == "unconfigured" ? "unconfigured" : clientHash,
            completed.Properties["CredentialExpectedClientHash"]);
        var properties = JsonSerializer.Serialize(completed.Properties);
        Assert.DoesNotContain(token, properties);
        Assert.DoesNotContain(clientId.ToString(), properties);
    }

    [Fact]
    public async Task Credential_check_tracks_the_token_for_each_completed_response_not_the_definition_fetch()
    {
        var clientId = Guid.NewGuid();
        var selected = MakeToken(clientId);
        var other = MakeToken(Guid.NewGuid());
        using var handler = new FoundryHandler { FirstResponseIsToolOnly = true };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var credential = new SequencedCredential(selected, other, selected);
        var client = new FoundryAgentClient(NullLogger<FoundryAgentClient>.Instance,
            new TelemetryClient(telemetry), credential,
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            expectedClientId: clientId);

        await client.InvokeAsync("agent", "Use MCP", toolChoice: "required", mcpAccessToken: "user");

        var completions = channel.Items.OfType<EventTelemetry>()
            .Where(item => item.Name == "Foundry.Responses.Completed")
            .ToArray();
        Assert.Equal(["mismatch", "match"], completions.Select(item => item.Properties["CredentialClientMatch"]));
        Assert.Equal(["required", "none"], completions.Select(item => item.Properties["RequestToolChoice"]));
        Assert.Equal(["true", "false"], completions.Select(item => item.Properties["RequestToolsOffered"]));
    }

    [Fact]
    public async Task Rejected_foundry_response_does_not_emit_completed_identity_evidence()
    {
        var clientId = Guid.NewGuid();
        var token = MakeToken(clientId);
        using var handler = new FoundryHandler { ResponseStatus = HttpStatusCode.Forbidden };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var client = new FoundryAgentClient(NullLogger<FoundryAgentClient>.Instance,
            new TelemetryClient(telemetry), new SequencedCredential(token, token),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            expectedClientId: clientId);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.InvokeAsync("agent", "Use supplied data", toolChoice: "none"));

        Assert.DoesNotContain(channel.Items.OfType<EventTelemetry>(),
            item => item.Name == "Foundry.Responses.Completed");
    }

    [Fact]
    public async Task Rejected_foundry_response_logs_only_identifier_shaped_error_fields()
    {
        using var handler = new FoundryHandler
        {
            ResponseStatus = HttpStatusCode.Forbidden,
            CustomResponse = """{"error":{"code":"permission_denied","type":"rate limit with spaces","message":"echoed private prompt"}}"""
        };
        var logger = new CapturingLogger<FoundryAgentClient>();
        var client = new FoundryAgentClient(logger, new TelemetryClient(new TelemetryConfiguration()),
            new TestCredential(), "https://foundry.test/api/projects/demo",
            new TestHttpClientFactory(handler));

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.InvokeAsync("agent", "Use supplied data", toolChoice: "none"));

        var logged = Assert.Single(logger.Messages, message => message.StartsWith("Foundry Responses API returned 403"));
        Assert.Contains("error code permission_denied, type other", logged);
        Assert.Contains("remaining tokens none", logged);
        Assert.Contains("structured inputs 0)", logged);
        Assert.DoesNotContain("echoed private prompt", string.Join("\n", logger.Messages));
    }

    [Theory]
    [InlineData(true, "eshop-help-me-choose-agent:1")]
    [InlineData(false, "unknown")]
    public async Task Tool_free_calls_record_the_fetched_version_and_fallback_mode(bool definitionAvailable, string version)
    {
        using var handler = new FoundryHandler
        {
            DefinitionHasTools = false,
            DefinitionStatus = definitionAvailable ? HttpStatusCode.OK : HttpStatusCode.Forbidden
        };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var client = CreateClient(handler, telemetry);

        await client.InvokeAsync("agent", "Use supplied data", toolChoice: "none");

        var completed = Assert.Single(channel.Items.OfType<EventTelemetry>(),
            item => item.Name == "Foundry.Responses.Completed");
        Assert.Equal(version, completed.Properties["AgentVersionId"]);
        Assert.Equal("true", completed.Properties["AgentDefinitionFallback"]);
        Assert.Equal("none", completed.Properties["RequestToolChoice"]);
        Assert.Equal("false", completed.Properties["RequestToolsOffered"]);
        Assert.Equal("0", completed.Properties["ToolCallCount"]);
        Assert.False(handler.ResponseRequests.Single().TryGetProperty("tools", out _));
        Assert.Equal(0, handler.McpRequests);
    }

    [Fact]
    public async Task Empty_output_records_only_content_free_shape_diagnostics()
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = """{"id":"resp-test","status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"private reasoning"}]},{"type":"message","content":[{"type":"private text!","text":"hidden"}]}]}"""
        };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var client = CreateClient(handler, telemetry);

        var result = await client.InvokeAsync("agent", "Use supplied data", toolChoice: "none");

        Assert.Equal(string.Empty, result.ResponseText);
        var completed = Assert.Single(channel.Items.OfType<EventTelemetry>(),
            item => item.Name == "Foundry.Responses.Completed");
        Assert.Equal("reasoning,message,message/other", completed.Properties["OutputItemTypes"]);
        Assert.Equal("false", completed.Properties["UsageReported"]);
        Assert.DoesNotContain("private", string.Join("|", completed.Properties.Values));
    }

    [Fact]
    public async Task Tool_free_calls_never_approve_an_unsolicited_tool_request()
    {
        using var handler = new FoundryHandler { FirstResponseNeedsApproval = true };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() =>
            client.InvokeAsync("agent", "Use supplied data", toolChoice: "none"));

        Assert.Single(handler.ResponseRequests);
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData("mcp_call")]
    [InlineData("function_call")]
    public async Task Tool_free_calls_reject_unsolicited_completed_tool_output(string type)
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = JsonSerializer.Serialize(new
            {
                id = "resp-test", status = "completed", output = new[] { new { type } }
            })
        };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var client = CreateClient(handler, telemetry);

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() =>
            client.InvokeAsync("agent", "Use supplied data", toolChoice: "none"));

        Assert.Single(handler.ResponseRequests);
        Assert.Equal(0, handler.McpRequests);
        Assert.DoesNotContain(channel.Items.OfType<EventTelemetry>(),
            item => item.Name == "Foundry.Responses.Completed");
    }

    [Theory]
    [InlineData("mcp_approval_request")]
    [InlineData("mcp_call")]
    [InlineData("function_call")]
    public async Task Tool_free_continuations_reject_unsolicited_tool_output(string type)
    {
        using var handler = new FoundryHandler
        {
            FirstResponseIsToolOnly = true,
            CustomResponseRound = 2,
            CustomResponse = JsonSerializer.Serialize(new
            {
                id = "resp-continuation", status = "completed", output = new[] { new { type } }
            })
        };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var client = CreateClient(handler, telemetry);

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() =>
            client.InvokeAsync("agent", "Use tools", toolChoice: "required", mcpAccessToken: "test"));

        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.Equal("none", handler.ResponseRequests[1].GetProperty("tool_choice").GetString());
        Assert.Single(channel.Items.OfType<EventTelemetry>(), item => item.Name == "Foundry.Responses.Completed");
    }

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

    [Fact]
    public async Task Draft_generation_uses_tool_free_definition_without_fallback_augmentation()
    {
        using var handler = new FoundryHandler { DefinitionHasTools = false };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };

        await CreateClient(handler, telemetry).InvokeAsync(
            "manufacturing-content-agent", "Draft", toolChoice: "none", requireConfiguredDefinition: true);

        var completed = Assert.Single(channel.Items.OfType<EventTelemetry>(),
            item => item.Name == "Foundry.Responses.Completed");
        Assert.Equal("false", completed.Properties["AgentDefinitionFallback"]);
        Assert.False(handler.ResponseRequests.Single().TryGetProperty("tools", out _));
        Assert.Equal(0, handler.McpRequests);
    }

    [Fact]
    public async Task Cached_tool_free_definition_does_not_satisfy_tool_using_guarded_chat()
    {
        using var handler = new FoundryHandler { DefinitionHasTools = false };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);
        await client.InvokeAsync("eshop-chat-agent", "Draft", toolChoice: "none", requireConfiguredDefinition: true);

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Hello", contentFilterPolicy: "AdventureWorks-Eshop"));
        Assert.Single(handler.ResponseRequests);
    }

    [Fact]
    public async Task Draft_generation_rejects_definition_without_instructions()
    {
        using var handler = new FoundryHandler { DefinitionHasTools = false, DefinitionHasInstructions = false };
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

    [Theory]
    [InlineData(HttpStatusCode.NotFound, """{"error":{"message":"Response not found"}}""")]
    [InlineData(HttpStatusCode.BadRequest, """{"error":{"code":"invalid_parameters","type":"invalid_request_error","message":"Malformed identifier. [Request ID: private]"}}""")]
    public async Task Unavailable_conversation_identifiers_are_denied_without_a_followup(
        HttpStatusCode status, string body)
    {
        using var handler = new FoundryHandler { OwnershipStatus = status, OwnershipResponse = body };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var logger = new CapturingLogger<FoundryAgentClient>();
        var client = new FoundryAgentClient(logger, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler));

        await Assert.ThrowsAsync<ChatConversationException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Continue", previousResponseId: "private-response-id",
            conversationOwner: "owner", toolChoice: "none"));

        Assert.Equal(1, handler.OwnershipRequests);
        Assert.Empty(handler.ResponseRequests);
        Assert.Contains(logger.Messages, message => message.Contains("continuation rejected", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(logger.Messages, message => message.Contains("private", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest, """{"error":{"code":"invalid_parameters","message":"An unrelated parameter is invalid."}}""")]
    [InlineData(HttpStatusCode.BadRequest, """{"error":{"code":"other_error","message":"Malformed identifier."}}""")]
    [InlineData(HttpStatusCode.BadRequest, "not json")]
    [InlineData(HttpStatusCode.BadRequest, "[]")]
    [InlineData(HttpStatusCode.Unauthorized, "{}")]
    [InlineData(HttpStatusCode.Forbidden, "{}")]
    [InlineData(HttpStatusCode.TooManyRequests, "{}")]
    [InlineData(HttpStatusCode.InternalServerError, "{}")]
    [InlineData(HttpStatusCode.ServiceUnavailable, "{}")]
    public async Task Conversation_lookup_upstream_failures_remain_visible(HttpStatusCode status, string body)
    {
        using var handler = new FoundryHandler { OwnershipStatus = status, OwnershipResponse = body };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        var error = await Assert.ThrowsAsync<HttpRequestException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Continue", previousResponseId: "resp-owned",
            conversationOwner: "owner", toolChoice: "none"));

        Assert.Equal(status, error.StatusCode);
        Assert.Equal(1, handler.OwnershipRequests);
        Assert.Empty(handler.ResponseRequests);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public async Task Externally_supplied_continuations_require_a_validated_owner_before_any_io(string? owner)
    {
        using var handler = new FoundryHandler();
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        await Assert.ThrowsAsync<ChatConversationException>(() => client.InvokeAsync(
            "promotion-agent", "Continue", previousResponseId: "resp-untrusted",
            conversationOwner: owner, toolChoice: "none"));

        Assert.Equal(0, handler.DefinitionRequests);
        Assert.Equal(0, handler.OwnershipRequests);
        Assert.Empty(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("""{"aw_chat_owner":42,"aw_chat_agent":"eshop-chat-agent"}""")]
    [InlineData("""{"aw_chat_owner":"owner","aw_chat_agent":null}""")]
    [InlineData("""{"aw_chat_owner":"owner"}""")]
    public async Task Invalid_conversation_metadata_is_denied_without_a_followup(string metadata)
    {
        using var handler = new FoundryHandler { OwnershipResponse = JsonSerializer.Serialize(new
        {
            metadata = JsonSerializer.Deserialize<JsonElement>(metadata)
        }) };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry);

        await Assert.ThrowsAsync<ChatConversationException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Continue", previousResponseId: "resp-owned",
            conversationOwner: "owner", toolChoice: "none"));

        Assert.Equal(1, handler.OwnershipRequests);
        Assert.Empty(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("product", null, false)]
    [InlineData("product", "forged-subject", false)]
    [InlineData("promotion", null, false)]
    [InlineData("promotion", "forged-subject", false)]
    [InlineData("order", null, false)]
    [InlineData("order", "forged-subject", false)]
    public async Task Internal_agent_handlers_require_a_validated_caller_before_accessing_services(
        string operation, string? subject, bool authenticated)
    {
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        using var context = new AgentRequestContext(subject, authenticated);
        var request = new AgentRequest(context, "{}");

        var response = operation switch
        {
            "product" => await new GenerateProductContentFunction(
                NullLogger<GenerateProductContentFunction>.Instance, null!, telemetryClient)
                .GenerateProductContent(request),
            "promotion" => await new GeneratePromotionFunction(
                NullLogger<GeneratePromotionFunction>.Instance, null!, telemetryClient)
                .GeneratePromotion(request),
            "order" => await new GenerateOrderWithAIFunction(
                NullLogger<GenerateOrderWithAIFunction>.Instance, null!, telemetryClient)
                .GenerateOrderWithAI(request),
            _ => throw new InvalidOperationException("Unexpected operation")
        };

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData("review")]
    [InlineData("recovery")]
    public async Task Empty_analysis_input_is_rejected_before_agent_service_access(string operation)
    {
        using var context = new AgentRequestContext("admin", true);
        var body = operation == "review" ? """{"reviews":[]}""" : """{"carts":[]}""";
        var request = new AgentRequest(context, body);
        var response = operation == "review"
            ? await new ReviewAnalysisFunction(NullLogger<ReviewAnalysisFunction>.Instance, null!, null!)
                .AnalyzeReviewsBatch(request)
            : await new CartRecoveryAnalysisFunction(NullLogger<CartRecoveryAnalysisFunction>.Instance, null!, null!)
                .AnalyzeCartRecovery(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        response.Body.Position = 0;
        using var document = await JsonDocument.ParseAsync(response.Body);
        Assert.Equal(operation == "review"
                ? "reviews array is required and must not be empty"
                : "carts array is required and must not be empty",
            document.RootElement.GetProperty("error").GetString());
    }

    [Theory]
    [InlineData("review")]
    [InlineData("recovery")]
    public async Task Analysis_services_do_not_offer_tools_for_supplied_data(string operation)
    {
        var resultText = operation == "review"
            ? """[{"productReviewId":42,"sentiment":"positive","flags":[],"suggestedResponse":"Thank you"}]"""
            : """[{"cartId":"fixture","recoveryScore":50,"urgency":"low","strategy":"test"}]""";
        using var handler = new FoundryHandler
        {
            CustomResponse = JsonSerializer.Serialize(new
            {
                id = "resp-test",
                status = "completed",
                output = new[]
                {
                    new { type = "message", content = new[] { new { type = "output_text", text = resultText } } }
                }
            })
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_REVIEW_ANALYSIS_ID"] = "review-agent",
            ["AI_AGENT_CART_RECOVERY_ID"] = "recovery-agent"
        }).Build();
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider);

        if (operation == "review")
        {
            var service = new ReviewAnalysisAgentService(
                NullLogger<ReviewAnalysisAgentService>.Instance, config, client, telemetryClient);
            Assert.Empty(await service.AnalyzeReviewsAsync([]));
            Assert.Equal(0, handler.DefinitionRequests);
            Assert.Empty(handler.ResponseRequests);
            var result = Assert.Single(await service.AnalyzeReviewsAsync(
                [new ReviewInput { ProductReviewId = 42, Rating = 5, Comments = "Synthetic" }]));
            Assert.Equal(42, result.ProductReviewId);
            Assert.Null(result.Error);
        }
        else
        {
            var service = new CartRecoveryAgentService(
                NullLogger<CartRecoveryAgentService>.Instance, config, client, telemetryClient);
            Assert.Empty(await service.AnalyzeCartsAsync([]));
            Assert.Equal(0, handler.DefinitionRequests);
            Assert.Empty(handler.ResponseRequests);
            var result = Assert.Single(await service.AnalyzeCartsAsync(
                [new CartRecoveryInput { CartId = "fixture", CustomerName = "Synthetic" }]));
            Assert.Equal("fixture", result.CartId);
            Assert.Null(result.Error);
        }

        var sent = Assert.Single(handler.ResponseRequests);
        Assert.Equal("none", sent.GetProperty("tool_choice").GetString());
        Assert.False(sent.TryGetProperty("tools", out _));
        Assert.Equal(0, provider.Calls);
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData("review")]
    [InlineData("recovery")]
    public async Task Analysis_memory_is_isolated_per_request_and_shared_within_batches(string operation)
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = """{"id":"resp-test","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"[]"}]}]}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = AnalysisAgentConfiguration();
        var client = CreateClient(handler, telemetry);

        if (operation == "review")
        {
            var service = new ReviewAnalysisAgentService(
                NullLogger<ReviewAnalysisAgentService>.Instance, config, client, telemetryClient);
            for (var invocation = 0; invocation < 2; invocation++)
                await service.AnalyzeReviewsAsync(Enumerable.Range(1, 11)
                    .Select(i => new ReviewInput { ProductReviewId = i, Comments = "Synthetic" }).ToList());
        }
        else
        {
            var service = new CartRecoveryAgentService(
                NullLogger<CartRecoveryAgentService>.Instance, config, client, telemetryClient);
            for (var invocation = 0; invocation < 2; invocation++)
                await service.AnalyzeCartsAsync(Enumerable.Range(1, 11)
                    .Select(i => new CartRecoveryInput { CartId = i.ToString(), CustomerName = "Synthetic" }).ToList());
        }

        Assert.Equal(4, handler.MemoryUserIds.Count);
        var prefix = operation == "review" ? "review-analysis-" : "cart-recovery-analysis-";
        Assert.All(handler.MemoryUserIds, value =>
        {
            Assert.NotNull(value);
            Assert.StartsWith(prefix, value);
            Assert.True(Guid.TryParseExact(value[prefix.Length..], "N", out _));
            Assert.DoesNotContain("Synthetic", value);
        });
        Assert.Equal(handler.MemoryUserIds[0], handler.MemoryUserIds[1]);
        Assert.Equal(handler.MemoryUserIds[2], handler.MemoryUserIds[3]);
        Assert.NotEqual(handler.MemoryUserIds[0], handler.MemoryUserIds[2]);
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData("review", 1)]
    [InlineData("review", 2)]
    [InlineData("recovery", 1)]
    [InlineData("recovery", 2)]
    public async Task Analysis_policy_rejection_stops_later_batches(string operation, int rejectedRound)
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = """{"id":"resp-test","status":"completed","output":[{"type":"mcp_call"}]}""",
            CustomResponseRound = rejectedRound,
            FirstResponseText = "[]"
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = AnalysisAgentConfiguration();
        var client = CreateClient(handler, telemetry);

        await Assert.ThrowsAsync<FoundryToolPolicyException>(async () =>
        {
            if (operation == "review")
            {
                var service = new ReviewAnalysisAgentService(
                    NullLogger<ReviewAnalysisAgentService>.Instance, config, client, telemetryClient);
                await service.AnalyzeReviewsAsync(Enumerable.Range(1, 21)
                    .Select(i => new ReviewInput { ProductReviewId = i }).ToList());
            }
            else
            {
                var service = new CartRecoveryAgentService(
                    NullLogger<CartRecoveryAgentService>.Instance, config, client, telemetryClient);
                await service.AnalyzeCartsAsync(Enumerable.Range(1, 21)
                    .Select(i => new CartRecoveryInput { CartId = i.ToString() }).ToList());
            }
        });

        Assert.Equal(rejectedRound, handler.ResponseRequests.Count);
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData("review")]
    [InlineData("recovery")]
    public async Task Analysis_handlers_return_failure_after_a_policy_rejection(string operation)
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = """{"id":"resp-test","status":"completed","output":[{"type":"mcp_call"}]}""",
            CustomResponseRound = 2,
            FirstResponseText = "[]"
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = AnalysisAgentConfiguration();
        var client = CreateClient(handler, telemetry);
        using var context = new AgentRequestContext("admin", true);
        var items = Enumerable.Range(1, 21).Select(i => new
        {
            productReviewId = i, cartId = i.ToString()
        }).ToArray();
        var body = operation == "review"
            ? JsonSerializer.Serialize(new { reviews = items })
            : JsonSerializer.Serialize(new { carts = items });
        var request = new AgentRequest(context, body);

        var response = operation == "review"
            ? await new ReviewAnalysisFunction(NullLogger<ReviewAnalysisFunction>.Instance,
                new ReviewAnalysisAgentService(NullLogger<ReviewAnalysisAgentService>.Instance,
                    config, client, telemetryClient), telemetryClient).AnalyzeReviewsBatch(request)
            : await new CartRecoveryAnalysisFunction(NullLogger<CartRecoveryAnalysisFunction>.Instance,
                new CartRecoveryAgentService(NullLogger<CartRecoveryAgentService>.Instance,
                    config, client, telemetryClient), telemetryClient).AnalyzeCartRecovery(request);

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        response.Body.Position = 0;
        using var document = await JsonDocument.ParseAsync(response.Body);
        Assert.Equal("An unexpected error occurred", document.RootElement.GetProperty("error").GetString());
        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData("review")]
    [InlineData("recovery")]
    public async Task Analysis_services_preserve_non_policy_batch_fallbacks(string operation)
    {
        using var handler = new FoundryHandler { ResponseStatus = HttpStatusCode.BadRequest };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = AnalysisAgentConfiguration();
        var client = CreateClient(handler, telemetry);

        if (operation == "review")
        {
            var service = new ReviewAnalysisAgentService(
                NullLogger<ReviewAnalysisAgentService>.Instance, config, client, telemetryClient);
            var result = await service.AnalyzeReviewsAsync(Enumerable.Range(1, 11)
                .Select(i => new ReviewInput { ProductReviewId = i }).ToList());
            Assert.Equal(11, result.Count);
            Assert.All(result, item => Assert.Equal("Analysis unavailable", item.Error));
        }
        else
        {
            var service = new CartRecoveryAgentService(
                NullLogger<CartRecoveryAgentService>.Instance, config, client, telemetryClient);
            var result = await service.AnalyzeCartsAsync(Enumerable.Range(1, 11)
                .Select(i => new CartRecoveryInput { CartId = i.ToString() }).ToList());
            Assert.Equal(11, result.Count);
            Assert.All(result, item => Assert.Equal("Analysis unavailable", item.Error));
        }

        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.Equal(0, handler.McpRequests);
    }

    [Fact]
    public async Task Moderation_policy_rejection_persists_terminal_state_and_skips_queued_items()
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = """{"id":"resp-test","status":"completed","output":[{"type":"mcp_call"}]}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var service = new ReviewAnalysisAgentService(NullLogger<ReviewAnalysisAgentService>.Instance,
            AnalysisAgentConfiguration(), CreateClient(handler, telemetry), telemetryClient);
        var publisher = new WebPubSubService(null, new DefaultAzureCredential(),
            NullLogger<WebPubSubService>.Instance);
        using var tableHandler = new ModerationTableHandler();
        using var tableTransport = new HttpClient(tableHandler);
        var options = new TableClientOptions { Transport = new HttpClientTransport(tableTransport) };
        options.Retry.MaxRetries = 0;
        var table = new TableClient(new Uri("https://unit.table.core.windows.net"), "reviewModeration",
            new TestCredential(), options);
        var reviewService = new ReviewService("not-a-connection-string", "unused", publisher,
            moderationTable: table);
        var function = new ReviewModerationQueueFunction(
            NullLogger<ReviewModerationQueueFunction>.Instance, reviewService, service, telemetryClient, publisher);
        BinaryData Message(int reviewId) => BinaryData.FromString(JsonSerializer.Serialize(
            new ReviewModerationQueueMessage { JobId = "job-1", ProductReviewId = reviewId }));

        await function.QueueTrigger(Message(1));
        await function.QueueTrigger(Message(2));
        await reviewService.IncrementReviewModerationProgressAsync("job-1",
            success: true, skipped: false, failed: false, lastError: null);
        var state = await reviewService.GetReviewModerationJobStateAsync();

        Assert.False(state.IsRunning);
        Assert.Equal(3, state.QueuedCount);
        Assert.Equal(2, state.ProcessedCount);
        Assert.Equal(1, state.SuccessCount);
        Assert.Equal(1, state.FailedCount);
        Assert.NotNull(state.CompletedAt);
        Assert.Equal("Review moderation stopped because the agent requested an unapproved tool.", state.LastError);
        Assert.Equal(2, tableHandler.UpdateAttempts);
        Assert.Single(handler.ResponseRequests);
    }

    [Fact]
    public async Task Moderation_skips_an_inflight_write_when_another_worker_stopped_the_job()
    {
        using var tableHandler = new ModerationTableHandler();
        using var handler = new FoundryHandler
        {
            FirstResponseText = """[{"productReviewId":1,"sentiment":"positive","flags":[],"suggestedResponse":"Thank you"}]""",
            OnResponse = tableHandler.StopExternally
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var service = new ReviewAnalysisAgentService(NullLogger<ReviewAnalysisAgentService>.Instance,
            AnalysisAgentConfiguration(), CreateClient(handler, telemetry), telemetryClient);
        var publisher = new WebPubSubService(null, new DefaultAzureCredential(),
            NullLogger<WebPubSubService>.Instance);
        using var tableTransport = new HttpClient(tableHandler);
        var options = new TableClientOptions { Transport = new HttpClientTransport(tableTransport) };
        options.Retry.MaxRetries = 0;
        var table = new TableClient(new Uri("https://unit.table.core.windows.net"), "reviewModeration",
            new TestCredential(), options);
        var reviewService = new ReviewService("not-a-connection-string", "unused", publisher,
            moderationTable: table);
        var logger = new CapturingLogger<ReviewModerationQueueFunction>();
        var function = new ReviewModerationQueueFunction(logger, reviewService, service, telemetryClient, publisher);
        var message = BinaryData.FromString(JsonSerializer.Serialize(
            new ReviewModerationQueueMessage { JobId = "job-1", ProductReviewId = 1 }));

        await function.QueueTrigger(message);

        Assert.Single(handler.ResponseRequests);
        Assert.Empty(logger.Exceptions);
        Assert.Equal(0, tableHandler.UpdateAttempts);
        Assert.Contains(logger.Messages, entry => entry.Contains("Skipping moderation write", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Email_content_memory_is_isolated_between_customer_requests()
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = """{"id":"resp-test","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"subject\":\"Synthetic subject\",\"body\":\"Synthetic body\"}"}]}]}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_EMAIL_CONTENT_ID"] = "email-agent"
        }).Build();
        var service = new EmailContentAgentService(NullLogger<EmailContentAgentService>.Instance,
            config, CreateClient(handler, telemetry), new TelemetryClient(telemetry));

        foreach (var firstName in new[] { "SyntheticOne", "SyntheticTwo" })
        {
            var result = await service.GenerateEmailContentAsync(new EmailContentRequest
            {
                FirstName = firstName, TemplateType = "same-template"
            });
            Assert.Null(result.Error);
            Assert.Equal("Synthetic subject", result.Subject);
        }

        Assert.Equal(2, handler.MemoryUserIds.Count);
        Assert.NotEqual(handler.MemoryUserIds[0], handler.MemoryUserIds[1]);
        Assert.All(handler.MemoryUserIds, value =>
        {
            Assert.NotNull(value);
            Assert.StartsWith("email-", value);
            Assert.True(Guid.TryParseExact(value["email-".Length..], "N", out _));
            Assert.DoesNotContain("Synthetic", value);
            Assert.DoesNotContain("same-template", value);
        });
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Email_content_handler_surfaces_policy_errors_and_preserves_ordinary_fallbacks(bool policy)
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = policy
                ? """{"id":"resp-test","status":"completed","output":[{"type":"mcp_call"}]}"""
                : """{"error":{"message":"synthetic-private-data"}}""",
            ResponseStatus = policy ? HttpStatusCode.OK : HttpStatusCode.BadRequest
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_EMAIL_CONTENT_ID"] = "email-agent"
        }).Build();
        var service = new EmailContentAgentService(NullLogger<EmailContentAgentService>.Instance,
            config, CreateClient(handler, telemetry), telemetryClient);
        var function = new GenerateEmailContentFunction(
            NullLogger<GenerateEmailContentFunction>.Instance, service, telemetryClient);
        using var context = new AgentRequestContext("admin", true);
        var response = await function.GenerateEmailContent(new AgentRequest(context,
            """{"firstName":"Synthetic","templateType":"fixture"}"""));

        Assert.Equal(policy ? HttpStatusCode.BadGateway : HttpStatusCode.OK, response.StatusCode);
        response.Body.Position = 0;
        using var document = await JsonDocument.ParseAsync(response.Body);
        Assert.Equal(policy ? "Content generation stopped because the agent requested an unapproved tool."
                            : "Content generation unavailable",
            document.RootElement.GetProperty("error").GetString());
        if (policy)
            Assert.Equal("agent_tool_policy_violation", document.RootElement.GetProperty("code").GetString());
        else
            Assert.False(document.RootElement.TryGetProperty("code", out _));
        Assert.DoesNotContain("synthetic-private-data", document.RootElement.GetRawText());
        Assert.Single(handler.ResponseRequests);
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Secondary_translation_policy_errors_stop_before_description_persistence(bool policy)
    {
        using var handler = new FoundryHandler
        {
            FirstResponseText = """{"translations":[{"CultureID":"fr","TranslatedText":"Synthetic"}]}""",
            CustomResponse = policy
                ? """{"id":"resp-test","status":"completed","output":[{"type":"mcp_call"}]}"""
                : """{"error":{"message":"ordinary failure"}}""",
            CustomResponseStatus = policy ? HttpStatusCode.OK : HttpStatusCode.BadRequest,
            CustomResponseRound = 2
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_TRANSLATION_ID"] = "translation-agent"
        }).Build();
        var translation = new TranslationAgentService(NullLogger<TranslationAgentService>.Instance,
            config, CreateClient(handler, telemetry), new TelemetryClient(telemetry));
        var product = new StubTranslationProductService();
        using var services = new ServiceCollection().AddSingleton<ProductService>(product).BuildServiceProvider();
        var request = new TranslationRequest
        {
            ProductModelID = 42, ProductID = 43, ProductName = "Synthetic", EnglishDescription = "Synthetic description"
        };

        async Task Invoke()
        {
            var function = new AIJobProcessorFunction(NullLogger<AIJobProcessorFunction>.Instance,
                NullLoggerFactory.Instance, services, product, null!, null!, translation, null!, null!);
            var message = BinaryData.FromString(JsonSerializer.Serialize(
                new AiJobMessage { JobType = "translation", ProductModelId = request.ProductModelID }));
            await function.AIJobProcessor_Chat_QueueTrigger(message, null!);
        }

        if (policy)
            await Assert.ThrowsAsync<FoundryToolPolicyException>(Invoke);
        else
            await Invoke();

        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.Equal(policy ? 0 : 1, product.DescriptionSaveCalls);
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData("review")]
    [InlineData("recovery")]
    [InlineData("email")]
    public async Task Data_supplied_handlers_correlate_foundry_completion_to_the_host_trace(string operation)
    {
        const string traceId = "8d454f22361140e8b3f05a33c8f11d1f";
        const string traceParent = "00-" + traceId + "-0123456789abcdef-01";
        using var handler = new FoundryHandler
        {
            FirstResponseText = operation switch
            {
                "review" => """[{"productReviewId":42,"sentiment":"positive","flags":[],"suggestedResponse":"Thanks"}]""",
                "recovery" => """[{"cartId":"synthetic","recoveryScore":50,"urgency":"medium"}]""",
                _ => """{"subject":"Synthetic subject","body":"Synthetic body"}"""
            }
        };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        telemetry.TelemetryInitializers.Add(new OperationCorrelationTelemetryInitializer());
        var telemetryClient = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_REVIEW_ANALYSIS_ID"] = "review-agent",
            ["AI_AGENT_CART_RECOVERY_ID"] = "recovery-agent",
            ["AI_AGENT_EMAIL_CONTENT_ID"] = "email-agent"
        }).Build();
        var foundry = CreateClient(handler, telemetry);
        using var context = new AgentRequestContext("admin", true, traceParent);
        using var outer = new Activity("unrelated").SetIdFormat(ActivityIdFormat.W3C).Start();

        var response = operation switch
        {
            "review" => await new ReviewAnalysisFunction(NullLogger<ReviewAnalysisFunction>.Instance,
                new ReviewAnalysisAgentService(NullLogger<ReviewAnalysisAgentService>.Instance, config, foundry, telemetryClient),
                telemetryClient).AnalyzeReviewsBatch(new AgentRequest(context,
                    """{"reviews":[{"productReviewId":42,"rating":5,"comments":"Synthetic"}]}""")),
            "recovery" => await new CartRecoveryAnalysisFunction(NullLogger<CartRecoveryAnalysisFunction>.Instance,
                new CartRecoveryAgentService(NullLogger<CartRecoveryAgentService>.Instance, config, foundry, telemetryClient),
                telemetryClient).AnalyzeCartRecovery(new AgentRequest(context,
                    """{"carts":[{"cartId":"synthetic","customerName":"Synthetic"}]}""")),
            _ => await new GenerateEmailContentFunction(NullLogger<GenerateEmailContentFunction>.Instance,
                new EmailContentAgentService(NullLogger<EmailContentAgentService>.Instance, config, foundry, telemetryClient),
                telemetryClient).GenerateEmailContent(new AgentRequest(context,
                    """{"firstName":"Synthetic","templateType":"fixture"}"""))
        };

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var completed = Assert.Single(channel.Items.OfType<EventTelemetry>(),
            item => item.Name == "Foundry.Responses.Completed");
        Assert.Equal(traceId, completed.Context.Operation.Id);
        Assert.Same(outer, Activity.Current);
    }

    [Theory]
    [InlineData("category", true)]
    [InlineData("category", false)]
    [InlineData("subcategory", true)]
    [InlineData("subcategory", false)]
    public async Task Ai_category_generation_defers_writes_until_translation_policy_is_satisfied(string type, bool policy)
    {
        var product = new StubCategoryProductService();
        using var handler = new FoundryHandler
        {
            FirstResponseText = """{"suggested":true,"name":"Synthetic category"}""",
            CustomResponse = policy
                ? """{"id":"resp-test","status":"completed","output":[{"type":"mcp_call"}]}"""
                : """{"id":"resp-test","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"translations\":[{\"CultureID\":\"fr\",\"TranslatedText\":\"Synthetic French\"}]}"}]}]}""",
            CustomResponseRound = 2,
            OnResponse = () => Assert.Empty(product.Writes)
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_CATALOG_SUGGESTION_ID"] = "catalog-agent",
            ["AI_AGENT_TRANSLATION_ID"] = "translation-agent"
        }).Build();
        var foundry = CreateClient(handler, telemetry);
        var function = new CategoryManagementFunctions(
            NullLogger<CategoryManagementFunctions>.Instance, product,
            new TranslationAgentService(NullLogger<TranslationAgentService>.Instance, config, foundry, telemetryClient),
            new CatalogSuggestionAgentService(NullLogger<CatalogSuggestionAgentService>.Instance, config, foundry, telemetryClient),
            telemetryClient);
        using var context = new AgentRequestContext("admin", true);
        var response = await function.GenerateCategoryWithAI(new AgentRequest(context,
            JsonSerializer.Serialize(new { type, categoryId = 42, categoryName = "Synthetic parent" })));

        Assert.Equal(policy ? HttpStatusCode.InternalServerError : HttpStatusCode.OK, response.StatusCode);
        response.Body.Position = 0;
        using var document = await JsonDocument.ParseAsync(response.Body);
        Assert.Equal(!policy, document.RootElement.GetProperty("created").GetBoolean());
        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.Equal(0, handler.McpRequests);
        if (policy)
        {
            Assert.Empty(product.Writes);
        }
        else
        {
            var id = type == "subcategory" ? 101 : 100;
            var parentId = type == "subcategory" ? 42 : 0;
            Assert.Equal(id, document.RootElement.GetProperty("id").GetInt32());
            Assert.Equal(new[]
            {
                (type, id, parentId, "en", "Synthetic category"),
                (type, id, parentId, "fr", "Synthetic French"),
                (type, id, parentId, "en-GB", "Synthetic category")
            }, product.Writes);
        }
    }

    [Theory]
    [InlineData("reviews")]
    [InlineData("replies")]
    public async Task Review_batch_agents_propagate_unsolicited_tool_calls(string operation)
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = """{"id":"resp-test","status":"completed","output":[{"type":"mcp_call"}]}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_REVIEW_BATCH_ID"] = "review-batch-agent"
        }).Build();
        var service = new ReviewBatchAgentService(NullLogger<ReviewBatchAgentService>.Instance,
            config, CreateClient(handler, telemetry), new TelemetryClient(telemetry));

        await Assert.ThrowsAsync<FoundryToolPolicyException>(async () =>
        {
            if (operation == "reviews")
                await service.GenerateProductReviewsAsync(
                    [new ProductForReviewGeneration { ProductID = 42, Name = "Synthetic" },
                     new ProductForReviewGeneration { ProductID = 43, Name = "Second" }]);
            else
                await service.GenerateReviewRepliesAsync([(42, "Synthetic", 5, "Test", "Product")]);
        });

        Assert.Single(handler.ResponseRequests);
        Assert.Equal(0, handler.McpRequests);
    }

    [Theory]
    [InlineData("reviews")]
    [InlineData("replies")]
    public async Task Review_batch_agents_preserve_non_policy_error_fallbacks(string operation)
    {
        using var handler = new FoundryHandler { ResponseStatus = HttpStatusCode.BadRequest };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_REVIEW_BATCH_ID"] = "review-batch-agent"
        }).Build();
        var logger = new CapturingLogger<ReviewBatchAgentService>();
        var service = new ReviewBatchAgentService(logger, config, CreateClient(handler, telemetry),
            new TelemetryClient(telemetry));

        if (operation == "reviews")
            Assert.Empty(await service.GenerateProductReviewsAsync(
                [new ProductForReviewGeneration { ProductID = 42, Name = "Synthetic" }]));
        else
            Assert.Empty(await service.GenerateReviewRepliesAsync([(42, "Synthetic", 5, "Test", "Product")]));

        Assert.Single(handler.ResponseRequests);
        Assert.Single(logger.Exceptions);
    }

    [Theory]
    [InlineData("review")]
    [InlineData("reply")]
    public async Task Verified_review_job_stops_after_tool_policy_rejection(string stage)
    {
        using var handler = new FoundryHandler
        {
            CustomResponse = """{"id":"resp-test","status":"completed","output":[{"type":"mcp_call"}]}""",
            CustomResponseRound = stage == "reply" ? 2 : 1,
            FirstResponseText = """{"Rating":5,"Comments":"Synthetic review"}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        using var tableHandler = new InMemoryTableHandler();
        tableHandler.Seed(InMemoryTableHandler.VerifiedReviewsState("job-1", totalCount: 2, productsTotal: 2));
        var (function, reviews) = CreateVerifiedReviewsFunction(handler, telemetry, tableHandler);

        await function.ProcessVerifiedReviewsQueueMessage(VerifiedReviewsMessage("job-1", 42, "Synthetic", 1));
        var requestsAfterStop = handler.ResponseRequests.Count;
        await function.ProcessVerifiedReviewsQueueMessage(VerifiedReviewsMessage("job-1", 43, "Second", 2));

        Assert.Equal(stage == "reply" ? 2 : 1, requestsAfterStop);
        Assert.Equal(requestsAfterStop, handler.ResponseRequests.Count);
        Assert.Equal(0, handler.McpRequests);
        Assert.Equal(stage == "reply" ? 1 : 0, reviews.SavedCount);
        var state = await reviews.GetVerifiedReviewsJobStateAsync();
        Assert.False(state.IsRunning);
        Assert.Equal(stage == "reply" ? 1 : 0, state.ProcessedCount);
        Assert.Equal(0, state.ProductsProcessed);
        Assert.Equal("The agent returned a tool call while tools were disabled.", state.LastError);
    }

    [Fact]
    public async Task Redelivered_verified_review_message_does_not_regenerate_or_double_count()
    {
        using var handler = new FoundryHandler { FirstResponseText = """{"Rating":5,"Comments":"Synthetic review"}""" };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        using var tableHandler = new InMemoryTableHandler();
        tableHandler.Seed(InMemoryTableHandler.VerifiedReviewsState("job-1", totalCount: 2, productsTotal: 2));
        var (function, reviews) = CreateVerifiedReviewsFunction(handler, telemetry, tableHandler);
        var first = VerifiedReviewsMessage("job-1", 42, "Synthetic", 1);

        await function.ProcessVerifiedReviewsQueueMessage(first);
        var requestsAfterFirst = handler.ResponseRequests.Count;
        await function.ProcessVerifiedReviewsQueueMessage(first);

        Assert.Equal(1, reviews.SavedCount);
        Assert.Equal(requestsAfterFirst, handler.ResponseRequests.Count);
        var state = await reviews.GetVerifiedReviewsJobStateAsync();
        Assert.True(state.IsRunning);
        Assert.Equal(1, state.ProductsProcessed);
        Assert.Equal(1, state.ProcessedCount);

        // Customer 2 is no longer eligible (e.g. reviewed elsewhere); the product still completes the job.
        reviews.Ineligible.Add(2);
        await function.ProcessVerifiedReviewsQueueMessage(VerifiedReviewsMessage("job-1", 43, "Second", 2));

        state = await reviews.GetVerifiedReviewsJobStateAsync();
        Assert.False(state.IsRunning);
        Assert.Equal(2, state.ProductsProcessed);
        Assert.Equal(2, state.ProcessedCount);
        Assert.NotNull(state.CompletedAt);
        Assert.Equal(requestsAfterFirst, handler.ResponseRequests.Count);
    }

    private (GenerateVerifiedReviewsFunction Function, StubReviewService Reviews) CreateVerifiedReviewsFunction(
        FoundryHandler handler, TelemetryConfiguration telemetry, InMemoryTableHandler tableHandler)
    {
        var telemetryClient = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_REVIEW_ID"] = "review-agent",
            ["AI_AGENT_REVIEW_BATCH_ID"] = "review-batch-agent"
        }).Build();
        var reviewAgent = new ReviewAgentService(NullLogger<ReviewAgentService>.Instance,
            config, CreateClient(handler, telemetry), telemetryClient);
        var reviewBatchAgent = new ReviewBatchAgentService(NullLogger<ReviewBatchAgentService>.Instance,
            config, CreateClient(handler, telemetry), telemetryClient);
        var publisher = new WebPubSubService(null, new DefaultAzureCredential(),
            NullLogger<WebPubSubService>.Instance);
        var options = new TableClientOptions { Transport = new HttpClientTransport(new HttpClient(tableHandler, false)) };
        options.Retry.MaxRetries = 0;
        var table = new TableClient(new Uri("https://unit.table.core.windows.net"), "verifiedReviewsJob",
            new TestCredential(), options);
        var reviews = new StubReviewService(publisher, table);
        var queue = new VerifiedReviewsQueue(new Azure.Storage.Queues.QueueClient(
            new Uri("https://unit.queue.core.windows.net/verified-reviews-queue"), new TestCredential()));
        var function = new GenerateVerifiedReviewsFunction(NullLogger<GenerateVerifiedReviewsFunction>.Instance,
            reviewAgent, reviewBatchAgent, reviews, telemetryClient, publisher, queue);
        return (function, reviews);
    }

    private static BinaryData VerifiedReviewsMessage(string jobId, int productId, string name, int customerId) =>
        BinaryData.FromString(JsonSerializer.Serialize(new VerifiedReviewsQueueMessage
        {
            JobId = jobId,
            Product = new ProductForReviewGeneration { ProductID = productId, Name = name },
            CustomerIds = [customerId]
        }));

    [Fact]
    public async Task Review_agent_does_not_log_unparseable_generated_content()
    {
        const string privateContent = "sensitive-model-response-must-not-be-logged";
        using var handler = new FoundryHandler
        {
            CustomResponse = JsonSerializer.Serialize(new
            {
                id = "resp-test",
                status = "completed",
                output = new[]
                {
                    new { type = "message", content = new[] { new { type = "output_text", text = privateContent } } }
                }
            })
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_REVIEW_ID"] = "review-agent"
        }).Build();
        var logger = new CapturingLogger<ReviewAgentService>();
        var service = new ReviewAgentService(logger, config, CreateClient(handler, telemetry),
            new TelemetryClient(telemetry));

        var result = await service.GenerateReviewAsync(
            new ProductForReviewGeneration { ProductID = 42, Name = "Synthetic" },
            new CustomerWithDeliveredOrder { CustomerID = 7 });

        Assert.Null(result);
        Assert.DoesNotContain(logger.Messages, message => message.Contains(privateContent, StringComparison.Ordinal));
        Assert.DoesNotContain(logger.Exceptions, error => error.ToString().Contains(privateContent, StringComparison.Ordinal));
        Assert.Contains(logger.Messages, message => message.Contains("response length", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Product_content_handler_binds_initial_and_resumed_conversations_to_the_validated_subject()
    {
        using var handler = new FoundryHandler { OwnershipSubject = "owner-A", OwnershipAgent = "product-agent" };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_PRODUCT_CONTENT_ID"] = "product-agent"
        }).Build();
        var service = new ProductContentAgentService(NullLogger<ProductContentAgentService>.Instance,
            config, CreateClient(handler, telemetry), telemetryClient);
        var function = new GenerateProductContentFunction(
            NullLogger<GenerateProductContentFunction>.Instance, service, telemetryClient);
        const string initial = """{"category":"Bikes","subcategory":"Test"}""";
        const string continuation = """{"category":"Bikes","subcategory":"Test","previousResponseId":"resp-owned","conversationOwner":"owner-A"}""";

        using var first = new AgentRequestContext("owner-A", true);
        Assert.Equal(HttpStatusCode.OK, (await function.GenerateProductContent(new AgentRequest(first, initial))).StatusCode);
        var metadata = handler.ResponseRequests.Single().GetProperty("metadata");
        Assert.Equal("owner-A", metadata.GetProperty("aw_chat_owner").GetString());
        Assert.Equal("product-agent", metadata.GetProperty("aw_chat_agent").GetString());

        using var foreign = new AgentRequestContext("owner-B", true);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await function.GenerateProductContent(new AgentRequest(foreign, continuation))).StatusCode);
        Assert.Single(handler.ResponseRequests);

        using var owner = new AgentRequestContext("owner-A", true);
        Assert.Equal(HttpStatusCode.OK,
            (await function.GenerateProductContent(new AgentRequest(owner, continuation))).StatusCode);
        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.Equal(2, handler.OwnershipRequests);
    }

    [Fact]
    public async Task Order_agent_handler_denies_a_foreign_conversation_before_order_creation()
    {
        using var handler = new FoundryHandler
        {
            OwnershipSubject = "owner-A",
            OwnershipAgent = "order-agent",
            DefinitionToolsJson = new JsonArray(MutationAgentTool("order")).ToJsonString()
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_ORDER_ID"] = "order-agent"
        }).Build();
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var service = new OrderGenerationAgentService(NullLogger<OrderGenerationAgentService>.Instance,
            config, telemetryClient, null!, null!, null!, CreateClient(handler, telemetry, provider, "https://mcp.test/mcp"));
        var function = new GenerateOrderWithAIFunction(
            NullLogger<GenerateOrderWithAIFunction>.Instance, service, telemetryClient);
        const string body = """{"personaType":"newbie-male","previousThreadId":"resp-owned","conversationOwner":"owner-A"}""";

        using var foreign = new AgentRequestContext("owner-B", true);
        var response = await function.GenerateOrderWithAI(new AgentRequest(foreign, body));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(1, handler.OwnershipRequests);
        Assert.Empty(handler.ResponseRequests);
        Assert.Equal(0, handler.McpRequests);
    }

    [Fact]
    public async Task Chat_handler_binds_conversations_to_the_validated_token_subject_not_the_body()
    {
        const string issuer = "https://issuer.example.test/";
        using var rsa = RSA.Create(2048);
        var key = new RsaSecurityKey(rsa) { KeyId = "chat-test-key" };
        var oidc = new Microsoft.IdentityModel.Protocols.OpenIdConnect.OpenIdConnectConfiguration { Issuer = issuer };
        oidc.SigningKeys.Add(key);
        var validator = new FunctionsAccessTokenValidator(new FunctionsOAuthOptions
        {
            Issuer = issuer, Audience = issuer + "functions", MetadataAddress = issuer + "metadata",
            Mode = OAuthEnforcementMode.Enforced, ClockSkew = TimeSpan.Zero,
        }, NullLogger<FunctionsAccessTokenValidator>.Instance,
            new Microsoft.IdentityModel.Protocols.StaticConfigurationManager<
                Microsoft.IdentityModel.Protocols.OpenIdConnect.OpenIdConnectConfiguration>(oidc));
        string Token(string subject) => new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().CreateToken(
            new SecurityTokenDescriptor
            {
                Issuer = issuer, Audience = issuer + "mcp",
                Claims = new Dictionary<string, object>
                {
                    ["sub"] = subject, ["category"] = "employee", ["scope"] = "mcp.access sales.read"
                },
                IssuedAt = DateTime.UtcNow.AddMinutes(-1), NotBefore = DateTime.UtcNow.AddMinutes(-1),
                Expires = DateTime.UtcNow.AddMinutes(5),
                SigningCredentials = new SigningCredentials(key, SecurityAlgorithms.RsaSha256),
            });

        using var handler = new FoundryHandler
        {
            OwnershipSubject = "owner-A", OwnershipAgent = "admin-chat-agent",
            DefinitionToolsJson = "[" + AdminChatTool + "]"
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_CHAT_ID"] = "eshop-chat-agent",
            ["AI_AGENT_ADMIN_CHAT_ID"] = "admin-chat-agent"
        }).Build();
        var service = new AIAgentService(NullLogger<AIAgentService>.Instance, config,
            CreateClient(handler, telemetry, fallbackMcpUrl: "https://mcp.test/mcp"), telemetryClient);
        var function = new AIAgentFunctions(NullLogger<AIAgentFunctions>.Instance, service, telemetryClient,
            new ChatIdentityService(validator, new ConfigurationBuilder().Build(),
                NullLogger<ChatIdentityService>.Instance));

        async Task<(HttpStatusCode Status, JsonElement Body)> Send(string subject, string body)
        {
            using var context = new AgentRequestContext(null, false);
            var request = new AgentRequest(context, body);
            request.Headers.Add("Authorization", "Bearer " + Token(subject));
            var response = await function.Chat(request);
            response.Body.Position = 0;
            return (response.StatusCode, JsonDocument.Parse(response.Body).RootElement.Clone());
        }

        var initial = await Send("owner-A", """{"message":"Sales overview","isAdmin":true}""");
        Assert.Equal(HttpStatusCode.OK, initial.Status);
        var metadata = handler.ResponseRequests.Single().GetProperty("metadata");
        Assert.Equal("owner-A", metadata.GetProperty("aw_chat_owner").GetString());
        Assert.Equal("admin-chat-agent", metadata.GetProperty("aw_chat_agent").GetString());

        const string continuation = """
            {"message":"Continue","isAdmin":true,"threadId":"resp-owned","conversationOwner":"owner-A","userName":"owner-A"}
            """;
        var foreign = await Send("owner-B", continuation);
        Assert.Equal(HttpStatusCode.OK, foreign.Status);
        Assert.Equal("conversation-ownership", foreign.Body.GetProperty("safety").GetProperty("source").GetString());
        Assert.Single(handler.ResponseRequests);

        var owner = await Send("owner-A", continuation);
        Assert.Equal(HttpStatusCode.OK, owner.Status);
        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.Equal(2, handler.OwnershipRequests);
    }

    [Fact]
    public async Task Promotion_handler_binds_resumed_conversations_to_the_validated_subject()
    {
        var suggestion = JsonSerializer.Serialize(new
        {
            description = "Synthetic", discountPct = 10, type = "Clearance", category = "Customer",
            startDate = "2026-01-01", endDate = "2026-01-31", minQty = 1, aiReasoning = "Synthetic",
            suggestedProducts = Array.Empty<object>()
        });
        using var handler = new FoundryHandler
        {
            OwnershipSubject = "owner-A",
            OwnershipAgent = "promotion-agent",
            CustomResponse = JsonSerializer.Serialize(new
            {
                id = "resp-promotion", status = "completed",
                output = new[] { new { type = "message", content = new[] { new { type = "output_text", text = suggestion } } } }
            })
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_PROMOTION_ID"] = "promotion-agent"
        }).Build();
        var service = new PromotionAgentService(NullLogger<PromotionAgentService>.Instance, config,
            CreateClient(handler, telemetry), telemetryClient, new SyntheticPromotionProducts());
        var function = new GeneratePromotionFunction(
            NullLogger<GeneratePromotionFunction>.Instance, service, telemetryClient);
        const string initial = """{"promotionType":"Clearance","offerCategory":"Customer"}""";
        const string continuation = """
            {"promotionType":"Clearance","offerCategory":"Customer","previousThreadId":"resp-owned","conversationOwner":"owner-A"}
            """;

        using var first = new AgentRequestContext("owner-A", true);
        Assert.Equal(HttpStatusCode.OK, (await function.GeneratePromotion(new AgentRequest(first, initial))).StatusCode);
        var metadata = handler.ResponseRequests.Single().GetProperty("metadata");
        Assert.Equal("owner-A", metadata.GetProperty("aw_chat_owner").GetString());
        Assert.Equal("promotion-agent", metadata.GetProperty("aw_chat_agent").GetString());

        using var foreign = new AgentRequestContext("owner-B", true);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await function.GeneratePromotion(new AgentRequest(foreign, continuation))).StatusCode);
        Assert.Single(handler.ResponseRequests);

        using var owner = new AgentRequestContext("owner-A", true);
        Assert.Equal(HttpStatusCode.OK,
            (await function.GeneratePromotion(new AgentRequest(owner, continuation))).StatusCode);
        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.Equal(2, handler.OwnershipRequests);
    }

    private sealed class SyntheticPromotionProducts() : ProductService("Server=unused")
    {
        public override Task<string> GetProductsWithPromotionDataAsync(
            string promotionType, int? categoryId = null, int? subcategoryId = null, int topN = 20) =>
            Task.FromResult("[]");
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
        using var handler = new FoundryHandler { OwnershipAgent = "promotion-agent" };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider);

        foreach (var previousId in new string?[] { null, "resp-previous" })
        {
            var response = await client.InvokeAsync(
                "promotion-agent", "Live product data", previousResponseId: previousId,
                toolChoice: "none", additionalInstructions: "Use server-loaded data only.",
                conversationOwner: "owner");

            Assert.Equal("resp-test", response.ResponseId);
            Assert.Equal("Generated promotion", response.ResponseText);
        }

        Assert.Equal(1, handler.DefinitionRequests);
        Assert.Equal(1, handler.OwnershipRequests);
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
        Assert.NotEmpty(handler.ClientNames);
        Assert.All(handler.ClientNames, name => Assert.Equal(nameof(FoundryAgentClient), name));
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

    public static IEnumerable<object[]> MutationAgentDefects =>
        from operation in new[] { "customer", "order" }
        from defect in new[]
        {
            "missing-scopes", "missing-scope", "broader-scope", "duplicate-scope", "delegated",
            "wrong-choice", "multiple-policies", "missing-allow-list", "extra-tool", "missing-tool",
            "duplicate-tool", "wrong-server", "wrong-path", "wrong-label", "provider-mismatch",
            "static-header", "static-authorization", "unknown-property", "additional-server",
            "unavailable-definition", "missing-instructions", "missing-tools"
        }
        select new object[] { operation, defect };

    [Theory]
    [MemberData(nameof(MutationAgentDefects))]
    public async Task Mutation_agent_policy_rejects_unreviewed_credentials_and_definitions(
        string operation, string defect)
    {
        var tool = MutationAgentTool(operation);
        var names = tool["allowed_tools"]!.AsArray();
        var tools = new JsonArray(tool);
        switch (defect)
        {
            case "missing-allow-list": tool.Remove("allowed_tools"); break;
            case "extra-tool": names.Add("create_order"); break;
            case "missing-tool": names.RemoveAt(0); break;
            case "duplicate-tool": names.Add(names[0]!.GetValue<string>()); break;
            case "wrong-server": tool["server_url"] = "https://other.test/mcp"; break;
            case "wrong-path": tool["server_url"] = "https://mcp.test/other"; break;
            case "wrong-label": tool["server_label"] = "other_mcp"; break;
            case "static-header": tool["headers"] = new JsonObject { ["Authorization"] = "stored-secret" }; break;
            case "static-authorization": tool["authorization"] = "stored-secret"; break;
            case "unknown-property": tool["unreviewed"] = true; break;
            case "additional-server": tools.Add(MutationAgentTool(operation)); break;
        }

        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = tools.ToJsonString(),
            DefinitionStatus = defect == "unavailable-definition" ? HttpStatusCode.Forbidden : HttpStatusCode.OK,
            DefinitionHasInstructions = defect != "missing-instructions",
            DefinitionHasTools = defect != "missing-tools"
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler,
            defect == "provider-mismatch" ? "https://other.test/mcp" : "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        var scopes = MutationAgentScopes(operation);
        IReadOnlyCollection<string>? requestedScopes = defect switch
        {
            "missing-scopes" => null,
            "missing-scope" => scopes.Skip(1).ToArray(),
            "broader-scope" => scopes.Append("sales.read").ToArray(),
            "duplicate-scope" => scopes.Append(scopes[0]).ToArray(),
            _ => scopes
        };

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => InvokeMutationAgent(
            client, operation, requestedScopes, mcpAccessToken: defect == "delegated" ? "user-token" : null,
            toolChoice: defect == "wrong-choice" ? "none" : null, multiplePolicies: defect == "multiple-policies"));

        var rejectedBeforeDefinition = defect is "missing-scopes" or "missing-scope" or "broader-scope" or
            "duplicate-scope" or "delegated" or "wrong-choice" or "multiple-policies";
        Assert.Equal(rejectedBeforeDefinition ? 0 : 1, handler.DefinitionRequests);
        Assert.Equal(0, provider.Calls);
        Assert.Equal(0, handler.McpRequests);
        Assert.Empty(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("customer")]
    [InlineData("order")]
    public async Task Mutation_services_use_provisioned_tools_and_exact_scopes_before_persistence(string operation)
    {
        using var handler = new FoundryHandler { DefinitionToolsJson = new JsonArray(MutationAgentTool(operation)).ToJsonString() };
        var channel = new CapturingTelemetryChannel();
        using var telemetry = new TelemetryConfiguration
        {
            ConnectionString = $"InstrumentationKey={Guid.NewGuid()}",
            TelemetryChannel = channel
        };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        var configuration = MutationAgentConfiguration();
        var telemetryClient = new TelemetryClient(telemetry);
        var orderService = new OrderGenerationService("unused", NullLogger<OrderGenerationService>.Instance);

        if (operation == "customer")
        {
            var service = new CustomerGenerationAgentService(
                NullLogger<CustomerGenerationAgentService>.Instance, configuration, telemetryClient, orderService, client);
            await Assert.ThrowsAsync<JsonException>(() => service.GenerateCustomerAsync("en"));
        }
        else
        {
            var service = new OrderGenerationAgentService(
                NullLogger<OrderGenerationAgentService>.Instance, configuration, telemetryClient, orderService,
                new ReceiptService("unused"), new PdfReceiptGenerator(NullLogger<PdfReceiptGenerator>.Instance), client);
            var result = await service.GenerateOrderAsync("newbie-male", null);
            Assert.False(result.Success);
            Assert.Equal(OrderPlanFailureCodes.InvalidJson, result.FailureCode);
        }

        Assert.Equal(1, provider.Calls);
        Assert.Equal(MutationAgentScopes(operation).Order(StringComparer.Ordinal),
            provider.RequestedScopes!.Order(StringComparer.Ordinal));
        var sent = Assert.Single(handler.ResponseRequests);
        Assert.Equal(operation == "customer" ? "auto" : "required", sent.GetProperty("tool_choice").GetString());
        var offered = sent.GetProperty("tools")[0];
        Assert.Equal("Bearer svc-token", offered.GetProperty("headers").GetProperty("Authorization").GetString());
        Assert.Equal(MutationAgentTool(operation)["allowed_tools"]!.AsArray()
                .Select(name => name!.GetValue<string>()).Order(StringComparer.Ordinal),
            offered.GetProperty("allowed_tools").EnumerateArray()
                .Select(name => name.GetString()!).Order(StringComparer.Ordinal));
        var completed = Assert.Single(channel.Items.OfType<EventTelemetry>(),
            item => item.Name == "Foundry.Responses.Completed");
        Assert.Equal(operation + "-generation", completed.Properties["ToolPolicy"]);
    }

    [Theory]
    [InlineData("customer")]
    [InlineData("order")]
    public async Task Mutation_services_reject_unreviewed_tool_definitions_before_persistence(string operation)
    {
        var tool = MutationAgentTool(operation);
        tool["allowed_tools"]!.AsArray().Add("create_order");
        using var handler = new FoundryHandler { DefinitionToolsJson = new JsonArray(tool).ToJsonString() };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        var configuration = MutationAgentConfiguration();
        var telemetryClient = new TelemetryClient(telemetry);
        var orderService = new OrderGenerationService("unused", NullLogger<OrderGenerationService>.Instance);

        if (operation == "customer")
        {
            var service = new CustomerGenerationAgentService(
                NullLogger<CustomerGenerationAgentService>.Instance, configuration, telemetryClient, orderService, client);
            await Assert.ThrowsAsync<FoundryToolPolicyException>(() => service.GenerateCustomerAsync("en"));
        }
        else
        {
            var service = new OrderGenerationAgentService(
                NullLogger<OrderGenerationAgentService>.Instance, configuration, telemetryClient, orderService,
                new ReceiptService("unused"), new PdfReceiptGenerator(NullLogger<PdfReceiptGenerator>.Instance), client);
            var result = await service.GenerateOrderAsync("newbie-male", null);
            Assert.False(result.Success);
            Assert.Equal(OrderPlanFailureCodes.UnhandledError, result.FailureCode);
        }

        Assert.Equal(0, provider.Calls);
        Assert.Equal(0, handler.McpRequests);
        Assert.Empty(handler.ResponseRequests);
    }

    [Fact]
    public async Task Order_generation_reports_model_throttling_as_retryable_503()
    {
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = new JsonArray(MutationAgentTool("order")).ToJsonString(),
            ResponseStatus = (HttpStatusCode)429,
            RetryAfter = TimeSpan.FromSeconds(1)
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var telemetryClient = new TelemetryClient(telemetry);
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var service = new OrderGenerationAgentService(NullLogger<OrderGenerationAgentService>.Instance,
            MutationAgentConfiguration(), telemetryClient,
            new OrderGenerationService("unused", NullLogger<OrderGenerationService>.Instance),
            new ReceiptService("unused"), new PdfReceiptGenerator(NullLogger<PdfReceiptGenerator>.Instance),
            CreateClient(handler, telemetry, provider, "https://mcp.test/mcp"));
        var function = new GenerateOrderWithAIFunction(
            NullLogger<GenerateOrderWithAIFunction>.Instance, service, telemetryClient);

        using var caller = new AgentRequestContext("owner-A", true);
        var response = await function.GenerateOrderWithAI(
            new AgentRequest(caller, """{"personaType":"newbie-male"}"""));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("1", Assert.Single(response.Headers.GetValues("Retry-After")));
        Assert.Equal(3, handler.ResponseRequests.Count);
        response.Body.Position = 0;
        using var body = JsonDocument.Parse(response.Body);
        Assert.Equal(OrderPlanFailureCodes.ModelCapacity, body.RootElement.GetProperty("failureCode").GetString());
    }

    [Fact]
    public async Task Order_generation_failures_do_not_log_the_agent_response_body()
    {
        const string privateValue = "synthetic-private-password";
        var responseText = JsonSerializer.Serialize(new { password = privateValue, creditCardNumber = "synthetic-card" });
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = new JsonArray(MutationAgentTool("order")).ToJsonString(),
            CustomResponse = JsonSerializer.Serialize(new
            {
                id = "resp-test", status = "completed",
                output = new[] { new { type = "message", content = new[] { new { type = "output_text", text = responseText } } } }
            })
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        var logger = new CapturingLogger<OrderGenerationAgentService>();
        var service = new OrderGenerationAgentService(logger, MutationAgentConfiguration(),
            new TelemetryClient(telemetry),
            new OrderGenerationService("unused", NullLogger<OrderGenerationService>.Instance),
            new ReceiptService("unused"), new PdfReceiptGenerator(NullLogger<PdfReceiptGenerator>.Instance), client);

        var result = await service.GenerateOrderAsync("newbie-male", null);

        Assert.False(result.Success);
        Assert.Equal(OrderPlanFailureCodes.MissingCustomerMode, result.FailureCode);
        Assert.Contains(logger.Messages, message => message.Contains("response body omitted", StringComparison.Ordinal));
        Assert.DoesNotContain(logger.Messages, message => message.Contains(privateValue, StringComparison.Ordinal));
        Assert.DoesNotContain(logger.Exceptions, error => error.ToString().Contains(privateValue, StringComparison.Ordinal));
        Assert.DoesNotContain(result.Log, entry => entry.Message.Contains(privateValue, StringComparison.Ordinal));
        Assert.DoesNotContain(privateValue, result.ErrorMessage ?? "");
    }

    [Theory]
    [InlineData("customer", "unknown-tool")]
    [InlineData("customer", "wrong-server")]
    [InlineData("customer", "missing-name")]
    [InlineData("customer", "function-call")]
    [InlineData("order", "unknown-tool")]
    [InlineData("order", "wrong-server")]
    [InlineData("order", "missing-name")]
    [InlineData("order", "function-call")]
    public async Task Mutation_agent_rejects_unreviewed_completed_tool_calls(string operation, string defect)
    {
        var call = new JsonObject
        {
            ["type"] = defect == "function-call" ? "function_call" : "mcp_call",
            ["name"] = defect == "unknown-tool" ? "create_order" : MutationAgentFirstTool(operation),
            ["server_label"] = defect == "wrong-server" ? "other_mcp" : "adventureworks_mcp"
        };
        if (defect == "missing-name") call.Remove("name");
        var response = new JsonObject { ["id"] = "resp-test", ["status"] = "completed", ["output"] = new JsonArray(call) };
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = new JsonArray(MutationAgentTool(operation)).ToJsonString(),
            CustomResponse = response.ToJsonString()
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() =>
            InvokeMutationAgent(client, operation, MutationAgentScopes(operation)));
        Assert.Single(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("customer", "unknown-tool")]
    [InlineData("customer", "wrong-server")]
    [InlineData("customer", "missing-id")]
    [InlineData("customer", "duplicate-id")]
    [InlineData("customer", "missing-response-id")]
    [InlineData("order", "unknown-tool")]
    [InlineData("order", "wrong-server")]
    [InlineData("order", "missing-id")]
    [InlineData("order", "duplicate-id")]
    [InlineData("order", "missing-response-id")]
    public async Task Mutation_agent_never_approves_unreviewed_or_ambiguous_requests(string operation, string defect)
    {
        var approval = new JsonObject
        {
            ["type"] = "mcp_approval_request",
            ["id"] = "approval-1",
            ["name"] = defect == "unknown-tool" ? "create_order" : MutationAgentFirstTool(operation),
            ["server_label"] = defect == "wrong-server" ? "other_mcp" : "adventureworks_mcp"
        };
        if (defect == "missing-id") approval.Remove("id");
        var output = new JsonArray(approval);
        if (defect == "duplicate-id") output.Add(approval.DeepClone());
        var response = new JsonObject { ["id"] = "resp-approval", ["output"] = output };
        if (defect == "missing-response-id") response.Remove("id");
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = new JsonArray(MutationAgentTool(operation)).ToJsonString(),
            CustomResponse = response.ToJsonString()
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() =>
            InvokeMutationAgent(client, operation, MutationAgentScopes(operation)));
        Assert.Single(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("customer")]
    [InlineData("order")]
    public async Task Mutation_agent_can_approve_a_reviewed_tool_and_rejects_cached_fallbacks(string operation)
    {
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = new JsonArray(MutationAgentTool(operation)).ToJsonString(),
            FirstResponseNeedsApproval = true,
            ApprovalToolName = MutationAgentFirstTool(operation),
            ApprovalServer = "adventureworks_mcp"
        };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");
        await InvokeMutationAgent(client, operation, MutationAgentScopes(operation));
        Assert.Equal(2, handler.ResponseRequests.Count);
        Assert.True(handler.ResponseRequests[1].GetProperty("input")[0].GetProperty("approve").GetBoolean());
        Assert.All(handler.ResponseRequests, body =>
            Assert.Equal("Bearer svc-token", body.GetProperty("tools")[0].GetProperty("headers")
                .GetProperty("Authorization").GetString()));

        using var fallbackHandler = new FoundryHandler { DefinitionStatus = HttpStatusCode.Forbidden };
        var fallbackProvider = new StubServiceTokenProvider(fallbackHandler, "https://mcp.test/mcp");
        var fallbackClient = CreateClient(fallbackHandler, telemetry, fallbackProvider, "https://mcp.test/mcp");
        await fallbackClient.InvokeAsync(operation + "-agent", "Cache fallback", toolChoice: "none");
        await Assert.ThrowsAsync<FoundryToolPolicyException>(() =>
            InvokeMutationAgent(fallbackClient, operation, MutationAgentScopes(operation)));
        Assert.Single(fallbackHandler.ResponseRequests);
        Assert.Equal(0, fallbackProvider.Calls);
    }

    [Theory]
    [InlineData("customer")]
    [InlineData("order")]
    public async Task Mutation_agent_accepts_a_reviewed_completed_tool_call(string operation)
    {
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = new JsonArray(MutationAgentTool(operation)).ToJsonString(),
            ToolName = MutationAgentFirstTool(operation),
            ToolResult = """{"status":"completed","output":"synthetic"}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        var response = await InvokeMutationAgent(client, operation, MutationAgentScopes(operation));
        Assert.Contains(MutationAgentFirstTool(operation), response.ToolsUsed);
        Assert.Single(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("customer")]
    [InlineData("order")]
    [InlineData("delegated")]
    public async Task Failed_continuations_surface_errors_without_logging_response_bodies(string operation)
    {
        using var handler = new FoundryHandler
        {
            DefinitionToolsJson = operation == "delegated" ? null : new JsonArray(MutationAgentTool(operation)).ToJsonString(),
            FirstResponseIsToolOnly = true,
            ToolName = operation == "delegated" ? "get_customer_orders" : MutationAgentFirstTool(operation),
            CustomResponseRound = 2,
            CustomResponseStatus = HttpStatusCode.BadRequest,
            CustomResponse = """{"error":{"message":"private-continuation-data"}}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var logger = new CapturingLogger<FoundryAgentClient>();
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = new FoundryAgentClient(logger, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            fallbackMcpServiceUrl: "https://mcp.test/mcp", serviceTokenProvider: provider);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => operation == "delegated"
            ? client.InvokeAsync("agent", "Generate", toolChoice: "required", mcpAccessToken: "user-token")
            : InvokeMutationAgent(client, operation, MutationAgentScopes(operation)));
        Assert.Contains("continuation API failed (400)", error.Message);
        Assert.Contains(logger.Messages, message => message.Contains("Response body omitted", StringComparison.Ordinal));
        Assert.DoesNotContain(logger.Messages, message => message.Contains("private-continuation-data", StringComparison.Ordinal));
        Assert.Equal(2, handler.ResponseRequests.Count);
    }

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
        var logger = new CapturingLogger<FoundryAgentClient>();
        var client = new FoundryAgentClient(logger, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            fallbackMcpServiceUrl: "https://mcp.test/mcp");

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "admin-chat-agent", "Show business stats", mcpAccessToken: "admin-token",
            requireAdminChatTools: true));

        Assert.Contains(logger.Messages, message => message.Contains("Response body omitted", StringComparison.Ordinal));
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

    [Theory]
    [InlineData("https://mcp.test/other", true)]
    [InlineData("https://mcp.test/mcp?other=1", true)]
    [InlineData("https://mcp.test/other", false)]
    [InlineData("https://mcp.test/mcp?other=1", false)]
    public async Task Delegated_tokens_are_not_sent_to_other_same_origin_endpoints(
        string serverUrl, bool withProvider)
    {
        using var handler = new FoundryHandler { ToolServerUrl = serverUrl };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = withProvider ? new StubServiceTokenProvider(handler, "https://mcp.test/mcp") : null;
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await client.InvokeAsync("customer-agent", "Generate", toolChoice: "required",
            mcpAccessToken: "user-mcp-token");

        Assert.False(handler.ResponseRequests.Single().GetProperty("tools")[0].TryGetProperty("headers", out _));
        if (provider is not null)
            Assert.Equal(0, provider.Calls);
    }

    [Theory]
    [InlineData("https://MCP.TEST:443/mcp")]
    [InlineData("https://mcp.test/mcp/")]
    public async Task Delegated_tokens_reach_the_configured_endpoint_with_safe_normalization(string serverUrl)
    {
        using var handler = new FoundryHandler { ToolServerUrl = serverUrl };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await client.InvokeAsync("customer-agent", "Generate", mcpAccessToken: "user-token");

        Assert.Equal("Bearer user-token", handler.ResponseRequests.Single().GetProperty("tools")[0]
            .GetProperty("headers").GetProperty("Authorization").GetString());
    }

    [Theory]
    [InlineData("https://mcp.test/other")]
    [InlineData("https://mcp.test/mcp?other=1")]
    public async Task Service_tokens_are_not_requested_for_other_same_origin_endpoints(string serverUrl)
    {
        using var handler = new FoundryHandler { ToolServerUrl = serverUrl };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await client.InvokeAsync("customer-agent", "Generate", toolChoice: "required",
            mcpServiceScopes: [McpServiceTokenProvider.ProductsReadScope]);

        Assert.Equal(0, provider.Calls);
        Assert.False(handler.ResponseRequests.Single().GetProperty("tools")[0].TryGetProperty("headers", out _));
    }

    [Fact]
    public async Task Guarded_chat_rejects_mismatched_provider_and_fallback_endpoints()
    {
        using var handler = new FoundryHandler { DefinitionToolsJson = "[" + CustomerChatTool + "]" };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://other.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "eshop-chat-agent", "Check availability", mcpAccessToken: "user-token",
            requireCustomerChatTools: true));
        Assert.Empty(handler.ResponseRequests);
    }

    [Theory]
    [InlineData("Authorization", false)]
    [InlineData("authorization", false)]
    [InlineData("authorization", true)]
    [InlineData("X-API-Key", false)]
    [InlineData("Cookie", true)]
    [InlineData("top-level", true)]
    [InlineData("project-connection", false)]
    public async Task Api_mcp_tools_reject_static_authorization_before_requesting_tokens(
        string credentialField, bool delegated)
    {
        var tool = new JsonObject
        {
            ["type"] = "mcp",
            ["server_label"] = "aw",
            ["server_url"] = "https://mcp.test/mcp"
        };
        if (credentialField == "top-level")
            tool["authorization"] = "stored-secret";
        else if (credentialField == "project-connection")
            tool["project_connection_id"] = "stored-connection";
        else
            tool["headers"] = new JsonObject { [credentialField] = "stored-secret" };

        using var handler = new FoundryHandler { DefinitionToolsJson = new JsonArray(tool).ToJsonString() };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = CreateClient(handler, telemetry, provider, "https://mcp.test/mcp");

        await Assert.ThrowsAsync<FoundryToolPolicyException>(() => client.InvokeAsync(
            "customer-agent", "Generate", toolChoice: "required",
            mcpAccessToken: delegated ? "user-token" : null,
            mcpServiceScopes: delegated ? null : [McpServiceTokenProvider.ProductsReadScope]));
        Assert.Equal(0, provider.Calls);
        Assert.Empty(handler.ResponseRequests);
    }

    [Fact]
    public async Task Credential_bearing_requests_do_not_log_foundry_error_bodies()
    {
        using var handler = new FoundryHandler
        {
            ResponseStatus = HttpStatusCode.BadRequest,
            CustomResponse = """{"error":{"message":"sensitive-response-body"}}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var logger = new CapturingLogger<FoundryAgentClient>();
        var provider = new StubServiceTokenProvider(handler, "https://mcp.test/mcp");
        var client = new FoundryAgentClient(logger, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            fallbackMcpServiceUrl: "https://mcp.test/mcp", serviceTokenProvider: provider);

        await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "customer-agent", "Generate", mcpAccessToken: "user-token"));

        Assert.Contains(logger.Messages, message => message.Contains("Response body omitted", StringComparison.Ordinal));
        Assert.DoesNotContain(logger.Messages, message => message.Contains("sensitive-response-body", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Foundry_error_and_retry_logs_omit_untrusted_response_bodies(bool retry)
    {
        using var cancellation = new CancellationTokenSource();
        using var handler = new FoundryHandler
        {
            ResponseStatus = HttpStatusCode.BadRequest,
            CustomResponse = retry
                ? """{"error":{"message":"tool_user_error synthetic-private-data"}}"""
                : """{"error":{"message":"synthetic-private-data"}}"""
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var logger = new CapturingLogger<FoundryAgentClient>
        {
            OnMessage = message =>
            {
                if (message.Contains("MCP tool enumeration failed", StringComparison.Ordinal))
                    cancellation.Cancel();
            }
        };
        var client = new FoundryAgentClient(logger, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler));

        if (retry)
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.InvokeAsync(
                "agent", "Synthetic", cancellationToken: cancellation.Token));
        else
            await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
                "agent", "Synthetic", toolChoice: "none"));

        Assert.Single(handler.ResponseRequests);
        Assert.Contains(logger.Messages, message => message.Contains("Response body omitted", StringComparison.Ordinal));
        Assert.DoesNotContain(logger.Messages, message => message.Contains("synthetic-private-data", StringComparison.Ordinal));
        Assert.DoesNotContain(logger.Exceptions, error => error.ToString().Contains("synthetic-private-data", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("success")]
    [InlineData("failure")]
    [InlineData("timeout")]
    public async Task Warmup_does_not_log_untrusted_tool_urls(string warmupMode)
    {
        using var handler = new FoundryHandler
        {
            ToolServerUrl = "https://other.test/mcp?token=private-value",
            WarmupException = warmupMode switch
            {
                "failure" => new HttpRequestException("private-value in warmup error"),
                "timeout" => new TaskCanceledException("private-value in warmup timeout"),
                _ => null
            }
        };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var logger = new CapturingLogger<FoundryAgentClient>();
        var client = new FoundryAgentClient(logger, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            fallbackMcpServiceUrl: "https://mcp.test/mcp");

        await client.InvokeAsync("agent", "Generate", mcpAccessToken: "user-token");

        Assert.Contains(logger.Messages, message => message.Contains("MCP warmup", StringComparison.Ordinal));
        Assert.DoesNotContain(logger.Messages, message => message.Contains("private-value", StringComparison.Ordinal));
        Assert.Empty(logger.Exceptions);
    }

    [Fact]
    public async Task Warmup_propagates_caller_cancellation()
    {
        using var cancellation = new CancellationTokenSource();
        using var handler = new FoundryHandler { CancelWarmup = cancellation };
        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = CreateClient(handler, telemetry, fallbackMcpUrl: "https://mcp.test/mcp");

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.InvokeAsync(
            "agent", "Generate", mcpAccessToken: "user-token", cancellationToken: cancellation.Token));

        Assert.Empty(handler.ResponseRequests);
    }

    private static FoundryAgentClient CreateClient(
        FoundryHandler handler, TelemetryConfiguration telemetry, McpServiceTokenProvider? provider = null,
        string fallbackMcpUrl = "https://fallback.test/mcp") =>
        new(NullLogger<FoundryAgentClient>.Instance, new TelemetryClient(telemetry), new TestCredential(),
            "https://foundry.test/api/projects/demo", new TestHttpClientFactory(handler),
            fallbackMcpServiceUrl: fallbackMcpUrl, serviceTokenProvider: provider);

    private static JsonObject MutationAgentTool(string operation)
    {
        var file = operation switch
        {
            "customer" => "admin-customer-agent.sh",
            "order" => "admin-order-agent.sh",
            _ => throw new ArgumentOutOfRangeException(nameof(operation))
        };
        var path = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "../../../../scripts/utilities/agents", file));
        const string prefix = "ALLOWED_TOOLS='";
        var line = File.ReadLines(path).Single(value => value.StartsWith(prefix, StringComparison.Ordinal));
        Assert.EndsWith("'", line);
        return new JsonObject
        {
            ["type"] = "mcp",
            ["server_label"] = "adventureworks_mcp",
            ["server_url"] = "https://mcp.test/mcp",
            ["allowed_tools"] = JsonNode.Parse(line[prefix.Length..^1]),
            ["require_approval"] = "never"
        };
    }

    private static string[] MutationAgentScopes(string operation) => operation switch
    {
        "customer" => [McpServiceTokenProvider.AdminWriteScope],
        "order" =>
        [
            McpServiceTokenProvider.ProductsReadScope, McpServiceTokenProvider.InventoryReadScope,
            McpServiceTokenProvider.CustomersReadScope, McpServiceTokenProvider.OrdersReadScope,
            McpServiceTokenProvider.AdminWriteScope
        ],
        _ => throw new ArgumentOutOfRangeException(nameof(operation))
    };

    private static string MutationAgentFirstTool(string operation) => operation switch
    {
        "customer" => "generate_random_customer",
        "order" => "search_products",
        _ => throw new ArgumentOutOfRangeException(nameof(operation))
    };

    private static IConfiguration MutationAgentConfiguration() =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_CUSTOMER_ID"] = "customer-agent",
            ["AI_AGENT_ORDER_ID"] = "order-agent"
        }).Build();

    private static IConfiguration AnalysisAgentConfiguration() =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AI_AGENT_REVIEW_ANALYSIS_ID"] = "review-agent",
            ["AI_AGENT_CART_RECOVERY_ID"] = "recovery-agent"
        }).Build();

    private static Task<FoundryAgentResponse> InvokeMutationAgent(
        FoundryAgentClient client, string operation, IReadOnlyCollection<string>? scopes,
        string? mcpAccessToken = null, string? toolChoice = null, bool multiplePolicies = false) =>
        client.InvokeAsync(operation + "-agent", "Generate", toolChoice: toolChoice ??
            (operation == "customer" ? "auto" : "required"), mcpAccessToken: mcpAccessToken,
            mcpServiceScopes: scopes, requireCustomerGenerationTools: operation == "customer",
            requireOrderGenerationTools: operation == "order", requirePublicCatalogTools: multiplePolicies);

    private static string MakeToken(Guid clientId) =>
        Base64UrlEncoder.Encode("""{"alg":"none"}""") + "." +
        Base64UrlEncoder.Encode(JsonSerializer.Serialize(new { appid = clientId.ToString() })) + ".AA";

    private sealed class SequencedCredential(params string[] tokens) : TokenCredential
    {
        private int _next;

        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new(tokens[_next++], DateTimeOffset.UtcNow.AddHours(1));

        public override ValueTask<AccessToken> GetTokenAsync(
            TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class CapturingTelemetryChannel : ITelemetryChannel
    {
        public List<ITelemetry> Items { get; } = [];
        public bool? DeveloperMode { get; set; }
        public string EndpointAddress { get; set; } = string.Empty;
        public void Send(ITelemetry item) => Items.Add(item);
        public void Flush() { }
        public void Dispose() { }
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];
        public List<Exception> Exceptions { get; } = [];
        public Action<string>? OnMessage { get; init; }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var message = formatter(state, exception);
            Messages.Add(message);
            if (exception is not null) Exceptions.Add(exception);
            OnMessage?.Invoke(message);
        }
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

    private sealed class ModerationTableHandler : HttpMessageHandler
    {
        private JsonObject _entity = JsonNode.Parse("""
            {"PartitionKey":"reviewmoderation","RowKey":"state","IsRunning":true,"JobId":"job-1",
             "QueuedCount":3,"ProcessedCount":0,"SuccessCount":0,"FailedCount":0,"SkippedCount":0}
            """)!.AsObject();
        private int _version = 1;
        public int UpdateAttempts { get; private set; }

        public void StopExternally()
        {
            _entity["IsRunning"] = false;
            _version++;
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get)
            {
                var result = _entity.DeepClone().AsObject();
                result["odata.etag"] = $"\"v{_version}\"";
                var response = new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(result.ToJsonString(), Encoding.UTF8, "application/json")
                };
                response.Headers.ETag = new System.Net.Http.Headers.EntityTagHeaderValue($"\"v{_version}\"");
                return response;
            }

            Assert.Equal(HttpMethod.Put, request.Method);
            Assert.Equal($"\"v{_version}\"", request.Headers.IfMatch.ToString());
            UpdateAttempts++;
            if (UpdateAttempts == 1)
            {
                _entity["ProcessedCount"] = 1;
                _entity["SuccessCount"] = 1;
                _version++;
                return new HttpResponseMessage(HttpStatusCode.PreconditionFailed);
            }

            _entity = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
            _version++;
            return new HttpResponseMessage(HttpStatusCode.NoContent);
        }
    }

    private sealed class StubReviewService(WebPubSubService publisher, TableClient table)
        : ReviewService("not-a-connection-string", "unused", publisher, table)
    {
        public int SavedCount { get; private set; }
        public HashSet<int> Ineligible { get; } = [];

        public override Task<int> SaveGeneratedReviewAndGetIdAsync(GeneratedReview review) =>
            Task.FromResult(++SavedCount);

        // Product N's only candidate is customer N - 41; once reviewed, the customer is no longer eligible.
        public override Task<List<CustomerWithDeliveredOrder>> GetCustomersWithDeliveredOrderForProductAsync(int productId)
        {
            var customerId = productId - 41;
            return Task.FromResult<List<CustomerWithDeliveredOrder>>(
                SavedCount >= customerId || Ineligible.Contains(customerId)
                    ? []
                    : [new CustomerWithDeliveredOrder { CustomerID = customerId }]);
        }

        public override Task SaveReviewReplyAsync(int reviewId, string reply, string repliedBy = "AdventureWorks Team") =>
            Task.CompletedTask;
    }

    private sealed class StubTranslationProductService() : ProductService("not-a-connection-string")
    {
        public int DescriptionSaveCalls { get; private set; }

        public override Task<List<TranslationRequest>> GetProductsByModelIdsAsync(List<int> productModelIds) =>
            Task.FromResult<List<TranslationRequest>>([
                new() { ProductModelID = 42, ProductID = 43, ProductName = "Synthetic",
                        EnglishDescription = "Synthetic description" }
            ]);

        public override Task<List<api_functions.Models.CultureInfo>> GetSupportedCulturesAsync() =>
            Task.FromResult<List<api_functions.Models.CultureInfo>>([
                new() { CultureID = "fr", Name = "French" }
            ]);

        public override Task<List<api_functions.Models.CultureInfo>> GetAllCulturesAsync() =>
            GetSupportedCulturesAsync();

        public override Task<List<SavedDescriptionResult>> SaveTranslationsAsync(List<TranslatedDescription> translations)
        {
            DescriptionSaveCalls++;
            return Task.FromResult<List<SavedDescriptionResult>>([]);
        }
    }

    private sealed class StubCategoryProductService() : ProductService("not-a-connection-string")
    {
        public List<(string Type, int Id, int ParentId, string Culture, string Name)> Writes { get; } = [];

        public override Task<(List<CategoryHierarchyItem> categories, List<SubcategoryHierarchyItem> subcategories)>
            GetCategoryHierarchyAsync() => Task.FromResult((
                new List<CategoryHierarchyItem> { new() { ProductCategoryID = 42, Name = "Synthetic parent" } },
                new List<SubcategoryHierarchyItem>()));

        public override Task<List<api_functions.Models.CultureInfo>> GetAllCulturesAsync() =>
            Task.FromResult<List<api_functions.Models.CultureInfo>>([
                new() { CultureID = "en", Name = "English" },
                new() { CultureID = "fr", Name = "French" },
                new() { CultureID = "en-GB", Name = "British English" }
            ]);

        public override Task<int> GetNextCategoryIdAsync() => Task.FromResult(100);
        public override Task<int> GetNextSubcategoryIdAsync() => Task.FromResult(101);

        public override Task InsertCategoryRowAsync(int categoryId, string cultureId, string name)
        {
            Writes.Add(("category", categoryId, 0, cultureId, name));
            return Task.CompletedTask;
        }

        public override Task InsertSubcategoryRowAsync(int subcategoryId, int categoryId, string cultureId, string name)
        {
            Writes.Add(("subcategory", subcategoryId, categoryId, cultureId, name));
            return Task.CompletedTask;
        }
    }

    private sealed class TestHttpClientFactory(FoundryHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name)
        {
            handler.ClientNames.Add(name);
            return new(handler, disposeHandler: false);
        }
    }

    private sealed class AgentRequestContext : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            }))
            .BuildServiceProvider();

        public AgentRequestContext(string? subject, bool authenticated, string? traceParent = null)
        {
            InstanceServices = _services;
            TraceContext = traceParent is null ? null! : new AgentTraceContext(traceParent);
            Items[FunctionUser.ContextKey] = new FunctionUser
            {
                SubjectId = subject, IsAuthenticated = authenticated, Category = "employee"
            };
        }

        public override string InvocationId => "agent-test";
        public override string FunctionId => "agent-test";
        public override TraceContext TraceContext { get; }
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
        public void Dispose() => _services.Dispose();
    }

    private sealed class AgentTraceContext(string traceParent) : TraceContext
    {
        public override string TraceParent => traceParent;
        public override string TraceState => string.Empty;
        public override IReadOnlyDictionary<string, string> Attributes { get; } = new Dictionary<string, string>();
    }

    private sealed class AgentRequest(FunctionContext context, string body) : HttpRequestData(context)
    {
        public override Stream Body { get; } = new MemoryStream(Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new("https://functions.example.test/api/agent");
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => "POST";
        public override HttpResponseData CreateResponse() => new AgentResponse(FunctionContext);
    }

    private sealed class AgentResponse(FunctionContext context) : HttpResponseData(context)
    {
        public override HttpStatusCode StatusCode { get; set; }
        public override HttpHeadersCollection Headers { get; set; } = new();
        public override Stream Body { get; set; } = new MemoryStream();
        public override HttpCookies Cookies => throw new NotSupportedException();
    }

    private sealed class FoundryHandler : HttpMessageHandler
    {
        public int DefinitionRequests { get; private set; }
        public int McpRequests { get; private set; }
        public List<string> ClientNames { get; } = [];
        public List<JsonElement> ResponseRequests { get; } = [];
        public List<string?> MemoryUserIds { get; } = [];
        public HttpStatusCode ResponseStatus { get; init; } = HttpStatusCode.OK;
        public TimeSpan? RetryAfter { get; init; }
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
        public HttpStatusCode? CustomResponseStatus { get; init; }
        public string? FirstResponseText { get; init; }
        public Action? OnResponse { get; init; }
        public string ToolServerUrl { get; init; } = "https://mcp.test/mcp";
        public Exception? WarmupException { get; init; }
        public CancellationTokenSource? CancelWarmup { get; init; }
        public string? DefinitionToolsJson { get; init; }
        public string OwnershipSubject { get; init; } = "owner";
        public string OwnershipAgent { get; init; } = "eshop-chat-agent";
        public HttpStatusCode OwnershipStatus { get; init; } = HttpStatusCode.OK;
        public string? OwnershipResponse { get; init; }
        public List<string?> Policies { get; } = [];
        public int OwnershipRequests { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Get && path.Contains("/responses/", StringComparison.Ordinal))
            {
                OwnershipRequests++;
                return JsonResponse(OwnershipStatus, OwnershipResponse ?? JsonSerializer.Serialize(new
                {
                    metadata = new { aw_chat_owner = OwnershipSubject, aw_chat_agent = OwnershipAgent }
                }));
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

            if (request.Method == HttpMethod.Post &&
                !string.Equals(request.RequestUri.Host, "foundry.test", StringComparison.OrdinalIgnoreCase))
            {
                McpRequests++;
                if (CancelWarmup is not null)
                {
                    CancelWarmup.Cancel();
                    cancellationToken.ThrowIfCancellationRequested();
                }
                if (WarmupException is not null)
                    throw WarmupException;
                return JsonResponse(HttpStatusCode.OK, "{}");
            }

            Assert.EndsWith("/openai/v1/responses", path);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            ResponseRequests.Add(body.RootElement.Clone());
            MemoryUserIds.Add(request.Headers.TryGetValues("x-memory-user-id", out var memoryIds)
                ? memoryIds.Single() : null);
            Policies.Add(request.Headers.TryGetValues("x-policy-id", out var policies) ? policies.Single() : null);
            OnResponse?.Invoke();
            if (CustomResponse is not null && (CustomResponseRound == 0 || CustomResponseRound == ResponseRequests.Count))
                return JsonResponse(CustomResponseStatus ?? ResponseStatus, CustomResponse);

            if (FirstResponseText is not null && ResponseRequests.Count == 1)
                return JsonResponse(HttpStatusCode.OK, JsonSerializer.Serialize(new
                {
                    id = "resp-test",
                    status = "completed",
                    output = new[] { new { type = "message", content = new[] { new { type = "output_text", text = FirstResponseText } } } }
                }));

            if (ResponseStatus != HttpStatusCode.OK)
            {
                var failure = JsonResponse(ResponseStatus, """{"error":{"message":"tool_user_error enumerating tools"}}""");
                if (RetryAfter is TimeSpan retryAfter)
                    failure.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(retryAfter);
                return failure;
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
                return JsonResponse(HttpStatusCode.OK, JsonSerializer.Serialize(new
                {
                    id = "resp-tool", status = "completed", output = new[] { new { type = "mcp_call", name = ToolName } }
                }));
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
