using AdventureWorks.Telemetry;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Middleware;

namespace api_functions.Functions;

/// <summary>
/// Restores the host invocation's W3C trace in the isolated worker so custom events, SQL
/// dependencies and outbound calls correlate with the caller's trace, and labels SQL principal
/// telemetry with the invoked function.
/// </summary>
public sealed class InvocationTraceMiddleware : IFunctionsWorkerMiddleware
{
    public async Task Invoke(FunctionContext context, FunctionExecutionDelegate next)
    {
        using var activity = IsCurrentTrace(context.TraceContext)
            ? null
            : InvocationActivity.Start(context.TraceContext, "Invocation");
        using var scope = SqlPrincipalTelemetry.EnterScope("function:" + context.FunctionDefinition.Name);
        await next(context);
    }

    private static bool IsCurrentTrace(TraceContext? trace) =>
        System.Diagnostics.Activity.Current is { } current &&
        trace is not null &&
        System.Diagnostics.ActivityContext.TryParse(trace.TraceParent, null, out var parent) &&
        current.TraceId == parent.TraceId;
}
