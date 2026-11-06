using System.Reflection;
using System.Text.Json;
using api_functions.Functions;
using Xunit;

namespace ApiFunctions.Tests;

public class ManufacturingAgentResponseTests
{
    private const string LiveFailure = """
        {"id":"caresp_cbe933c7","object":"response","status":"failed",
         "agent_reference":{"name":"manufacturing-agent","version":"1","type":"agent_reference"},
         "error":{"code":"server_error","message":"Authentication failed when connecting to MCP server https://example.test/mcp 401"},
         "output":[]}
        """;

    [Fact]
    public void Live_http_200_mcp_authentication_failure_cannot_be_recorded_as_findings()
    {
        var exception = Assert.Throws<TargetInvocationException>(() => Parse(LiveFailure));
        Assert.Equal("ManufacturingAgentThrottledException", exception.InnerException!.GetType().Name);
        Assert.Contains("server_error", exception.InnerException.Message);
        Assert.DoesNotContain("https://example.test", exception.InnerException.Message);
    }

    public static IEnumerable<object[]> InvalidResponses()
    {
        yield return [LiveFailure];
        foreach (var status in new[] { "failed", "incomplete", "queued", "in_progress", "cancelled" })
            yield return [Envelope("""{"findingsSummary":"Do not accept this"}""", status)];
        foreach (var body in new[]
        {
            "", "not JSON", "{", "null", "[]",
            """{"text":"Authentication failed"}""",
            """{"object":"error","error":{"code":"server_error"}}""",
            """{"object":"error","status":"completed","output":[]}""",
            """{"status":"completed","output":[]}""",
            """{"status":"completed","output":null}""",
            """{"status":"completed","output":[null]}""",
            """{"status":"completed","output":[{"type":"message","content":[]}]}""",
            """{"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"No"}]}]}""",
            """{"status":"completed","output":[{"type":"mcp_call","error":{"code":"unauthorized"}}]}""",
            """{"status":"completed","error":"Authentication failed","output":[]}""",
            """{"status":"completed","incomplete_details":{"reason":"max_output_tokens"},"output":[]}""",
        })
            yield return [body];
        foreach (var text in new[]
        {
            "", " ", "{}", "[]", "null", """{"findingsSummary":""}""",
            """{"findingsSummary":42}""", """{"findingsSummary":"truncated""",
            """{"error":{"code":"server_error"}}""",
            """{"status":"failed","output":[],"findingsSummary":"Not findings"}""",
            """{"findingsSummary":"Summary","toolsUsed":[{}]}""",
            """{"findingsSummary":"Summary","actionsExecuted":"not an array"}""",
            """{"findingsSummary":"Summary","recommendedActions":[null]}""",
            LiveFailure
        })
            yield return [Envelope(text)];
        yield return [Envelope("```json\n" + LiveFailure + "\n```")];
    }

    [Theory]
    [MemberData(nameof(InvalidResponses))]
    public void Failed_empty_incomplete_and_malformed_envelopes_never_return_success(string body)
    {
        var exception = Assert.Throws<TargetInvocationException>(() => Parse(body));
        Assert.Equal("ManufacturingAgentThrottledException", exception.InnerException!.GetType().Name);
    }

    [Fact]
    public void Completed_structured_findings_preserve_actions_and_never_return_the_raw_envelope()
    {
        const string findings = """
            {"findingsSummary":"Product #776 has 42 units.",
             "toolsUsed":["GetOrderDetails","CheckInventoryAvailability"],
             "recommendedActions":[{"type":"manufacturing","productId":776,"qty":50,"rationale":"Stock low"}],
             "actionsExecuted":["WO #12345: Started 50x Product #776"]}
            """;
        var body = Envelope(findings);
        var result = Parse(body);
        Assert.Equal("Product #776 has 42 units.", Property<string>(result, "FindingsSummary"));
        Assert.NotEqual(body, Property<string>(result, "FindingsSummary"));
        Assert.DoesNotContain("\"object\":\"response\"", Property<string>(result, "FindingsSummary"));
        Assert.Equal(new[] { "GetOrderDetails", "CheckInventoryAvailability" }, Property<List<string>>(result, "ToolsUsed"));
        Assert.Single(Property<List<string>>(result, "ActionsExecuted"));
        Assert.Single(Property<System.Collections.IList>(result, "RecommendedActions").Cast<object>());
    }

    [Fact]
    public void Completed_prose_findings_remain_supported()
    {
        var result = Parse(Envelope("Order #75124: Product #776 has 42 units. No action required."));
        Assert.Equal("Order #75124: Product #776 has 42 units. No action required.",
            Property<string>(result, "FindingsSummary"));
    }

    [Fact]
    public void Final_assistant_message_wins_over_intermediate_tool_messages()
    {
        var body = JsonSerializer.Serialize(new
        {
            status = "completed",
            error = (object?)null,
            output = new object[]
            {
                new { type = "mcp_list_tools", tools = Array.Empty<object>() },
                Message("Checking inventory"),
                new { type = "mcp_call", error = (object?)null, status = "completed" },
                Message("""{"findingsSummary":"Product #776 has 42 units.","toolsUsed":[]}"""),
            }
        });
        Assert.Equal("Product #776 has 42 units.", Property<string>(Parse(body), "FindingsSummary"));
    }

    [Fact]
    public void Incomplete_message_is_not_a_completed_response()
    {
        var body = """{"status":"completed","output":[{"type":"message","status":"incomplete","content":[{"type":"output_text","text":"Partial findings"}]}]}""";
        Assert.Throws<TargetInvocationException>(() => Parse(body));
    }

    private static object Message(string text) => new
    {
        type = "message",
        role = "assistant",
        status = "completed",
        content = new[] { new { type = "output_text", text } }
    };

    private static string Envelope(string text, string status = "completed") =>
        JsonSerializer.Serialize(new { @object = "response", status, output = new[] { Message(text) } });

    private static object Parse(string body) =>
        typeof(ManufacturingAgentQueueTrigger)
            .GetMethod("ParseAgentResponse", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [body])!;

    private static T Property<T>(object value, string name) =>
        (T)value.GetType().GetProperty(name)!.GetValue(value)!;
}
