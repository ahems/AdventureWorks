using System.Data;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Data.SqlClient;

namespace AdventureWorks.Services;

public record McpDependencyCheck(string Id, string Status, string Message, bool Required = true);
public record McpReadinessReport(DateTimeOffset CheckedAt, IReadOnlyList<McpDependencyCheck> Checks)
{
    public string Status => Checks.All(c => !c.Required || c.Status == "healthy") ? "healthy" : "unhealthy";
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
            }, ct), CheckAsync("sql-identity", async token =>
            {
                var connectionString = configuration.GetConnectionString("AdventureWorks");
                var configuredClientId = configuration["AZURE_CLIENT_ID"];
                if (string.IsNullOrWhiteSpace(connectionString) || string.IsNullOrWhiteSpace(configuredClientId))
                    return new McpDependencyCheck("sql-identity", "not-configured",
                        "SQL managed identity verification is not configured.");
                if (!Guid.TryParse(configuredClientId, out var clientId) || clientId == Guid.Empty)
                    return new McpDependencyCheck("sql-identity", "unhealthy",
                        "SQL managed identity configuration is invalid.");

                await using var connection = new SqlConnection(connectionString);
                await connection.OpenAsync(token);
                await using var command = connection.CreateCommand();
                command.CommandText = """
                    SELECT CONVERT(int, CASE WHEN type = 'E' AND sid = CONVERT(binary(16), @ClientId)
                        THEN 1 ELSE 0 END)
                    FROM sys.database_principals WHERE principal_id = USER_ID();
                    """;
                command.Parameters.Add("@ClientId", SqlDbType.UniqueIdentifier).Value = clientId;
                command.CommandTimeout = 10;
                return EvaluateSqlIdentity(await command.ExecuteScalarAsync(token));
            }, ct, required: false), CheckAsync("tasks", async token =>
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

    public static McpDependencyCheck EvaluateSqlIdentity(object? value) => value switch
    {
        1 => new("sql-identity", "healthy", "SQL principal matches the configured managed identity.", false),
        0 => new("sql-identity", "unhealthy", "SQL principal does not match the configured managed identity.", false),
        null or DBNull => new("sql-identity", "unknown", "SQL principal identity could not be verified.", false),
        _ => throw new InvalidOperationException("SQL identity probe returned an unexpected result.")
    };

    private async Task<McpDependencyCheck> CheckAsync(string id,
        Func<CancellationToken, Task<McpDependencyCheck>> check, CancellationToken ct, bool required = true)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(12));
        try
        {
            var result = await check(deadline.Token).WaitAsync(deadline.Token);
            if (result.Status is "unhealthy" or "unknown")
                logger.LogWarning("MCP readiness {CheckId}: {Status}", id, result.Status);
            return result with { Required = required };
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning("MCP readiness {CheckId} timed out", id);
            return new(id, "timeout", "Dependency check timed out. See Application Insights.", required);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "MCP readiness {CheckId} failed", id);
            return new(id, "unhealthy", "Dependency unavailable or access denied. See Application Insights.", required);
        }
    }
}
