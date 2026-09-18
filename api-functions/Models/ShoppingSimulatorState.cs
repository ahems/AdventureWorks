using Azure;
using Azure.Data.Tables;

namespace api_functions.Models;

/// <summary>
/// Persisted state for the Shopping Simulator, stored as a single row in Azure Table Storage.
/// PartitionKey = "shopping", RowKey = "state".
/// </summary>
public class ShoppingSimulatorState : ITableEntity
{
    public string PartitionKey { get; set; } = "shopping";
    public string RowKey { get; set; } = "state";
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; } = ETag.All;

    /// <summary>Whether the simulator is currently running and injecting orders.</summary>
    public bool IsRunning { get; set; }

    /// <summary>
    /// Orders to enqueue per minute (1–60).
    /// At 60 orders/min the queue receives approximately 1 new order message per second.
    /// </summary>
    public int OrdersPerMinute { get; set; } = 1;

    /// <summary>Percentage of enqueued orders that target existing customers (0–100).</summary>
    public int ExistingCustomerPercentage { get; set; } = 30;

    /// <summary>Maximum duration in hours before the simulator auto-stops (1–72, default 24).</summary>
    public int DurationHours { get; set; } = 24;

    /// <summary>UTC timestamp when the simulator should automatically stop. Computed as StartedAt + DurationHours.</summary>
    public DateTimeOffset? StopScheduledAt { get; set; }

    /// <summary>
    /// Percentage of new-customer slots allocated to registered customers who have no orders yet (0–100).
    /// These customers are drawn to sale/discounted items (simulates marketing email re-engagement).
    /// </summary>
    public int NoOrderCustomerPercentage { get; set; } = 50;

    /// <summary>
    /// Percentage of existing-customer slots allocated to customers with abandoned carts (0–100).
    /// Simulates Smart Cart Recovery emails prompting customers to complete their purchase.
    /// </summary>
    public int AbandonedCartPercentage { get; set; } = 10;

    /// <summary>Whether to include consumer (B2C) orders in the simulation.</summary>
    public bool IncludeConsumerOrders { get; set; } = true;

    /// <summary>Whether to include B2B store orders in the simulation.</summary>
    public bool IncludeStoreOrders { get; set; } = true;

    /// <summary>Percentage of total messages allocated to B2B store orders when both consumer and store are enabled (5–50).</summary>
    public int StoreOrderPercentage { get; set; } = 20;

    /// <summary>UTC timestamp when the simulator was last started.</summary>
    public DateTimeOffset? StartedAt { get; set; }

    /// <summary>Cumulative orders enqueued since the last reset.</summary>
    public long TotalQueued { get; set; }

    /// <summary>Cumulative orders enqueued using new-customer personas.</summary>
    public long NewCustomerQueued { get; set; }

    /// <summary>Cumulative orders enqueued targeting existing customers.</summary>
    public long ExistingCustomerQueued { get; set; }

    /// <summary>Cumulative B2B store orders enqueued.</summary>
    public long StoreOrderQueued { get; set; }
}
