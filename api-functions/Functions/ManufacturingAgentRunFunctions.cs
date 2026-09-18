using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP endpoints for the manufacturing agent run activity feed and queue management.
///
/// GET    /api/manufacturing/agent-runs?limit=20    – Recent runs (newest first), for the UI activity feed.
/// POST   /api/manufacturing/agent-runs/{id}/step   – Step callback: hosted agent posts progress updates here.
/// GET    /api/manufacturing/agent-queue-status     – Queue depth, poison depth, drain estimate.
/// DELETE /api/manufacturing/agent-queue            – Clear all pending messages from the main queue.
/// DELETE /api/manufacturing/agent-queue/poison     – Clear the poison (permanently failed) queue.
/// </summary>
public class ManufacturingAgentRunFunctions
{
    private static readonly JsonSerializerOptions JsonOpts =
        new() { PropertyNameCaseInsensitive = true };

    private readonly ILogger<ManufacturingAgentRunFunctions> _logger;
    private readonly ManufacturingAgentRunService _runService;
    private readonly WebPubSubService _webPubSub;

    public ManufacturingAgentRunFunctions(
        ILogger<ManufacturingAgentRunFunctions> logger,
        ManufacturingAgentRunService runService,
        WebPubSubService webPubSub)
    {
        _logger     = logger;
        _runService = runService;
        _webPubSub  = webPubSub;
    }

    // ── GET /api/manufacturing/agent-runs ─────────────────────────────────────

    [Function(nameof(GetManufacturingAgentRuns))]
    public async Task<HttpResponseData> GetManufacturingAgentRuns(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/agent-runs")]
        HttpRequestData req)
    {
        var limitStr = req.Query["limit"];
        var limit    = int.TryParse(limitStr, out var l) ? Math.Clamp(l, 1, 100) : 20;

        var runs     = await _runService.ListRecentAsync(limit);
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(runs.Select(r => new
        {
            r.RunId,
            r.SalesOrderId,
            r.CustomerId,
            ModeLabel   = ((ManufacturingAgentMode)r.Mode).ToString(),
            r.Status,
            r.EnqueuedAt,
            r.StartedAt,
            r.CompletedAt,
            r.FindingsSummary,
            ToolsUsed       = DeserializeStringArray(r.ToolsUsed),
            ProposalIds     = DeserializeStringArray(r.ProposalIds),
            ActionsExecuted = DeserializeStringArray(r.ActionsExecuted),
            Steps           = DeserializeSteps(r.StepsJson),
            r.RetryCount,
            r.RetryAfterUtc,
            r.LastError,
        }));
        return response;
    }

    // ── POST /api/manufacturing/agent-runs/{id}/step ──────────────────────────

    [Function(nameof(PostManufacturingAgentStep))]
    public async Task<HttpResponseData> PostManufacturingAgentStep(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/agent-runs/{id}/step")]
        HttpRequestData req,
        string id)
    {
        string body;
        try { body = await new StreamReader(req.Body).ReadToEndAsync(); }
        catch { return req.CreateResponse(HttpStatusCode.BadRequest); }

        ManufacturingAgentStepUpdate? update;
        try { update = JsonSerializer.Deserialize<ManufacturingAgentStepUpdate>(body, JsonOpts); }
        catch { return req.CreateResponse(HttpStatusCode.BadRequest); }

        if (update == null || string.IsNullOrEmpty(update.Key))
            return req.CreateResponse(HttpStatusCode.BadRequest);

        if (update.Status == "started")
            await _runService.AddStepAsync(id, update.Key, update.Label);
        else if (update.Status == "completed")
            await _runService.CompleteStepAsync(id, update.Key);

        await _webPubSub.SendToGroupAsync("manufacturing-agent", new
        {
            @event = "step-updated",
            runId = id,
            key = update.Key,
            status = update.Status
        });

        return req.CreateResponse(HttpStatusCode.NoContent);
    }

    // ── GET /api/manufacturing/agent-queue-status ─────────────────────────────

    [Function(nameof(GetManufacturingAgentQueueStatus))]
    public async Task<HttpResponseData> GetManufacturingAgentQueueStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/agent-queue-status")]
        HttpRequestData req)
    {
        var status   = await _runService.GetQueueStatusAsync();
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(status);
        return response;
    }

    // ── DELETE /api/manufacturing/agent-queue ─────────────────────────────────

    [Function(nameof(ClearManufacturingAgentQueue))]
    public async Task<HttpResponseData> ClearManufacturingAgentQueue(
        [HttpTrigger(AuthorizationLevel.Anonymous, "delete", Route = "manufacturing/agent-queue")]
        HttpRequestData req)
    {
        await _runService.ClearQueueAsync();
        _logger.LogInformation("[AgentRun] Main agent queue cleared via API.");
        await _webPubSub.SendToGroupAsync("manufacturing-agent", new { @event = "queue-cleared" });
        return req.CreateResponse(HttpStatusCode.NoContent);
    }

    // ── DELETE /api/manufacturing/agent-queue/poison ──────────────────────────

    [Function(nameof(ClearManufacturingAgentPoisonQueue))]
    public async Task<HttpResponseData> ClearManufacturingAgentPoisonQueue(
        [HttpTrigger(AuthorizationLevel.Anonymous, "delete", Route = "manufacturing/agent-queue/poison")]
        HttpRequestData req)
    {
        await _runService.ClearPoisonQueueAsync();
        _logger.LogInformation("[AgentRun] Poison queue cleared via API.");
        await _webPubSub.SendToGroupAsync("manufacturing-agent", new { @event = "poison-queue-cleared" });
        return req.CreateResponse(HttpStatusCode.NoContent);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string[]? DeserializeStringArray(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { return JsonSerializer.Deserialize<string[]>(json); }
        catch { return null; }
    }

    private static object? DeserializeSteps(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { return JsonSerializer.Deserialize<object>(json); }
        catch { return null; }
    }
}
