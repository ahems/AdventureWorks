using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Data.SqlClient;

namespace AdventureWorks.Services;

public record McpDependencyCheck(string Id, string Status, string Message);
public record McpReadinessReport(DateTimeOffset CheckedAt, IReadOnlyList<McpDependencyCheck> Checks)
{
    public string Status => Checks.All(c => c.Status == "healthy") ? "healthy" : "unhealthy";
}

public class McpReadinessService(IConfiguration configuration, ILogger<McpReadinessService> logger)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private McpReadinessReport? _cached;

    public async Task<McpReadinessReport> GetReportAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            if (_cached is not null && DateTimeOffset.UtcNow - _cached.CheckedAt < TimeSpan.FromSeconds(60))
                return _cached;
            var checks = await Task.WhenAll(CheckAsync("sql", async token =>
            {
                var connectionString = configuration.GetConnectionString("AdventureWorks");
                if (string.IsNullOrWhiteSpace(connectionString))
                    return new McpDependencyCheck("sql", "not-configured", "SQL is not configured.");
                await using var connection = new SqlConnection(connectionString);
                await connection.OpenAsync(token);
                await using var command = connection.CreateCommand();
                command.CommandText = "SELECT TOP (1) ProductID FROM Production.Product";
                command.CommandTimeout = 10;
                await command.ExecuteScalarAsync(token);
                return new McpDependencyCheck("sql", "healthy", "Catalog read permission verified.");
            }, ct), CheckAsync("tasks", async token =>
            {
                var account = configuration["AzureWebJobsStorage:accountName"]
                    ?? configuration["STORAGE_ACCOUNT_NAME"];
                if (string.IsNullOrWhiteSpace(account))
                    return new McpDependencyCheck("tasks", "healthy", "In-memory task store configured; tasks are not durable.");
                var uri = configuration["AzureWebJobsStorage:tableServiceUri"]
                    ?? $"https://{account}.table.core.windows.net";
                var credential = new DefaultAzureCredential(new DefaultAzureCredentialOptions
                {
                    ManagedIdentityClientId = configuration["AZURE_CLIENT_ID"]
                });
                var table = new TableClient(new Uri(uri), "awMcpTasks", credential);
                await using var pages = table.QueryAsync<TableEntity>(maxPerPage: 1,
                    select: ["PartitionKey"], cancellationToken: token).AsPages().GetAsyncEnumerator(token);
                await pages.MoveNextAsync();
                return new McpDependencyCheck("tasks", "healthy", "Durable task table is readable; no tasks created.");
            }, ct));
            _cached = new McpReadinessReport(DateTimeOffset.UtcNow, checks);
            return _cached;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<McpDependencyCheck> CheckAsync(string id,
        Func<CancellationToken, Task<McpDependencyCheck>> check, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(12));
        try
        {
            return await check(deadline.Token).WaitAsync(deadline.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning("MCP readiness {CheckId} timed out", id);
            return new(id, "timeout", "Dependency check timed out. See Application Insights.");
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "MCP readiness {CheckId} failed", id);
            return new(id, "unhealthy", "Dependency unavailable or access denied. See Application Insights.");
        }
    }
}
