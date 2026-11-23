#nullable enable
using System.Net;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.DTOs;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace api_functions.Functions;

public sealed class MonitoringFunctions(MonitoringQueryService queries, MonitoringCaptureService capture, WebPubSubService updates)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Function("MonitoringSummary")]
    public Task<HttpResponseData> Summary(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "monitoring/summary")] HttpRequestData request,
        FunctionContext context) => ExecuteAsync(request, context, FunctionScopes.MonitoringRead, async () =>
    {
        var parameters = System.Web.HttpUtility.ParseQueryString(request.Url.Query);
        if (parameters.AllKeys.Any(k => k != "range")) throw new ArgumentException("Only range is supported.");
        return (HttpStatusCode.OK, (object)await queries.SummaryAsync(parameters["range"] ?? "1h", context.CancellationToken));
    });

    [Function("MonitoringTrace")]
    public Task<HttpResponseData> Trace(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "monitoring/traces/{traceId}")] HttpRequestData request,
        string traceId, FunctionContext context) => ExecuteAsync(request, context, FunctionScopes.MonitoringRead,
        async () => (HttpStatusCode.OK, (object)await queries.TraceAsync(traceId, context.CancellationToken)));

    [Function("MonitoringCaptureStatus")]
    public Task<HttpResponseData> CaptureStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "monitoring/capture")] HttpRequestData request,
        FunctionContext context) => ExecuteAsync(request, context, FunctionScopes.MonitoringRead,
        async () => (HttpStatusCode.OK, (object)await capture.StatusAsync(context.CancellationToken)));

    [Function("MonitoringCaptureStart")]
    public Task<HttpResponseData> CaptureStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "monitoring/capture")] HttpRequestData request,
        FunctionContext context) => ExecuteAsync(request, context, FunctionScopes.MonitoringWrite, async () =>
    {
        var buffer = new byte[2049];
        var count = await request.Body.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false,
            cancellationToken: context.CancellationToken);
        if (count > 2048) throw new ArgumentException("Capture request exceeds the 2 KiB limit.");
        using var body = JsonDocument.Parse(buffer.AsMemory(0, count));
        if (body.RootElement.ValueKind != JsonValueKind.Object
            || body.RootElement.EnumerateObject().Any(p => p.Name is not ("scopeType" or "scopeId")))
            throw new ArgumentException("Only scopeType and scopeId are supported.");
        var input = body.RootElement.Deserialize<CaptureStartRequest>(Json)
            ?? throw new ArgumentException("Capture scope is required.");
        var grant = await capture.StartAsync(input, context.CancellationToken);
        await updates.SendToGroupAsync("utilities", new { @event = "monitoring-capture-changed" });
        return (HttpStatusCode.Created, (object)grant);
    });

    [Function("MonitoringCaptureStop")]
    public Task<HttpResponseData> CaptureStop(
        [HttpTrigger(AuthorizationLevel.Anonymous, "delete", Route = "monitoring/capture/{id}")] HttpRequestData request,
        string id, FunctionContext context) => ExecuteAsync(request, context, FunctionScopes.MonitoringWrite, async () =>
    {
        var grant = await capture.StopAsync(id, context.CancellationToken);
        if (grant is not null) await updates.SendToGroupAsync("utilities", new { @event = "monitoring-capture-changed" });
        return grant is null ? (HttpStatusCode.NotFound, (object)new { error = "Capture not found." })
            : (HttpStatusCode.OK, (object)grant);
    });

    public static bool Authorized(FunctionUser user, string scope) =>
        user.IsInternal && user.HasScope(scope) && user.Roles.Contains("executive-admin", StringComparer.Ordinal);

    private static async Task<HttpResponseData> ExecuteAsync(HttpRequestData request, FunctionContext context,
        string scope, Func<Task<(HttpStatusCode Status, object Body)>> action)
    {
        if (!Authorized(FunctionUser.Current(context), scope))
            return await ReplyAsync(request, HttpStatusCode.Forbidden, new { error = "Executive monitoring access is required." });
        try
        {
            var (status, body) = await action();
            return await ReplyAsync(request, status, body);
        }
        catch (Exception e) when (e is ArgumentException or JsonException)
        { return await ReplyAsync(request, HttpStatusCode.BadRequest, new { error = "Invalid monitoring request. Select a supported range, trace or capture scope." }); }
        catch (Exception e) when (e is Azure.RequestFailedException or InvalidOperationException or OperationCanceledException)
        { return await ReplyAsync(request, HttpStatusCode.ServiceUnavailable, new { status = "unavailable", error = "Monitoring data or capture state is unavailable. Verify capture status before retrying a control write." }); }
    }
    private static async Task<HttpResponseData> ReplyAsync(HttpRequestData request, HttpStatusCode status, object body)
    {
        var response = request.CreateResponse(status);
        response.Headers.Add("Content-Type", "application/json; charset=utf-8");
        response.Headers.Add("Cache-Control", "no-store");
        await response.WriteStringAsync(JsonSerializer.Serialize(body, Json));
        return response;
    }
}
