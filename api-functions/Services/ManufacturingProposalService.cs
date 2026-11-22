using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Logging;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// CRUD for manufacturing agent action proposals in Azure Table Storage.
/// Proposals are created by the hosted agent (via MCP tools) in ProposePending mode
/// and executed by the proposal Functions endpoints after human approval.
/// </summary>
public class ManufacturingProposalService
{
    private const string TableName    = "awManufacturingProposals";
    private const string PartitionKey = "proposals";

    private readonly ILogger<ManufacturingProposalService> _logger;
    private readonly WebPubSubService _publisher;

    public ManufacturingProposalService(ILogger<ManufacturingProposalService> logger, WebPubSubService publisher)
    {
        _logger = logger;
        _publisher = publisher;
    }

    private async Task<TableClient> GetTableClientAsync()
    {
        var tableServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__tableServiceUri");
        if (string.IsNullOrEmpty(tableServiceUri))
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName is not configured.");
            tableServiceUri = $"https://{accountName}.table.core.windows.net";
        }

        return new NotifyingTableClient(new Uri(tableServiceUri), TableName, new DefaultAzureCredential(), _publisher, "manufacturing-agent");
    }

    /// <summary>Creates a new pending proposal and returns its ID.</summary>
    public async Task<string> CreateProposalAsync(
        string type,
        int productId,
        int qty,
        string? vendorId,
        string rationale,
        int salesOrderId,
        string runId)
    {
        var proposalId = Guid.NewGuid().ToString();
        var entity = new ManufacturingProposalEntity
        {
            PartitionKey = PartitionKey,
            RowKey       = ManufacturingProposalEntity.NewRowKey(proposalId),
            ProposalId   = proposalId,
            Type         = type,
            ProductId    = productId,
            Qty          = qty,
            VendorId     = vendorId,
            Rationale    = rationale,
            Status       = "pending",
            SalesOrderId = salesOrderId,
            RunId        = runId,
            CreatedAt    = DateTimeOffset.UtcNow,
        };

        var table = await GetTableClientAsync();
        await table.AddEntityAsync(entity);
        _logger.LogInformation("[Proposal] Created {Type} proposal {ProposalId} for product {ProductId}",
            type, proposalId, productId);
        return proposalId;
    }

    /// <summary>Returns all pending proposals, newest first.</summary>
    public async Task<List<ManufacturingProposalEntity>> ListPendingAsync()
    {
        var table   = await GetTableClientAsync();
        var results = new List<ManufacturingProposalEntity>();

        await foreach (var entity in table.QueryAsync<ManufacturingProposalEntity>(
            e => e.PartitionKey == PartitionKey && e.Status == "pending"))
        {
            results.Add(entity);
        }

        return results;
    }

    /// <summary>Default display cap and TTL shared by the read route and the maintenance timer.</summary>
    public const int DefaultDisplayLimit = 10;
    public const int DefaultTtlMinutes   = 5;

    /// <summary>
    /// Splits pending proposals into the visible set (newest first, within the TTL, capped at
    /// <paramref name="limit"/>) and the set that is expired or beyond the cap.
    /// </summary>
    public static (List<ManufacturingProposalEntity> Visible, List<ManufacturingProposalEntity> Stale) Partition(
        IEnumerable<ManufacturingProposalEntity> pending, int limit, int ttlMinutes, DateTimeOffset now)
    {
        // RowKey is inverted-tick, so ascending RowKey order is newest first.
        var all = pending.OrderBy(p => p.RowKey, StringComparer.Ordinal).ToList();
        var cutoff  = now.AddMinutes(-ttlMinutes);
        var active  = all.Where(p => p.CreatedAt >= cutoff).ToList();
        var visible = active.Take(limit).ToList();
        var stale   = all.Where(p => p.CreatedAt < cutoff).Concat(active.Skip(limit)).ToList();
        return (visible, stale);
    }

    /// <summary>Returns the visible pending proposals without changing any state.</summary>
    public async Task<List<ManufacturingProposalEntity>> ListVisiblePendingAsync(
        int limit = DefaultDisplayLimit,
        int ttlMinutes = DefaultTtlMinutes) =>
        Partition(await ListPendingAsync(), limit, ttlMinutes, DateTimeOffset.UtcNow).Visible;

    /// <summary>
    /// Returns pending proposals, newest first, capped at <paramref name="limit"/>, and rejects
    /// proposals that are older than <paramref name="ttlMinutes"/> or beyond the cap.
    /// Only for write paths (approve-all and the maintenance timer).
    /// </summary>
    public async Task<List<ManufacturingProposalEntity>> ListPendingWithLimitAsync(
        int limit = DefaultDisplayLimit,
        int ttlMinutes = DefaultTtlMinutes)
    {
        var (visible, stale) = Partition(await ListPendingAsync(), limit, ttlMinutes, DateTimeOffset.UtcNow);
        await RejectStaleAsync(stale);
        return visible;
    }

    /// <summary>Rejects expired and over-cap pending proposals. Returns how many were rejected.</summary>
    public async Task<int> ExpirePendingAsync(
        int limit = DefaultDisplayLimit,
        int ttlMinutes = DefaultTtlMinutes)
    {
        var (_, stale) = Partition(await ListPendingAsync(), limit, ttlMinutes, DateTimeOffset.UtcNow);
        return await RejectStaleAsync(stale);
    }

    private async Task<int> RejectStaleAsync(List<ManufacturingProposalEntity> stale)
    {
        if (stale.Count == 0) return 0;

        var table = await GetTableClientAsync();
        int rejected = 0;
        foreach (var p in stale)
        {
            p.Status     = "rejected";
            p.ActionedAt = DateTimeOffset.UtcNow;
            try
            {
                await table.UpdateEntityAsync(p, p.ETag, TableUpdateMode.Replace);
                rejected++;
            }
            catch (RequestFailedException ex) when (ex.Status is 404 or 412)
            {
                // Approved, rejected or removed concurrently.
            }
        }
        _logger.LogInformation("[Proposal] Auto-rejected {Count} expired or over-cap proposal(s).", rejected);
        return rejected;
    }

    /// <summary>Rejects all pending proposals and returns how many were rejected.</summary>
    public async Task<int> RejectAllPendingAsync()
    {
        var table = await GetTableClientAsync();
        var all   = new List<ManufacturingProposalEntity>();

        await foreach (var entity in table.QueryAsync<ManufacturingProposalEntity>(
            e => e.PartitionKey == PartitionKey && e.Status == "pending"))
        {
            all.Add(entity);
        }

        foreach (var p in all)
        {
            p.Status     = "rejected";
            p.ActionedAt = DateTimeOffset.UtcNow;
            await table.UpdateEntityAsync(p, p.ETag, TableUpdateMode.Replace);
        }

        _logger.LogInformation("[Proposal] Bulk-rejected {Count} pending proposals.", all.Count);
        return all.Count;
    }

    /// <summary>Gets a single proposal by ID, or null if not found.</summary>
    public async Task<ManufacturingProposalEntity?> GetProposalAsync(string proposalId)
    {
        var table = await GetTableClientAsync();
        try
        {
            // RowKey has a prefix — scan pending partition for matching ProposalId
            await foreach (var entity in table.QueryAsync<ManufacturingProposalEntity>(
                e => e.PartitionKey == PartitionKey && e.ProposalId == proposalId))
            {
                return entity;
            }
            return null;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    /// <summary>Marks a proposal as approved.</summary>
    public async Task ApproveAsync(string proposalId)
        => await SetStatusAsync(proposalId, "approved");

    /// <summary>Marks a proposal as rejected.</summary>
    public async Task RejectAsync(string proposalId)
        => await SetStatusAsync(proposalId, "rejected");

    /// <summary>Marks a proposal as executed after the action has been carried out.</summary>
    public async Task MarkExecutedAsync(string proposalId)
        => await SetStatusAsync(proposalId, "executed");

    private async Task SetStatusAsync(string proposalId, string status)
    {
        var entity = await GetProposalAsync(proposalId);
        if (entity == null)
        {
            _logger.LogWarning("[Proposal] Proposal {ProposalId} not found when setting status={Status}",
                proposalId, status);
            return;
        }

        entity.Status     = status;
        entity.ActionedAt = DateTimeOffset.UtcNow;

        var table = await GetTableClientAsync();
        await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);
        _logger.LogInformation("[Proposal] {ProposalId} status → {Status}", proposalId, status);
    }
}
