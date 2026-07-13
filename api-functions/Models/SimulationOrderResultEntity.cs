using Azure;
using Azure.Data.Tables;

namespace api_functions.Models;

/// <summary>
/// A completed simulation order result stored in Azure Table Storage.
/// PartitionKey = "results", RowKey = inverted timestamp (most recent first).
/// </summary>
public class SimulationOrderResultEntity : ITableEntity
{
    public string PartitionKey { get; set; } = "results";
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; } = ETag.All;

    public bool Success { get; set; }
    public int SalesOrderId { get; set; }
    public int CustomerId { get; set; }
    public string? CustomerName { get; set; }
    public bool NewCustomerCreated { get; set; }
    public double TotalDue { get; set; }
    public string? ErrorMessage { get; set; }
    public string? PersonaType { get; set; }
    public string? AiReasoning { get; set; }
    public int ItemCount { get; set; }
    public DateTimeOffset CompletedAt { get; set; }

    /// <summary>Order type: "consumer", "b2b-store", "cart-recovery", "no-order-customer".</summary>
    public string? OrderType { get; set; }

    /// <summary>Generates an inverted-tick row key so Table Storage returns most recent first.</summary>
    public static string GenerateRowKey(DateTimeOffset time)
        => $"{DateTimeOffset.MaxValue.Ticks - time.Ticks:D19}";
}
