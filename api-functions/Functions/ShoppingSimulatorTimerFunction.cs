using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.ApplicationInsights;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Timer-driven message producer for the Shopping Simulator.
///
/// Fires every minute. If the simulator is running, enqueues <c>OrdersPerMinute</c> messages
/// to the <c>simulation-order-queue</c>, mixing new-customer personas with existing customers
/// according to the configured <c>ExistingCustomerPercentage</c>.
///
/// At <c>OrdersPerMinute=60</c> the queue receives ~1 message per second, which is the
/// maximum injection rate. The queue drains at AI processing speed — the backlog grows
/// quickly at high rates, which is the intended stress-test behaviour.
/// </summary>
public class ShoppingSimulatorTimerFunction
{
    private readonly ILogger<ShoppingSimulatorTimerFunction> _logger;
    private readonly ShoppingSimulatorService _simulator;
    private readonly TelemetryClient _telemetry;

    public ShoppingSimulatorTimerFunction(
        ILogger<ShoppingSimulatorTimerFunction> logger,
        ShoppingSimulatorService simulator,
        TelemetryClient telemetry)
    {
        _logger    = logger;
        _simulator = simulator;
        _telemetry = telemetry;
    }

    [Function("ShoppingSimulator_Timer")]
    public async Task Run(
        [TimerTrigger("0 * * * * *")] TimerInfo timer)
    {
        var state = await _simulator.GetStateAsync();
        if (!state.IsRunning)
        {
            _logger.LogDebug("[ShoppingSimulator] Timer fired — simulator not running, skipping.");
            return;
        }

        _logger.LogInformation(
            "[ShoppingSimulator] Tick — enqueuing {Count} orders ({ExistingPct}% existing customers)",
            state.OrdersPerMinute, state.ExistingCustomerPercentage);

        // Pre-fetch the top-spender list if we'll be using existing-customer slots
        var topSpenderIds = Array.Empty<int>();
        if (state.ExistingCustomerPercentage > 0)
        {
            topSpenderIds = await _simulator.GetCachedTopSpenderIdsAsync();
        }

        var queueClient = await _simulator.GetQueueClientAsync();

        int newCount      = 0;
        int existingCount = 0;

        for (int i = 0; i < state.OrdersPerMinute; i++)
        {
            SimulationOrderMessage msg;

            // Decide whether this slot is for an existing customer or a new-customer persona.
            bool useExisting = topSpenderIds.Length > 0
                && Random.Shared.Next(100) < state.ExistingCustomerPercentage;

            if (useExisting)
            {
                var customerId = topSpenderIds[Random.Shared.Next(topSpenderIds.Length)];
                msg = new SimulationOrderMessage { CustomerId = customerId };
                existingCount++;
            }
            else
            {
                var persona = SimulationOrderQueueTrigger.RandomPersonas[
                    Random.Shared.Next(SimulationOrderQueueTrigger.RandomPersonas.Length)];
                msg = new SimulationOrderMessage { CustomerId = 0, PersonaHint = persona };
                newCount++;
            }

            await queueClient.SendMessageAsync(
                JsonSerializer.Serialize(msg),
                visibilityTimeout: TimeSpan.Zero,
                timeToLive: TimeSpan.FromHours(24));
        }

        // Update breakdown counters (non-critical: failures are swallowed inside the service)
        await _simulator.IncrementCountersAsync(newCount, existingCount);

        _telemetry.TrackEvent("ShoppingSimulator.Tick", new Dictionary<string, string>
        {
            ["OrdersEnqueued"]     = (newCount + existingCount).ToString(),
            ["NewCustomer"]        = newCount.ToString(),
            ["ExistingCustomer"]   = existingCount.ToString(),
            ["OrdersPerMinute"]    = state.OrdersPerMinute.ToString(),
        });

        _logger.LogInformation(
            "[ShoppingSimulator] Enqueued {Total} orders — {New} new-customer, {Existing} existing-customer",
            newCount + existingCount, newCount, existingCount);
    }
}
