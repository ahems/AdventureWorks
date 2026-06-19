using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.ApplicationInsights;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP control endpoints for the Shopping Simulator.
///
/// GET  /api/shopping-simulator/status  — returns current state + queue depth
/// POST /api/shopping-simulator/start   — starts the simulator with given config
/// POST /api/shopping-simulator/stop    — stops the simulator and clears the queue
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
            state.StartedAt,
            state.TotalQueued,
            state.NewCustomerQueued,
            state.ExistingCustomerQueued,
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

        var ordersPerMinute      = Math.Clamp(input?.OrdersPerMinute      ?? 1,  1,   60);
        var existingCustomerPct  = Math.Clamp(input?.ExistingCustomerPercentage ?? 30, 0, 100);

        var state = await _simulator.GetStateAsync();
        state.IsRunning                  = true;
        state.OrdersPerMinute            = ordersPerMinute;
        state.ExistingCustomerPercentage = existingCustomerPct;
        state.StartedAt                  = DateTimeOffset.UtcNow;
        await _simulator.SaveStateAsync(state);

        _logger.LogInformation("[ShoppingSimulator] Started — {Rate} orders/min, {Pct}% existing customers",
            ordersPerMinute, existingCustomerPct);

        _telemetry.TrackEvent("ShoppingSimulator.Started", new Dictionary<string, string>
        {
            ["OrdersPerMinute"]           = ordersPerMinute.ToString(),
            ["ExistingCustomerPercentage"] = existingCustomerPct.ToString(),
        });

        var queueDepth = await _simulator.GetQueueDepthAsync();
        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(new
        {
            state.IsRunning,
            state.OrdersPerMinute,
            state.ExistingCustomerPercentage,
            state.StartedAt,
            state.TotalQueued,
            state.NewCustomerQueued,
            state.ExistingCustomerQueued,
            queueDepth,
            message = $"Shopping simulator started at {ordersPerMinute} order{(ordersPerMinute == 1 ? "" : "s")}/min.",
        });
        return resp;
    }

    // ── POST stop ────────────────────────────────────────────────────────────

    /// <summary>
    /// Stops the Shopping Simulator and immediately clears all pending messages from the queue.
    /// </summary>
    [Function("ShoppingSimulator_Stop")]
    public async Task<HttpResponseData> Stop(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "shopping-simulator/stop")]
        HttpRequestData req)
    {
        var state = await _simulator.GetStateAsync();
        state.IsRunning = false;
        await _simulator.SaveStateAsync(state);
        await _simulator.ClearQueueAsync();

        _logger.LogInformation("[ShoppingSimulator] Stopped — queue cleared. Total queued this session: {Total}",
            state.TotalQueued);

        _telemetry.TrackEvent("ShoppingSimulator.Stopped", new Dictionary<string, string>
        {
            ["TotalQueued"]           = state.TotalQueued.ToString(),
            ["NewCustomerQueued"]     = state.NewCustomerQueued.ToString(),
            ["ExistingCustomerQueued"] = state.ExistingCustomerQueued.ToString(),
        });

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteAsJsonAsync(new
        {
            state.IsRunning,
            state.OrdersPerMinute,
            state.ExistingCustomerPercentage,
            state.StartedAt,
            state.TotalQueued,
            state.NewCustomerQueued,
            state.ExistingCustomerQueued,
            queueDepth = 0L,
            message = "Shopping simulator stopped and queue cleared.",
        });
        return resp;
    }
}

/// <summary>Request body for <see cref="ShoppingSimulatorControlFunction.Start"/>.</summary>
public class ShoppingSimulatorStartRequest
{
    public int OrdersPerMinute           { get; set; } = 1;
    public int ExistingCustomerPercentage { get; set; } = 30;
}
