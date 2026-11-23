using System.Diagnostics;
using System.Diagnostics.Metrics;
using ModelContextProtocol.Extensions.Tasks;
using ModelContextProtocol.Protocol;

namespace AdventureWorks.Telemetry;

/// <summary>Tool work is internal to an MCP HTTP entry, not a second server request.</summary>
public sealed class McpToolTelemetry : IDisposable
{
    private static readonly ActivitySource Source = new("AdventureWorks.Mcp");
    private static readonly Meter Meter = new("AdventureWorks.Mcp");
    private static readonly Counter<long> Outcomes = Meter.CreateCounter<long>("mcp.tool.outcomes");
    private static readonly Histogram<double> Duration = Meter.CreateHistogram<double>("mcp.tool.duration", "s");
    private readonly Activity? _activity;
    private readonly long _start = Stopwatch.GetTimestamp();
    private readonly string _tool;
    private string _outcome = "application-failure";

    private McpToolTelemetry(string tool)
    {
        // Tool names are registered server identifiers; never record arguments, results or exception text.
        _tool = tool;
        _activity = Source.StartActivity($"execute_tool {tool}", ActivityKind.Internal);
        _activity?.SetTag("gen_ai.operation.name", "execute_tool");
        _activity?.SetTag("gen_ai.tool.name", tool);
    }

    public static McpToolTelemetry Start(string tool) => new(tool);
    public void Complete(string outcome) => _outcome = outcome;
    public void Complete(CallToolResult result) => Complete(result.IsError == true ? "application-failure" : "success");
    public void Fail(Exception exception) => Complete(exception is InputRequiredException ? "input-required" :
        exception is OperationCanceledException ? "cancelled" :
        exception is UnauthorizedAccessException ? "forbidden" :
        exception is HttpRequestException ? "upstream-failure" : "application-failure");

    public void Dispose()
    {
        _activity?.SetTag("aw.outcome", _outcome);
        if (_outcome is "application-failure" or "upstream-failure")
            _activity?.SetStatus(ActivityStatusCode.Error);
        var tags = new TagList { { "tool", _tool }, { "outcome", _outcome } };
        Outcomes.Add(1, tags);
        Duration.Record(Stopwatch.GetElapsedTime(_start).TotalSeconds, tags);
        _activity?.Dispose();
    }
}
