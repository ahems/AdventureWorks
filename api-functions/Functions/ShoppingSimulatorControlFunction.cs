using System.Net;
using System.Text.Json;
using System.Web;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.ApplicationInsights;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP control endpoints for the Shopping Simulator.
///
/// GET  /api/shopping-simulator/status      — returns current state + queue depth
/// POST /api/shopping-simulator/start        — starts the simulator with given config
/// POST /api/shopping-simulator/stop         — stops the simulator (existing queue messages continue processing)
/// POST /api/shopping-simulator/clear-queue  — clears all pending queue messages (does not change running state)
/// </summary>
public class ShoppingSimulatorControlFunction
{
    private readonly ILogger<ShoppingSimulatorControlFunction> _logger;
    private readonly ShoppingSimulatorService _simulator;
    private readonly TelemetryClient _telemetry;

    public ShoppingSimulatorControlFunction(
        ILogger<ShoppingSimulatorControlFunction> logger,
        ShoppingSimulatorService simulator,
        TelemetryClient telemetry)
    {
        _logger    = logger;
        _simulator = simulator;
        _telemetry = telemetry;
    }

    // ── GET status ───────────────────────────────────────────────────────────

    /// <summary>Returns current simulator state including queue depth.</summary>
    [Function("ShoppingSimulator_Status")]
    public async Task<HttpResponseData> GetStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "shopping-simulator/status")]
        HttpRequestData req)
    {
        var state      = await _simulator.GetStateAsync();
        var queueDepth = await _simulator.GetQueueDepthAsync();

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(new
        {
            state.IsRunning,
            state.OrdersPerMinute,
            state.ExistingCustomerPercentage,
            state.DurationHours,
            state.StopScheduledAt,
            state.NoOrderCustomerPercentage,
            state.AbandonedCartPercentage,
            state.IncludeConsumerOrders,
            state.IncludeStoreOrders,
            state.StoreOrderPercentage,
            state.StartedAt,
            state.TotalQueued,
            state.NewCustomerQueued,
            state.ExistingCustomerQueued,
            state.StoreOrderQueued,
            queueDepth,
        });
        return resp;
    }

    // ── POST start ───────────────────────────────────────────────────────────

    /// <summary>
    /// Starts the Shopping Simulator with the requested rate and persona mix.
    /// Body: { "ordersPerMinute": 1–60, "existingCustomerPercentage": 0–100 }
    /// </summary>
    [Function("ShoppingSimulator_Start")]
    public async Task<HttpResponseData> Start(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "shopping-simulator/start")]
        HttpRequestData req)
    {
        ShoppingSimulatorStartRequest? input = null;
        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            input = JsonSerializer.Deserialize<ShoppingSimulatorStartRequest>(
                body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch { /* fall through — use defaults */ }

        var ordersPerMinute          = Math.Clamp(input?.OrdersPerMinute          ?? 1,  1,   60);
        var existingCustomerPct      = Math.Clamp(input?.ExistingCustomerPercentage ?? 30, 0, 100);
        var durationHours            = Math.Clamp(input?.DurationHours              ?? 24, 1,  72);
        var noOrderCustomerPct       = Math.Clamp(input?.NoOrderCustomerPercentage  ?? 50, 0, 100);
        var abandonedCartPct         = Math.Clamp(input?.AbandonedCartPercentage    ?? 10, 0, 100);
        var includeConsumerOrders    = input?.IncludeConsumerOrders ?? true;
        var includeStoreOrders       = input?.IncludeStoreOrders   ?? true;
        var storeOrderPct            = Math.Clamp(input?.StoreOrderPercentage       ?? 20, 5,  50);

        // At least one order type must be enabled
        if (!includeConsumerOrders && !includeStoreOrders)
            includeConsumerOrders = true;

        var state = await _simulator.GetStateAsync();
        state.IsRunning                  = true;
        state.OrdersPerMinute            = ordersPerMinute;
        state.ExistingCustomerPercentage = existingCustomerPct;
        state.DurationHours              = durationHours;
        state.NoOrderCustomerPercentage  = noOrderCustomerPct;
        state.AbandonedCartPercentage    = abandonedCartPct;
        state.IncludeConsumerOrders      = includeConsumerOrders;
        state.IncludeStoreOrders         = includeStoreOrders;
        state.StoreOrderPercentage       = storeOrderPct;
        state.StartedAt                  = DateTimeOffset.UtcNow;
        state.StopScheduledAt            = state.StartedAt.Value.AddHours(durationHours);
        await _simulator.SaveStateAsync(state);

        _logger.LogInformation("[ShoppingSimulator] Started — {Rate} orders/min, {Pct}% existing customers, auto-stop in {Duration}h",
            ordersPerMinute, existingCustomerPct, durationHours);

        _telemetry.TrackEvent("ShoppingSimulator.Started", new Dictionary<string, string>
        {
            ["OrdersPerMinute"]           = ordersPerMinute.ToString(),
            ["ExistingCustomerPercentage"] = existingCustomerPct.ToString(),
            ["DurationHours"]             = durationHours.ToString(),
            ["IncludeConsumerOrders"]      = includeConsumerOrders.ToString(),
            ["IncludeStoreOrders"]         = includeStoreOrders.ToString(),
            ["StoreOrderPercentage"]       = storeOrderPct.ToString(),
        });

        var queueDepth = await _simulator.GetQueueDepthAsync();
        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(new
        {
            state.IsRunning,
            state.OrdersPerMinute,
            state.ExistingCustomerPercentage,
            state.DurationHours,
            state.StopScheduledAt,
            state.NoOrderCustomerPercentage,
            state.AbandonedCartPercentage,
            state.IncludeConsumerOrders,
            state.IncludeStoreOrders,
            state.StoreOrderPercentage,
            state.StartedAt,
            state.TotalQueued,
            state.NewCustomerQueued,
            state.ExistingCustomerQueued,
            state.StoreOrderQueued,
            queueDepth,
            message = $"Shopping simulator started at {ordersPerMinute} order{(ordersPerMinute == 1 ? "" : "s")}/min. Auto-stop in {durationHours}h.",
        });
        return resp;
    }

    // ── POST stop ────────────────────────────────────────────────────────────

    /// <summary>
    /// Stops the Shopping Simulator. No new messages will be enqueued but any messages
    /// already in the queue continue to be processed by the queue trigger.
    /// </summary>
    [Function("ShoppingSimulator_Stop")]
    public async Task<HttpResponseData> Stop(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "shopping-simulator/stop")]
        HttpRequestData req)
    {
        var state = await _simulator.GetStateAsync();
        state.IsRunning = false;
        await _simulator.SaveStateAsync(state);

        var queueDepth = await _simulator.GetQueueDepthAsync();

        _logger.LogInformation("[ShoppingSimulator] Stopped — {Pending} messages still in queue. Total queued this session: {Total}",
            queueDepth, state.TotalQueued);

        _telemetry.TrackEvent("ShoppingSimulator.Stopped", new Dictionary<string, string>
        {
            ["TotalQueued"]           = state.TotalQueued.ToString(),
            ["NewCustomerQueued"]     = state.NewCustomerQueued.ToString(),
            ["ExistingCustomerQueued"] = state.ExistingCustomerQueued.ToString(),
            ["PendingInQueue"]        = queueDepth.ToString(),
        });

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(new
        {
            state.IsRunning,
            state.OrdersPerMinute,
            state.ExistingCustomerPercentage,
            state.DurationHours,
            state.StopScheduledAt,
            state.NoOrderCustomerPercentage,
            state.AbandonedCartPercentage,
            state.IncludeConsumerOrders,
            state.IncludeStoreOrders,
            state.StoreOrderPercentage,
            state.StartedAt,
            state.TotalQueued,
            state.NewCustomerQueued,
            state.ExistingCustomerQueued,
            state.StoreOrderQueued,
            queueDepth,
            message = $"Shopping simulator stopped. {queueDepth} pending order{(queueDepth == 1 ? "" : "s")} will still be placed.",
        });
        return resp;
    }

    // ── GET results ─────────────────────────────────────────────────────────

    /// <summary>Returns recent simulation order results (most recent first).</summary>
    [Function("ShoppingSimulator_Results")]
    public async Task<HttpResponseData> GetResults(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "shopping-simulator/results")]
        HttpRequestData req)
    {
        var limitStr = req.Url.Query?.Contains("limit=") == true
            ? System.Web.HttpUtility.ParseQueryString(req.Url.Query)["limit"]
            : null;
        var limit = int.TryParse(limitStr, out var l) ? Math.Clamp(l, 1, 100) : 50;

        var results = await _simulator.GetRecentResultsAsync(limit);

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(results.Select(r => new
        {
            r.Success,
            r.SalesOrderId,
            r.CustomerName,
            r.NewCustomerCreated,
            r.TotalDue,
            r.FailureCode,
            r.ErrorMessage,
            r.PersonaType,
            r.AiReasoning,
            r.ItemCount,
            r.OrderType,
            completedAt = r.CompletedAt.ToString("o"),
        }));
        return resp;
    }

    // ── POST clear-queue ──────────────────────────────────────────────────────

    /// <summary>
    /// Clears all pending messages from the simulation queue without changing the running state.
    /// Intended for admin use when the simulator is stopped.
    /// </summary>
    [Function("ShoppingSimulator_ClearQueue")]
    public async Task<HttpResponseData> ClearQueue(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "shopping-simulator/clear-queue")]
        HttpRequestData req)
    {
        var state = await _simulator.GetStateAsync();
        await _simulator.ClearQueueAsync();

        _logger.LogInformation("[ShoppingSimulator] Queue manually cleared by admin.");
        _telemetry.TrackEvent("ShoppingSimulator.QueueCleared", new Dictionary<string, string>
        {
            ["WasRunning"] = state.IsRunning.ToString(),
        });

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(new
        {
            state.IsRunning,
            state.OrdersPerMinute,
            state.ExistingCustomerPercentage,
            state.DurationHours,
            state.StopScheduledAt,
            state.NoOrderCustomerPercentage,
            state.AbandonedCartPercentage,
            state.IncludeConsumerOrders,
            state.IncludeStoreOrders,
            state.StoreOrderPercentage,
            state.StartedAt,
            state.TotalQueued,
            state.NewCustomerQueued,
            state.ExistingCustomerQueued,
            state.StoreOrderQueued,
            queueDepth = 0L,
            message = "Queue cleared.",
        });
        return resp;
    }
}

/// <summary>Request body for <see cref="ShoppingSimulatorControlFunction.Start"/>.</summary>
public class ShoppingSimulatorStartRequest
{
    public int OrdersPerMinute            { get; set; } = 1;
    public int ExistingCustomerPercentage  { get; set; } = 30;
    public int DurationHours               { get; set; } = 24;
    public int NoOrderCustomerPercentage   { get; set; } = 50;
    public int AbandonedCartPercentage     { get; set; } = 10;
    public bool? IncludeConsumerOrders     { get; set; }
    public bool? IncludeStoreOrders        { get; set; }
    public int StoreOrderPercentage        { get; set; } = 20;
}
