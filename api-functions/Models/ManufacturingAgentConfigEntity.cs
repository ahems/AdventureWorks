using Azure;
using Azure.Data.Tables;

namespace api_functions.Models;

/// <summary>Agent autonomy mode. Stored as int in Table Storage.</summary>
public enum ManufacturingAgentMode
{
    /// <summary>
    /// Agent is disabled. No queue messages are created and no tokens are consumed.
    /// This is the default until the user explicitly enables the agent.
    /// </summary>
    Off = 0,

    /// <summary>Agent analyses inventory and logs findings — no actions taken.</summary>
    ReadOnly = 1,

    /// <summary>Agent proposes actions which must be manually approved in the UI before execution.</summary>
    ProposePending = 2,

    /// <summary>Agent places supply orders and starts manufacturing runs autonomously.</summary>
    FullyAutonomous = 3
}

/// <summary>
/// Persists the manufacturing agent autonomy mode as a single row in Azure Table Storage.
/// PartitionKey = "config", RowKey = "manufacturing-agent".
/// </summary>
internal class ManufacturingAgentConfigEntity : ITableEntity
{
    public string PartitionKey { get; set; } = "config";
    public string RowKey       { get; set; } = "manufacturing-agent";
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; } = ETag.All;

    /// <summary>Stored as int; cast to/from <see cref="ManufacturingAgentMode"/>.</summary>
    public int Mode { get; set; } = (int)ManufacturingAgentMode.Off;

    /// <summary>
    /// When set, the mode is automatically switched to Off at this UTC time.
    /// Null means no auto-shutoff.
    /// </summary>
    public DateTimeOffset? AutoShutoffAt { get; set; }
}
