using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Azure.Functions.Worker.Middleware;

namespace AuthAssurance;

internal static class HostProbe
{
    private static readonly object Sync = new();

    public static void Record(string phase, FunctionContext context)
    {
        var path = Environment.GetEnvironmentVariable("AUTH_ASSURANCE_HOST_PROBE")
            ?? throw new InvalidOperationException("The isolated Functions host probe is not configured.");
        var line = JsonSerializer.Serialize(new
        {
            phase,
            function = context.FunctionDefinition.Name,
            invocation = context.InvocationId
        }) + Environment.NewLine;
        lock (Sync)
            File.AppendAllText(path, line);
    }
}

public sealed class HostEntryProbe : IFunctionsWorkerMiddleware
{
    public async Task Invoke(FunctionContext context, FunctionExecutionDelegate next)
    {
        HostProbe.Record("host", context);
        await next(context);
    }
}

public sealed class HandlerEntryProbe : IFunctionsWorkerMiddleware
{
    public async Task Invoke(FunctionContext context, FunctionExecutionDelegate next)
    {
        HostProbe.Record("handler", context);
        await next(context);
    }
}

public sealed class UnclassifiedProbe
{
    [Function("AuthAssuranceUnclassified")]
    public HttpResponseData Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "__auth-assurance/unclassified")]
        HttpRequestData request) => request.CreateResponse(HttpStatusCode.OK);
}
