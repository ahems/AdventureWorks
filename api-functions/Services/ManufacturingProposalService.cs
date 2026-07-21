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

    public ManufacturingProposalService(ILogger<ManufacturingProposalService> logger)
    {
        _logger = logger;
    }

    private static async Task<TableClient> GetTableClientAsync()
    {
        var tableServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__tableServiceUri");
        if (string.IsNullOrEmpty(tableServiceUri))
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName is not configured.");
            tableServiceUri = $"https://{accountName}.table.core.windows.net";
        }

        var serviceClient = new TableServiceClient(new Uri(tableServiceUri), new DefaultAzureCredential());
        await serviceClient.CreateTableIfNotExistsAsync(TableName);
        return serviceClient.GetTableClient(TableName);
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

    /// <summary>
    /// Returns pending proposals, newest first, capped at <paramref name="limit"/>.
    /// Proposals older than <paramref name="ttlMinutes"/> are auto-rejected.
    /// Proposals beyond the cap are also auto-rejected so the UI stays manageable.
    /// </summary>
    public async Task<List<ManufacturingProposalEntity>> ListPendingWithLimitAsync(
        int limit = 10,
        int ttlMinutes = 5)
    {
        var table   = await GetTableClientAsync();
        var all     = new List<ManufacturingProposalEntity>();

        await foreach (var entity in table.QueryAsync<ManufacturingProposalEntity>(
            e => e.PartitionKey == PartitionKey && e.Status == "pending"))
        {
            all.Add(entity);
        }

        // Sort newest first (RowKey is inverted-tick so sort ascending by RowKey = newest first)
        all.Sort((a, b) => string.Compare(a.RowKey, b.RowKey, StringComparison.Ordinal));

        var cutoff  = DateTimeOffset.UtcNow.AddMinutes(-ttlMinutes);
        var expired = all.Where(p => p.CreatedAt < cutoff).ToList();
        var active  = all.Where(p => p.CreatedAt >= cutoff).ToList();

        // Auto-reject those beyond the display limit
        var overflow = active.Skip(limit).ToList();
        var visible  = active.Take(limit).ToList();

        // Batch-reject expired + overflow
        var toAutoReject = expired.Concat(overflow).ToList();
        if (toAutoReject.Count > 0)
        {
            _logger.LogInformation(
                "[Proposal] Auto-rejecting {Count} proposal(s): {Expired} expired, {Overflow} overflow",
                toAutoReject.Count, expired.Count, overflow.Count);
            foreach (var p in toAutoReject)
            {
                p.Status    = "rejected";
                p.ActionedAt = DateTimeOffset.UtcNow;
                await table.UpdateEntityAsync(p, p.ETag, TableUpdateMode.Replace);
            }
        }

        return visible;
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
