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

    /// <summary>UTC timestamp when the simulator was last started.</summary>
    public DateTimeOffset? StartedAt { get; set; }

    /// <summary>Cumulative orders enqueued since the last reset.</summary>
    public long TotalQueued { get; set; }

    /// <summary>Cumulative orders enqueued using new-customer personas.</summary>
    public long NewCustomerQueued { get; set; }

    /// <summary>Cumulative orders enqueued targeting existing customers.</summary>
    public long ExistingCustomerQueued { get; set; }
}
