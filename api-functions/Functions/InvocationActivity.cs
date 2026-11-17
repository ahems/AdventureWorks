using System.Diagnostics;
using Microsoft.Azure.Functions.Worker;

namespace api_functions.Functions;

internal static class InvocationActivity
{
    public static Activity? Start(TraceContext? trace, string name)
    {
        if (trace is null || !ActivityContext.TryParse(trace.TraceParent, null, out var parent))
            return null;

        return new Activity(name)
            .SetIdFormat(ActivityIdFormat.W3C)
            .SetParentId(parent.TraceId, parent.SpanId, parent.TraceFlags)
            .Start();
    }
}
