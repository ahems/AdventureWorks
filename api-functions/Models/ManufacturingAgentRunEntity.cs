using Azure;
using Azure.Data.Tables;

namespace api_functions.Models;

/// <summary>
/// Records a single manufacturing agent invocation from enqueue through completion.
/// Stored in awManufacturingAgentRuns table.
/// PartitionKey = "runs", RowKey = inverted-tick prefix + RunId for newest-first ordering.
/// </summary>
public class ManufacturingAgentRunEntity : ITableEntity
{
    public string PartitionKey { get; set; } = "runs";
    public string RowKey       { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; } = ETag.All;

    public string RunId { get; set; } = string.Empty;
    public int SalesOrderId { get; set; }
    public int CustomerId   { get; set; }

    /// <summary>Agent mode at the time of invocation (cast from <see cref="ManufacturingAgentMode"/>).</summary>
    public int Mode { get; set; } = (int)ManufacturingAgentMode.ReadOnly;

    /// <summary>pending | running | retrying | completed | failed</summary>
    public string Status { get; set; } = "pending";

    public DateTimeOffset EnqueuedAt   { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? StartedAt   { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>
    /// The agent's response text — its findings summary.
    /// Previously discarded; now persisted so the manufacturing UI can display it.
    /// </summary>
    public string? FindingsSummary { get; set; }

    /// <summary>JSON array of MCP tool names called, e.g. ["GetOrderDetails","CheckInventoryAvailability"].</summary>
    public string? ToolsUsed { get; set; }

    /// <summary>JSON array of proposal IDs created when Mode=ProposePending.</summary>
    public string? ProposalIds { get; set; }

    /// <summary>JSON array of action descriptions when Mode=FullyAutonomous, e.g. ["PlaceSupplyOrder(vendor=1, product=316, qty=100)"].</summary>
    public string? ActionsExecuted { get; set; }

    /// <summary>
    /// JSON array of intra-run progress steps emitted via the step-callback endpoint.
    /// Schema: [{ "key": string, "label": string, "startedAt": ISO8601, "completedAt": ISO8601? }]
    /// </summary>
    public string? StepsJson { get; set; }

    // ── Retry tracking ────────────────────────────────────────────────────────

    public int RetryCount { get; set; }
    public DateTimeOffset? RetryAfterUtc { get; set; }
    public string? LastError { get; set; }

    // ── Helpers ───────────────────────────────────────────────────────────────

    public static string NewRowKey(string runId) =>
        $"{(long)(DateTimeOffset.MaxValue - DateTimeOffset.UtcNow).TotalMilliseconds:D20}-{runId}";
}

/// <summary>Queue message payload for the manufacturing-agent-queue.</summary>
public record ManufacturingAgentQueueMessage(
    int SalesOrderId,
    int CustomerId,
    string RunId,
    int RetryCount = 0);

/// <summary>Step update payload posted by the hosted agent to the step-callback endpoint.</summary>
public record ManufacturingAgentStepUpdate(
    string Key,
    string Label,
    string Status); // "started" | "completed"
