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

        // ── Auto-stop check ─────────────────────────────────────────────────
        if (state.StopScheduledAt.HasValue && DateTimeOffset.UtcNow >= state.StopScheduledAt.Value)
        {
            state.IsRunning = false;
            await _simulator.SaveStateAsync(state);

            _logger.LogInformation(
                "[ShoppingSimulator] AUTO-STOPPED after {Duration}h (scheduled stop: {StopAt})",
                state.DurationHours, state.StopScheduledAt.Value.ToString("o"));

            _telemetry.TrackEvent("ShoppingSimulator.AutoStopped", new Dictionary<string, string>
            {
                ["DurationHours"]   = state.DurationHours.ToString(),
                ["TotalQueued"]     = state.TotalQueued.ToString(),
                ["StopScheduledAt"] = state.StopScheduledAt.Value.ToString("o"),
            });
            return;
        }

        _logger.LogInformation(
            "[ShoppingSimulator] Tick — enqueuing {Count} orders (consumer={Consumer}, store={Store})",
            state.OrdersPerMinute, state.IncludeConsumerOrders, state.IncludeStoreOrders);

        // ── Pre-fetch caches as needed ──────────────────────────────────────
        var topSpenderIds = Array.Empty<int>();
        var noOrderCustomerIds = Array.Empty<int>();
        var abandonedCartIds = Array.Empty<int>();
        var storeIds = Array.Empty<int>();

        if (state.IncludeConsumerOrders)
        {
            if (state.ExistingCustomerPercentage > 0)
                topSpenderIds = await _simulator.GetCachedTopSpenderIdsAsync();
            noOrderCustomerIds = await _simulator.GetCachedNoOrderCustomerIdsAsync();
            abandonedCartIds = await _simulator.GetCachedAbandonedCartCustomerIdsAsync();
        }
        if (state.IncludeStoreOrders)
        {
            storeIds = await _simulator.GetCachedStoreIdsAsync();
        }

        var queueClient = await _simulator.GetQueueClientAsync();

        int newCount      = 0;
        int existingCount = 0;
        int storeCount    = 0;

        for (int i = 0; i < state.OrdersPerMinute; i++)
        {
            SimulationOrderMessage msg;

            // ── Determine if this slot is a B2B store order ─────────────────
            bool isStoreSlot = false;
            if (state.IncludeConsumerOrders && state.IncludeStoreOrders && storeIds.Length > 0)
            {
                // When both enabled, StoreOrderPercentage% of messages go to B2B
                isStoreSlot = Random.Shared.Next(100) < state.StoreOrderPercentage;
            }
            else if (!state.IncludeConsumerOrders && state.IncludeStoreOrders)
            {
                isStoreSlot = true; // All messages are B2B
            }
            // else: all consumer (isStoreSlot stays false)

            if (isStoreSlot && storeIds.Length > 0)
            {
                var storeId = storeIds[Random.Shared.Next(storeIds.Length)];
                msg = new SimulationOrderMessage { CustomerId = 0, OrderMode = "b2b-store", StoreId = storeId };
                storeCount++;
            }
            else
            {
                // ── Consumer order routing ──────────────────────────────────
                bool useExisting = topSpenderIds.Length > 0
                    && Random.Shared.Next(100) < state.ExistingCustomerPercentage;

                if (useExisting)
                {
                    // Within existing-customer slots: check for abandoned-cart recovery
                    bool useCartRecovery = abandonedCartIds.Length > 0
                        && Random.Shared.Next(100) < state.AbandonedCartPercentage;

                    if (useCartRecovery)
                    {
                        var customerId = abandonedCartIds[Random.Shared.Next(abandonedCartIds.Length)];
                        msg = new SimulationOrderMessage { CustomerId = customerId, OrderMode = "cart-recovery" };
                    }
                    else
                    {
                        var customerId = topSpenderIds[Random.Shared.Next(topSpenderIds.Length)];
                        msg = new SimulationOrderMessage { CustomerId = customerId, OrderMode = "existing-repeat" };
                    }
                    existingCount++;
                }
                else
                {
                    // Within new-customer slots: check for no-order customer (sale-seeker)
                    bool useNoOrderCustomer = noOrderCustomerIds.Length > 0
                        && Random.Shared.Next(100) < state.NoOrderCustomerPercentage;

                    if (useNoOrderCustomer)
                    {
                        var customerId = noOrderCustomerIds[Random.Shared.Next(noOrderCustomerIds.Length)];
                        msg = new SimulationOrderMessage { CustomerId = customerId, OrderMode = "no-order-customer", PersonaHint = "sale-seeker" };
                    }
                    else
                    {
                        var persona = SimulationOrderQueueTrigger.RandomPersonas[
                            Random.Shared.Next(SimulationOrderQueueTrigger.RandomPersonas.Length)];
                        msg = new SimulationOrderMessage { CustomerId = 0, OrderMode = "new-persona", PersonaHint = persona };
                    }
                    newCount++;
                }
            }

            await queueClient.SendMessageAsync(
                JsonSerializer.Serialize(msg),
                visibilityTimeout: TimeSpan.Zero,
                timeToLive: TimeSpan.FromHours(24));
        }

        // Update breakdown counters
        await _simulator.IncrementCountersAsync(newCount, existingCount, storeCount);

        _telemetry.TrackEvent("ShoppingSimulator.Tick", new Dictionary<string, string>
        {
            ["OrdersEnqueued"]     = (newCount + existingCount + storeCount).ToString(),
            ["NewCustomer"]        = newCount.ToString(),
            ["ExistingCustomer"]   = existingCount.ToString(),
            ["StoreOrders"]        = storeCount.ToString(),
            ["OrdersPerMinute"]    = state.OrdersPerMinute.ToString(),
        });

        _logger.LogInformation(
            "[ShoppingSimulator] Enqueued {Total} orders — {New} new, {Existing} existing, {Store} B2B store",
            newCount + existingCount + storeCount, newCount, existingCount, storeCount);
    }
}
