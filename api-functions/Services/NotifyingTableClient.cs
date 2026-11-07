using Azure;
using Azure.Core;
using Azure.Data.Tables;

namespace api_functions.Services;

/// <summary>Invalidates clients only after a successful persistent state change.</summary>
public sealed class NotifyingTableClient(
    Uri endpoint, string tableName, TokenCredential credential,
    WebPubSubService publisher, string group, TableClientOptions? options = null) : TableClient(endpoint, tableName, credential, options)
{
    // Coalesced: bulk operations write thousands of rows; clients only need one invalidation per burst.
    private Task NotifyAsync(string changeType) =>
        publisher.SendCoalescedAsync(group, Name, new { @event = "state-changed", entity = Name, changeType });

    public override async Task<Response> UpsertEntityAsync<T>(
        T entity, TableUpdateMode mode = TableUpdateMode.Merge, CancellationToken cancellationToken = default)
    {
        var response = await base.UpsertEntityAsync(entity, mode, cancellationToken);
        await NotifyAsync("upsert");
        return response;
    }

    public override async Task<Response> UpdateEntityAsync<T>(
        T entity, ETag ifMatch, TableUpdateMode mode = TableUpdateMode.Merge, CancellationToken cancellationToken = default)
    {
        var response = await base.UpdateEntityAsync(entity, ifMatch, mode, cancellationToken);
        await NotifyAsync("update");
        return response;
    }

    public override async Task<Response> AddEntityAsync<T>(T entity, CancellationToken cancellationToken = default)
    {
        var response = await base.AddEntityAsync(entity, cancellationToken);
        await NotifyAsync("add");
        return response;
    }

    public override async Task<Response> DeleteEntityAsync(
        string partitionKey, string rowKey, ETag ifMatch = default, CancellationToken cancellationToken = default)
    {
        var response = await base.DeleteEntityAsync(partitionKey, rowKey, ifMatch, cancellationToken);
        await NotifyAsync("delete");
        return response;
    }

    public override async Task<Response<IReadOnlyList<Response>>> SubmitTransactionAsync(
        IEnumerable<TableTransactionAction> transactionActions, CancellationToken cancellationToken = default)
    {
        var response = await base.SubmitTransactionAsync(transactionActions, cancellationToken);
        await NotifyAsync("transaction");
        return response;
    }
}
