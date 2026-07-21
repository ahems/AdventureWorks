using Azure;
using Azure.Data.Tables;

namespace api_functions.Models;

/// <summary>
/// An AI-generated action proposal stored before human approval (ProposePending mode).
/// Stored in awManufacturingProposals table.
/// PartitionKey = "proposals", RowKey = inverted-tick prefix + ProposalId for newest-first ordering.
/// </summary>
public class ManufacturingProposalEntity : ITableEntity
{
    public string PartitionKey { get; set; } = "proposals";
    public string RowKey       { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; } = ETag.All;

    public string ProposalId { get; set; } = string.Empty;

    /// <summary>"manufacturing" — start a production run; "supply" — place a purchase order.</summary>
    public string Type { get; set; } = "manufacturing";

    public int ProductId { get; set; }
    public int Qty { get; set; }

    /// <summary>Vendor ID — only set for Type="supply".</summary>
    public string? VendorId { get; set; }

    /// <summary>AI-generated rationale for the proposed action.</summary>
    public string? Rationale { get; set; }

    /// <summary>pending | approved | rejected | executed</summary>
    public string Status { get; set; } = "pending";

    /// <summary>The sales order that triggered the agent run which created this proposal.</summary>
    public int SalesOrderId { get; set; }

    /// <summary>The agent run that created this proposal.</summary>
    public string? RunId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? ActionedAt { get; set; }

    public static string NewRowKey(string proposalId) =>
        $"{(long)(DateTimeOffset.MaxValue - DateTimeOffset.UtcNow).TotalMilliseconds:D20}-{proposalId}";
}
