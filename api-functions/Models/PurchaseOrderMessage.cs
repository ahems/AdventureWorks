namespace api_functions.Models;

/// <summary>
/// Message placed on supply-chain-orders-queue to drive two types of simulation events:
///
///   "order-transition" — advance a purchase order through the state machine:
///       placed → confirmed → picking → shipped → delivered (or out_of_stock / cancelled)
///
///   "vendor-restock"   — restore a vendor's stock level for one or all components
///       after a simulated lead-time delay.
///
/// Timing uses the same SIMULATION_TIME_SCALE_FACTOR as the manufacturing engine:
///   1 real second = SIMULATION_TIME_SCALE_FACTOR simulated minutes
/// </summary>
public record PurchaseOrderMessage
{
    /// <summary>"order-transition" or "vendor-restock"</summary>
    public string MessageType { get; set; } = string.Empty;

    // ── order-transition fields ─────────────────────────────────────────────

    /// <summary>GUID of the purchase order being transitioned.</summary>
    public string OrderId { get; set; } = string.Empty;

    /// <summary>Target status to transition INTO on next processing (e.g. "confirmed").</summary>
    public string TargetStatus { get; set; } = string.Empty;

    /// <summary>UTC time this transition is scheduled to execute. Self-reschedules if not yet due.</summary>
    public DateTime ScheduledAtUtc { get; set; }

    // ── vendor-restock fields ───────────────────────────────────────────────

    /// <summary>Vendor ID to restock (e.g. "fastparts").</summary>
    public string VendorId { get; set; } = string.Empty;

    /// <summary>ProductID to restock. 0 = restock all components for this vendor.</summary>
    public int ProductId { get; set; }

    /// <summary>Qty from the PO that triggered this restock. Used for demand-scaled restocking.</summary>
    public int OrderedQty { get; set; }
}
