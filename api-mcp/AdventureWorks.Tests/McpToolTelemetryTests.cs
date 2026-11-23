using System.Diagnostics;
using AdventureWorks.Telemetry;
using Xunit;
using ModelContextProtocol.Protocol;

namespace AdventureWorks.Tests;

public class McpToolTelemetryTests
{
    [Theory]
    [InlineData("success", false)]
    [InlineData("application-failure", true)]
    [InlineData("input-required", false)]
    [InlineData("cancelled", false)]
    public void Logical_outcomes_are_internal_spans_without_content(string outcome, bool failed)
    {
        var ended = new List<Activity>();
        using var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == "AdventureWorks.Mcp",
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStopped = ended.Add
        };
        ActivitySource.AddActivityListener(listener);
        using (var operation = McpToolTelemetry.Start("get_product_details"))
        {
            if (outcome is "success" or "application-failure")
                operation.Complete(new CallToolResult
                {
                    IsError = failed,
                    Content = [new TextContentBlock { Text = "private-marker password=private-marker" }]
                });
            else if (outcome == "cancelled")
                operation.Fail(new OperationCanceledException("private-marker"));
            else
                operation.Complete(outcome);
        }
        var span = Assert.Single(ended);
        Assert.Equal(ActivityKind.Internal, span.Kind);
        Assert.Equal("execute_tool", span.GetTagItem("gen_ai.operation.name"));
        Assert.Equal(outcome, span.GetTagItem("aw.outcome"));
        Assert.Equal(failed ? ActivityStatusCode.Error : ActivityStatusCode.Unset, span.Status);
        Assert.DoesNotContain(span.TagObjects, tag => tag.Key.Contains("argument") || tag.Key.Contains("result"));
        Assert.DoesNotContain("private-marker", string.Join("|", span.TagObjects.Select(tag => tag.Value)));
    }
}
