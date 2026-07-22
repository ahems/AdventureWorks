using System.Text;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Queue-triggered processor that advances the warehouse simulation one operation at a time.
///
/// Each message goes through a two-phase lifecycle (IsCompletionPhase flag in payload):
///
///   Phase 1 — Start:
///     1. Assign an available warehouse worker (if any) matching the current shift.
///     2. Calculate operation duration from subcategory/supplier config + weight multiplier.
///     3. Record operation in active-op Table Storage partition.
///     4. Re-enqueue as Phase 2 with visibilityTimeout = calculated duration.
///
///   Phase 2 — Complete:
///     1. Self-reschedule check: if ScheduledCompletionUtc > now, re-enqueue with remaining delay.
///     2. Roll for damage: random check against configured damage rate for operation type.
///        Damaged units are deducted from effective quantity; a damage event is recorded.
///        Total loss: no inventory update.
///     3. Update SQL ProductInventory at LocationID 7 (Finished Goods Storage):
///        Store/Receive → increment quantity; Retrieve → decrement quantity.
///     4. Release worker (update status back to "available").
///     5. Post payroll and damage write-off bank transactions if applicable.
///     6. Increment daily metrics counters.
///
/// The container scales to zero once the queue drains (KEDA rule on warehouse-ops-queue).
/// </summary>
public class WarehouseOperationProcessorFunction
{
    internal const string QUEUE_NAME = "warehouse-ops-queue";

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private readonly ILogger<WarehouseOperationProcessorFunction> _logger;
    private readonly WarehouseService _warehouse;
    private readonly WebPubSubService _webPubSub;

    public WarehouseOperationProcessorFunction(
        ILogger<WarehouseOperationProcessorFunction> logger,
        WarehouseService warehouse,
        WebPubSubService webPubSub)
    {
        _logger    = logger;
        _warehouse = warehouse;
        _webPubSub = webPubSub;
    }

    [Function(nameof(WarehouseOperationProcessor))]
    public async Task WarehouseOperationProcessor(
        [QueueTrigger(QUEUE_NAME)] string messageText)
    {
        WarehouseOperationMessage? msg;
        try
        {
            // Queue messages are base64-encoded JSON
            string json = IsBase64(messageText)
                ? Encoding.UTF8.GetString(Convert.FromBase64String(messageText))
                : messageText;

            msg = JsonSerializer.Deserialize<WarehouseOperationMessage>(json, JsonOpts);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to deserialize warehouse operation message: {Message}", messageText);
            return; // Poison message — let it dead-letter
        }

        if (msg == null)
        {
            _logger.LogWarning("Null warehouse operation message received.");
            return;
        }

        try
        {
            if (!msg.IsCompletionPhase)
            {
                _logger.LogDebug("Warehouse Phase 1 — {Type} op {OperationId} for Product {ProductId} (qty {Qty})",
                    msg.OperationType, msg.OperationId, msg.ProductId, msg.Quantity);

                await _warehouse.ProcessStartPhaseAsync(msg);
            }
            else
            {
                _logger.LogDebug("Warehouse Phase 2 — {Type} op {OperationId} for Product {ProductId}",
                    msg.OperationType, msg.OperationId, msg.ProductId);

                await _warehouse.ProcessCompletionPhaseAsync(msg);

                await _webPubSub.SendToGroupAsync("warehouse", new { @event = "operation-completed", operationType = msg.OperationType, productId = msg.ProductId });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex,
                "Unhandled error processing warehouse op {OperationId} (Phase={Phase}, Type={Type})",
                msg.OperationId, msg.IsCompletionPhase ? "2-Complete" : "1-Start", msg.OperationType);
            throw; // Re-throw so the Functions runtime retries / dead-letters
        }
    }

    private static bool IsBase64(string s)
    {
        if (string.IsNullOrWhiteSpace(s) || s.Length % 4 != 0) return false;
        try { Convert.FromBase64String(s); return true; }
        catch { return false; }
    }
}
