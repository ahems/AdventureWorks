using System.Text.Json;
using Azure.Storage.Queues;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Queue-triggered processor that advances the manufacturing simulation one routing-operation
/// step at a time.
///
/// Each message goes through a two-phase lifecycle (IsCompletionPhase flag in payload):
///
///   Phase 1 — Start:
///     1. If first op for this WorkOrder: atomically consume purchased-component inventory.
///        On shortage → write shortage record, re-enqueue with MATERIALS_RETRY_DELAY_SECONDS delay.
///     2. Claim a location capacity slot via ETag-guarded Table Storage update.
///        On ETag conflict → re-enqueue with 5 s backoff.
///        On future start time → re-enqueue completion as Phase 2 with appropriate visibility delay.
///     3. Set WorkOrderRouting.ActualStartDate.
///     4. Enqueue Phase 2 (completion) message with visibilityTimeout = simulated op duration.
///
///   Phase 2 — Complete:
///     1. Self-reschedule check: if ScheduledCompletionUtc > now, re-enqueue with remaining delay.
///     2. Set WorkOrderRouting.ActualEndDate, ActualResourceHrs, ActualCost.
///     3. Scrap roll: probability from ScrapConfig for this location.
///        Partial failure: increment ScrappedQty, continue to next op.
///        Total failure (all qty scrapped): set WorkOrder ScrapReasonID, set EndDate, stop chain.
///     4. Get next routing op → enqueue Phase 1 for it (visibility 0).
///        OR if last op: CompleteWorkOrder, then check for newly unblocked parent assemblies.
///
/// The container scales to zero once the queue drains.
/// </summary>
public class WorkOrderOperationProcessorFunction
{
    internal const string QUEUE_NAME = "production-wo-queue";

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    // ScrapReasonIDs that indicate incoming purchased-component quality failure rather than
    // a process defect. When these fire, the simulator attributes the event to the most recent
    // supplier of the consumed components.
    //   1 = Brake assembly not as ordered
    //   3 = Gouge in metal
    //   7 = Handling damage
    //  10 = Seat assembly not as ordered
    private static readonly HashSet<int> MaterialQualityScrapReasonIds = new() { 1, 3, 7, 10 };

    private readonly ILogger<WorkOrderOperationProcessorFunction> _logger;
    private readonly WorkOrderSimulationService _sim;
    private readonly WorkforceService _workforce;
    private readonly BankService _bank;
    private readonly WebPubSubService _webPubSub;
    private readonly IConfiguration _config;

    public WorkOrderOperationProcessorFunction(
        ILogger<WorkOrderOperationProcessorFunction> logger,
        WorkOrderSimulationService sim,
        WorkforceService workforce,
        BankService bank,
        WebPubSubService webPubSub,
        IConfiguration config)
    {
        _logger    = logger;
        _sim       = sim;
        _workforce = workforce;
        _bank      = bank;
        _webPubSub = webPubSub;
        _config    = config;
    }

    [Function(nameof(WorkOrderOperationProcessor))]
    public async Task WorkOrderOperationProcessor(
        [QueueTrigger(QUEUE_NAME, Connection = "AzureWebJobsStorage")]
        BinaryData queueMessage)
    {
        WorkOrderOperationMessage? msg;
        try
        {
            msg = JsonSerializer.Deserialize<WorkOrderOperationMessage>(queueMessage.ToString(), JsonOpts);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to deserialise WorkOrderOperationMessage — dropping message.");
            return; // Let runtime delete the message; avoids poison-queue loops on bad payloads
        }

        if (msg == null || msg.WorkOrderId <= 0)
        {
            _logger.LogWarning("Received null or invalid WorkOrderOperationMessage — discarding.");
            return;
        }

        if (msg.IsCompletionPhase)
            await ProcessCompletionPhaseAsync(msg);
        else
            await ProcessStartPhaseAsync(msg);
    }

    // ── Phase 1: Start ────────────────────────────────────────────────────────

    private async Task ProcessStartPhaseAsync(WorkOrderOperationMessage msg)
    {
        _logger.LogInformation(
            "[Start] RunId={RunId} WO={WorkOrderId} Product={ProductId} Op={OpSeq} Location={LocationId} SlotClaimed={SlotClaimed}",
            msg.RunId, msg.WorkOrderId, msg.ProductId, msg.OperationSequence, msg.LocationId, msg.LocationSlotClaimed);

        var queueClient = await ManufacturingControlFunction.GetQueueClientAsync();

        // ── If slot already claimed, check if it's time to set ActualStartDate ──
        if (msg.LocationSlotClaimed)
        {
            var now = DateTime.UtcNow;
            if (now < msg.ScheduledStartUtc)
            {
                // Not yet time — re-enqueue with remaining delay
                var remaining = msg.ScheduledStartUtc - now;
                await RequeueAsync(queueClient, msg, remaining);
                return;
            }

            // Time to start
            await SetActualStartAndEnqueueCompletionAsync(queueClient, msg);
            return;
        }

        // ── First arrival: consume inventory (first op of the WO only) ──────────
        if (await _sim.IsFirstRoutingOpAsync(msg.WorkOrderId, msg.OperationSequence))
        {
            var components = await _sim.GetPurchasedComponentsAsync(msg.ProductId,
                await GetWorkOrderOrderQtyAsync(msg.WorkOrderId));

            foreach (var (componentProductId, requiredQty) in components)
            {
                var (success, available) = await _sim.ConsumeInventoryAsync(componentProductId, requiredQty, msg.WorkOrderId);
                if (!success)
                {
                    string componentName = await GetProductNameAsync(componentProductId);
                    await _sim.ClearShortageAsync(msg.WorkOrderId, componentProductId); // clear stale
                    await _sim.WriteShortageAsync(msg.WorkOrderId, componentProductId,
                        componentName, requiredQty, available);

                    int retryDelaySec = int.Parse(
                        _config["MATERIALS_RETRY_DELAY_SECONDS"] ?? "30");

                    _logger.LogWarning(
                        "[Start] Material shortage: WO={WorkOrderId} needs {Needed} of ProductID={ComponentId} " +
                        "({Name}) but only {Available} available. Retry #{Retry} in {Delay}s.",
                        msg.WorkOrderId, requiredQty, componentProductId, componentName,
                        available, msg.MaterialRetryCount + 1, retryDelaySec);

                    await _webPubSub.SendToGroupAsync("manufacturing-ops", new { @event = "shortage-updated", productId = componentProductId, workOrderId = msg.WorkOrderId });

                    var retryMsg = msg with { MaterialRetryCount = msg.MaterialRetryCount + 1 };
                    await RequeueAsync(queueClient, retryMsg, TimeSpan.FromSeconds(retryDelaySec));
                    return;
                }

                // Consumption succeeded — remove any pending shortage record
                await _sim.ClearShortageAsync(msg.WorkOrderId, componentProductId);
                if (msg.MaterialRetryCount > 0)
                {
                    await _webPubSub.SendToGroupAsync("manufacturing-ops", new { @event = "shortage-updated", productId = componentProductId, workOrderId = msg.WorkOrderId });
                }
                _logger.LogDebug("Consumed {Qty} units of ProductID={ComponentId} for WO={WorkOrderId}",
                    requiredQty, componentProductId, msg.WorkOrderId);
            }
        }

        // ── Claim a location capacity slot ────────────────────────────────────
        var (claimed, startDelay, totalDuration) = await _sim.TryClaimLocationSlotAsync(
            msg.LocationId, msg.PlannedCostForOp, msg.CostRateForLocation);

        if (!claimed)
        {
            // ETag conflict — short backoff, try again
            _logger.LogDebug("ETag conflict claiming slot for Location={LocationId}, re-enqueueing with backoff.", msg.LocationId);
            await RequeueAsync(queueClient, msg, TimeSpan.FromSeconds(5));
            return;
        }

        var scheduledStart      = DateTime.UtcNow.Add(startDelay);
        var scheduledCompletion = scheduledStart.Add(totalDuration);

        var claimedMsg = msg with
        {
            LocationSlotClaimed    = true,
            ScheduledStartUtc      = scheduledStart,
            ScheduledCompletionUtc = scheduledCompletion,
        };

        if (startDelay > TimeSpan.Zero)
        {
            // Location busy — slot reserved for a future time; re-enqueue to fire at slot-start
            _logger.LogDebug(
                "Location={LocationId} busy; slot reserved, starts in {Delay:F0}s for WO={WorkOrderId}.",
                msg.LocationId, startDelay.TotalSeconds, msg.WorkOrderId);
            await RequeueAsync(queueClient, claimedMsg, startDelay);
            return;
        }

        // Location free now — proceed immediately
        await SetActualStartAndEnqueueCompletionAsync(queueClient, claimedMsg);
    }

    private async Task SetActualStartAndEnqueueCompletionAsync(
        QueueClient queueClient, WorkOrderOperationMessage msg)
    {
        var started = await _sim.SetActualStartDateAsync(
            msg.WorkOrderId, msg.OperationSequence, msg.ScheduledStartUtc == default
                ? DateTime.UtcNow
                : msg.ScheduledStartUtc);

        if (!started)
        {
            _logger.LogDebug("ActualStartDate already set for WO={WorkOrderId} Op={OpSeq} — idempotent skip.",
                msg.WorkOrderId, msg.OperationSequence);
            // Still enqueue completion if not already done (safe because phase 2 is also idempotent)
        }

        // Assign an operator at this location for labour-cost tracking
        WorkerAssignment? worker = null;
        if (started) // only on the genuine first start
        {
            try
            {
                worker = await _workforce.AssignOperatorAsync(
                    msg.LocationId, msg.WorkOrderId,
                    $"Op {msg.OperationSequence}");
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Workforce] Could not assign operator for WO={WorkOrderId} Op={OpSeq} — proceeding without assignment.",
                    msg.WorkOrderId, msg.OperationSequence);
            }
        }

        var completionMsg = msg with
        {
            IsCompletionPhase   = true,
            AssignedEmployeeId  = worker?.EmployeeId ?? msg.AssignedEmployeeId,
            AssignedWorkerName  = worker?.Name       ?? msg.AssignedWorkerName,
            AssignedHourlyRate  = worker != null ? worker.HourlyRate : msg.AssignedHourlyRate,
        };
        var delay = msg.ScheduledCompletionUtc > DateTime.UtcNow
            ? msg.ScheduledCompletionUtc - DateTime.UtcNow
            : TimeSpan.Zero;

        await RequeueAsync(queueClient, completionMsg, delay);

        _logger.LogInformation(
            "[Start→Complete] WO={WorkOrderId} Op={OpSeq} Location={LocationId}: ActualStart set, completion queued in {Delay:F0}s",
            msg.WorkOrderId, msg.OperationSequence, msg.LocationId, delay.TotalSeconds);
    }

    // ── Phase 2: Complete ─────────────────────────────────────────────────────

    private async Task ProcessCompletionPhaseAsync(WorkOrderOperationMessage msg)
    {
        // Self-reschedule: if not yet due, put message back with remaining visibility
        if (msg.ScheduledCompletionUtc > DateTime.UtcNow)
        {
            var remaining = msg.ScheduledCompletionUtc - DateTime.UtcNow;
            _logger.LogDebug(
                "[Complete] WO={WorkOrderId} Op={OpSeq} not yet due (in {Sec:F0}s) — rescheduling.",
                msg.WorkOrderId, msg.OperationSequence, remaining.TotalSeconds);
            await RequeueAsync(await ManufacturingControlFunction.GetQueueClientAsync(), msg, remaining);
            return;
        }

        _logger.LogInformation(
            "[Complete] RunId={RunId} WO={WorkOrderId} Product={ProductId} Op={OpSeq} Location={LocationId}",
            msg.RunId, msg.WorkOrderId, msg.ProductId, msg.OperationSequence, msg.LocationId);

        // Compute actual hours and cost
        var now = DateTime.UtcNow;
        double simulationScale = double.Parse(_config["SIMULATION_TIME_SCALE_FACTOR"] ?? "60");
        double opDurationHrs = msg.CostRateForLocation > 0
            ? msg.PlannedCostForOp / msg.CostRateForLocation
            : 0.5;
        decimal actualHrs  = (decimal)(opDurationHrs);
        decimal actualCost = (decimal)(opDurationHrs * msg.CostRateForLocation);

        // Set ActualEndDate (idempotent — WHERE ActualEndDate IS NULL)
        var completed = await _sim.SetActualEndDateAsync(
            msg.WorkOrderId, msg.OperationSequence, now, actualHrs, actualCost);

        if (!completed)
        {
            _logger.LogDebug(
                "ActualEndDate already set for WO={WorkOrderId} Op={OpSeq} — idempotent skip.",
                msg.WorkOrderId, msg.OperationSequence);
            return;
        }

        // Release the assigned operator back to the available pool
        if (msg.AssignedEmployeeId.HasValue)
        {
            try { await _workforce.ReleaseOperatorAsync(msg.AssignedEmployeeId.Value); }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Workforce] Could not release operator {EmployeeId} for WO={WorkOrderId} Op={OpSeq} — continuing.",
                    msg.AssignedEmployeeId.Value, msg.WorkOrderId, msg.OperationSequence);
            }
        }

        // Notify clients that a routing operation completed (distinct from wo-completed which fires only on final op)
        await _webPubSub.SendToGroupAsync("manufacturing-ops", new { @event = "routing-updated", workOrderId = msg.WorkOrderId, operationSequence = msg.OperationSequence });

        // Bank: payroll charge for this routing operation
        if (msg.AssignedEmployeeId.HasValue && msg.AssignedHourlyRate > 0)
        {
            try
            {
                var laborCost = actualHrs * (decimal)msg.AssignedHourlyRate;
                await _bank.InitializeAsync();
                await _bank.PostTransactionAsync(new BankTransactionRequest(
                    CurrencyCode:    "USD",
                    Amount:          -laborCost,
                    Description:     $"Payroll: {msg.AssignedWorkerName ?? "Operator"} \u2014 WO-{msg.WorkOrderId} Op-{msg.OperationSequence} @ Location {msg.LocationId}",
                    ReferenceId:     $"WO-{msg.WorkOrderId}-OP-{msg.OperationSequence}",
                    TransactionType: "payroll"));
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Bank] Failed to record payroll for WO={WorkOrderId} Op={OpSeq} — continuing.",
                    msg.WorkOrderId, msg.OperationSequence);
            }
        }

        // ── Scrap logic ───────────────────────────────────────────────────────
        var scrapConfig = await _sim.GetScrapConfigAsync(msg.LocationId);
        bool isScrapped = Random.Shared.NextDouble() < scrapConfig.FailureRatePct
                          && scrapConfig.ScrapReasonIds.Length > 0;

        if (isScrapped)
        {
            int reasonId = scrapConfig.ScrapReasonIds[
                Random.Shared.Next(scrapConfig.ScrapReasonIds.Length)];
            string reasonName = await _sim.GetScrapReasonNameAsync(reasonId);

            // Determine if this is a total failure (all units scrapped)
            var wo = await GetWorkOrderSummaryAsync(msg.WorkOrderId);
            bool isTotalFailure = wo.HasValue && (wo.Value.ScrappedQty + 1) >= wo.Value.OrderQty;

            // ── Vendor attribution ────────────────────────────────────────────
            // Scrap reasons 1 (brake not as ordered), 3 (gouge in metal), 7 (handling damage),
            // and 10 (seat not as ordered) are consistent with incoming purchased-component
            // quality failures rather than process failures. When one of these fires, look up
            // the most-recently-received supplier for this work order's purchased components.
            int? suppVendorId = null; string? suppVendorName = null;
            int? suppCompId   = null; string? suppCompName   = null;

            if (MaterialQualityScrapReasonIds.Contains(reasonId))
            {
                var components = await _sim.GetPurchasedComponentsAsync(
                    msg.ProductId, wo?.OrderQty ?? 1);
                if (components.Count > 0)
                {
                    var supplier = await _sim.GetMostRecentSupplierAsync(
                        components.Select(c => c.ProductId));
                    if (supplier.HasValue)
                    {
                        (suppVendorId, suppVendorName, suppCompId, suppCompName) =
                            (supplier.Value.VendorId, supplier.Value.VendorName,
                             supplier.Value.ComponentProductId, supplier.Value.ComponentName);
                    }
                }
            }

            await _sim.UpdateWorkOrderScrapAsync(msg.WorkOrderId, 1, reasonId);
            await _sim.WriteScrapEventAsync(
                msg.WorkOrderId, msg.ProductId,
                await GetProductNameAsync(msg.ProductId),
                msg.LocationId, scrapConfig.LocationName,
                reasonId, reasonName, isTotalFailure,
                suppVendorId, suppVendorName, suppCompId, suppCompName);

            // Bank: scrap write-off — charge the standard cost of the scrapped unit
            try
            {
                var standardCost = await _sim.GetProductStandardCostAsync(msg.ProductId);
                if (standardCost > 0m)
                {
                    var productName = await GetProductNameAsync(msg.ProductId);
                    await _bank.InitializeAsync();
                    await _bank.PostTransactionAsync(new BankTransactionRequest(
                        CurrencyCode:    "USD",
                        Amount:          -standardCost,
                        Description:     $"Scrap write-off: {productName} \u2014 {reasonName}{(suppVendorId.HasValue ? $" (Supplier: {suppVendorName})" : "")}",
                        ReferenceId:     $"SCRAP-WO-{msg.WorkOrderId}",
                        TransactionType: "other"));
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Bank] Failed to record scrap write-off for WO={WorkOrderId} — continuing.", msg.WorkOrderId);
            }

            _logger.LogWarning(
                "[Scrap] WO={WorkOrderId} Location={LocationId} Reason={Reason} TotalFailure={Total}{VendorNote}",
                msg.WorkOrderId, msg.LocationId, reasonName, isTotalFailure,
                suppVendorId.HasValue ? $" AttributedVendor={suppVendorId}({suppVendorName})" : "");

            await _webPubSub.SendToGroupAsync("manufacturing-ops", new { @event = "scrap-event", workOrderId = msg.WorkOrderId, productId = msg.ProductId, locationId = msg.LocationId, scrappedQty = 1 });

            if (isTotalFailure)
            {
                // Total failure — mark WO complete with EndDate (no inventory increment)
                await _sim.CompleteWorkOrderAsync(msg.WorkOrderId);
                _logger.LogWarning(
                    "WO={WorkOrderId} (Product={ProductId}) TOTAL FAILURE at Location={LocationId} — no stock produced.",
                    msg.WorkOrderId, msg.ProductId, msg.LocationId);
                return; // Parent assembly will stall for materials — shortage board reflects this
            }
        }

        // ── Chain next routing op ─────────────────────────────────────────────
        var nextOp = await _sim.GetNextRoutingOpAsync(msg.WorkOrderId, msg.OperationSequence);
        if (nextOp != null)
        {
            var nextMsg = new WorkOrderOperationMessage
            {
                RunId               = msg.RunId,
                WorkOrderId         = msg.WorkOrderId,
                ProductId           = msg.ProductId,
                OperationSequence   = nextOp.OperationSequence,
                LocationId          = nextOp.LocationId,
                PlannedCostForOp    = (double)nextOp.PlannedCost,
                CostRateForLocation = (double)nextOp.CostRate,
            };

            await RequeueAsync(
                await ManufacturingControlFunction.GetQueueClientAsync(),
                nextMsg,
                TimeSpan.Zero);

            _logger.LogInformation(
                "[Chain] WO={WorkOrderId} → Op={NextOpSeq} at Location={LocationId}",
                msg.WorkOrderId, nextOp.OperationSequence, nextOp.LocationId);
            return;
        }

        // ── All ops done — complete the WorkOrder ─────────────────────────────
        await _sim.CompleteWorkOrderAsync(msg.WorkOrderId);

        await _webPubSub.SendToGroupAsync("manufacturing-ops", new { @event = "wo-completed", workOrderId = msg.WorkOrderId, productId = msg.ProductId });
        await _webPubSub.SendToGroupAsync("warehouse", new { @event = "inventory-updated", productId = msg.ProductId });

        // ── Unblock parent assemblies via BOM chain ────────────────────────────
        if (!string.IsNullOrEmpty(msg.RunId))
        {
            var readyParentWoIds = await _sim.GetReadyParentWorkOrderIdsAsync(msg.RunId, msg.ProductId);
            foreach (var parentWoId in readyParentWoIds)
            {
                var firstParentOp = await _sim.GetFirstRoutingOpAsync(parentWoId);
                if (firstParentOp == null)
                {
                    _logger.LogWarning("Parent WO={ParentWoId} has no routing ops to start.", parentWoId);
                    continue;
                }

                var parentMsg = new WorkOrderOperationMessage
                {
                    RunId               = msg.RunId,
                    WorkOrderId         = parentWoId,
                    ProductId           = firstParentOp.ProductId,
                    OperationSequence   = firstParentOp.OperationSequence,
                    LocationId          = firstParentOp.LocationId,
                    PlannedCostForOp    = (double)firstParentOp.PlannedCost,
                    CostRateForLocation = (double)firstParentOp.CostRate,
                };

                await RequeueAsync(
                    await ManufacturingControlFunction.GetQueueClientAsync(),
                    parentMsg,
                    TimeSpan.Zero);

                _logger.LogInformation(
                    "[BOM-Chain] All children done → unblocking parent WO={ParentWoId} (Product={ParentProductId})",
                    parentWoId, firstParentOp.ProductId);
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static async Task RequeueAsync(QueueClient queueClient,
        WorkOrderOperationMessage msg, TimeSpan visibility)
    {
        // Cap visibility at Azure Storage max (7 days)
        var safeVisibility = visibility > TimeSpan.FromDays(7)
            ? TimeSpan.FromDays(7)
            : visibility < TimeSpan.Zero ? TimeSpan.Zero : visibility;

        await queueClient.SendMessageAsync(
            JsonSerializer.Serialize(msg),
            visibilityTimeout: safeVisibility,
            timeToLive: null);
    }

    private async Task<int> GetWorkOrderOrderQtyAsync(int workOrderId)
    {
        // Lightweight helper — avoids adding a new service method for a simple scalar
        // Uses the service's connection through a tiny Dapper query surfaced here
        // In a larger codebase this would live on the service; kept here for locality.
        using var conn = new Microsoft.Data.SqlClient.SqlConnection(
            System.Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not set"));
        await conn.OpenAsync();
        return await Dapper.SqlMapper.ExecuteScalarAsync<int>(conn,
            "SELECT OrderQty FROM Production.WorkOrder WHERE WorkOrderID = @Id",
            new { Id = workOrderId });
    }

    private async Task<string> GetProductNameAsync(int productId)
    {
        using var conn = new Microsoft.Data.SqlClient.SqlConnection(
            System.Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not set"));
        await conn.OpenAsync();
        return await Dapper.SqlMapper.ExecuteScalarAsync<string>(conn,
            "SELECT Name FROM Production.Product WHERE ProductID = @Id",
            new { Id = productId }) ?? productId.ToString();
    }

    private async Task<(int OrderQty, int ScrappedQty)?> GetWorkOrderSummaryAsync(int workOrderId)
    {
        using var conn = new Microsoft.Data.SqlClient.SqlConnection(
            System.Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not set"));
        await conn.OpenAsync();
        var row = await Dapper.SqlMapper.QuerySingleOrDefaultAsync(conn,
            "SELECT OrderQty, ScrappedQty FROM Production.WorkOrder WHERE WorkOrderID = @Id",
            new { Id = workOrderId });
        if (row == null) return null;
        return ((int)row.OrderQty, (int)row.ScrappedQty);
    }
}
