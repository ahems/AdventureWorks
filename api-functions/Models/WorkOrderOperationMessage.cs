namespace api_functions.Models;

/// <summary>
/// Message placed on the production-wo-queue to drive the manufacturing simulation.
/// Each message represents one routing operation phase for a specific WorkOrder.
///
/// Two-phase lifecycle per operation:
///   Phase 1 (IsCompletionPhase=false): consume purchased-component inventory, claim a
///     location capacity slot, set WorkOrderRouting.ActualStartDate.
///   Phase 2 (IsCompletionPhase=true): apply scrap logic, set ActualEndDate/ActualCost,
///     then either chain the next routing op or complete the WorkOrder and unblock parent assemblies.
///
/// Timing is driven entirely by queue visibility timeouts — no timer triggers, no sleeps.
/// The container therefore scales to zero when the queue is empty.
/// </summary>
public record WorkOrderOperationMessage
{
    /// <summary>GUID identifying the production run. Used to correlate BOM-chained WorkOrders.</summary>
    public string RunId { get; set; } = string.Empty;

    /// <summary>Production.WorkOrder.WorkOrderID being processed.</summary>
    public int WorkOrderId { get; set; }

    /// <summary>Production.WorkOrder.ProductID for this WorkOrder.</summary>
    public int ProductId { get; set; }

    /// <summary>Production.WorkOrderRouting.OperationSequence being processed.</summary>
    public int OperationSequence { get; set; }

    /// <summary>Production.WorkOrderRouting.LocationID for this operation. Cached to avoid an extra DB round-trip.</summary>
    public int LocationId { get; set; }

    /// <summary>
    /// false = start phase: consume inventory, claim location slot, update ActualStartDate.
    /// true  = completion phase: update ActualEndDate, apply scrap, chain next op or complete WO.
    /// </summary>
    public bool IsCompletionPhase { get; set; }

    /// <summary>
    /// true when a location capacity slot has already been atomically reserved for this op.
    /// On start-phase retry the processor skips slot claiming and goes straight to ActualStartDate.
    /// </summary>
    public bool LocationSlotClaimed { get; set; }

    /// <summary>UTC time this operation is scheduled to begin (set after slot is claimed).</summary>
    public DateTime ScheduledStartUtc { get; set; }

    /// <summary>UTC time this operation is scheduled to end (set after slot is claimed).</summary>
    public DateTime ScheduledCompletionUtc { get; set; }

    /// <summary>Planned cost for this routing operation in dollars. Cached from WorkOrderRouting.PlannedCost.</summary>
    public double PlannedCostForOp { get; set; }

    /// <summary>Cost rate ($/hr) of the location. Cached from Production.Location.CostRate.</summary>
    public double CostRateForLocation { get; set; }

    /// <summary>
    /// Number of times this message has been re-queued because purchased-component inventory
    /// was insufficient. Visible in the status endpoint for bottleneck analysis.
    /// </summary>
    public int MaterialRetryCount { get; set; }

    // ── Workforce assignment (Phase 1 → Phase 2 hand-off) ────────────────────

    /// <summary>EmployeeID of the worker assigned to this operation (null if none available).</summary>
    public int? AssignedEmployeeId { get; set; }

    /// <summary>Full name of the assigned worker — used in payroll transaction descriptions.</summary>
    public string? AssignedWorkerName { get; set; }

    /// <summary>Hourly wage of the assigned worker ($/hr). Zero if no worker was assigned.</summary>
    public double AssignedHourlyRate { get; set; }
}
