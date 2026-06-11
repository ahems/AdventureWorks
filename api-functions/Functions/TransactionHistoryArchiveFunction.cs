using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Azure.Functions.Worker.Extensions.Timer;
using System.Net;
using Microsoft.Data.SqlClient;

namespace api_functions.Functions;

/// <summary>
/// Archives TransactionHistory records older than one year into TransactionHistoryArchive.
///
/// Timer: runs every Sunday at 02:00 UTC (CRON: "0 0 2 * * 0").
/// HTTP:  GET /api/archive/trigger — manual override (admin use only).
/// </summary>
public class TransactionHistoryArchiveFunction
{
    private readonly ILogger<TransactionHistoryArchiveFunction> _logger;
    private readonly string _connectionString;

    public TransactionHistoryArchiveFunction(
        ILogger<TransactionHistoryArchiveFunction> logger,
        IConfiguration configuration)
    {
        _logger = logger;
        _connectionString = configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    }

    /// <summary>
    /// Weekly timer trigger: every Sunday at 02:00 UTC.
    /// </summary>
    [Function("ArchiveTransactionHistoryTimer")]
    public async Task RunTimer(
        [TimerTrigger("0 0 2 * * 0")] TimerInfo timerInfo)
    {
        _logger.LogInformation("TransactionHistory archive timer triggered at {Time}", DateTimeOffset.UtcNow);
        var archived = await ArchiveAsync();
        _logger.LogInformation("Archive complete. {Count} record(s) moved to TransactionHistoryArchive.", archived);
    }

    /// <summary>
    /// HTTP trigger for manual archive invocation.
    /// GET /api/archive/trigger
    /// </summary>
    [Function("ArchiveTransactionHistoryHttp")]
    public async Task<HttpResponseData> RunHttp(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "archive/trigger")] HttpRequestData req)
    {
        _logger.LogInformation("TransactionHistory archive HTTP trigger invoked at {Time}", DateTimeOffset.UtcNow);

        var archived = await ArchiveAsync();

        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync(
            System.Text.Json.JsonSerializer.Serialize(new
            {
                success = true,
                recordsArchived = archived,
                archivedAt = DateTimeOffset.UtcNow
            }));
        return response;
    }

    private async Task<int> ArchiveAsync()
    {
        const string archiveSql = @"
BEGIN TRANSACTION;

-- Copy records older than 1 year into the archive table
INSERT INTO Production.TransactionHistoryArchive (
    TransactionID,
    ProductID,
    ReferenceOrderID,
    ReferenceOrderLineID,
    TransactionDate,
    TransactionType,
    Quantity,
    ActualCost,
    ModifiedDate
)
SELECT
    TransactionID,
    ProductID,
    ReferenceOrderID,
    ReferenceOrderLineID,
    TransactionDate,
    TransactionType,
    Quantity,
    ActualCost,
    ModifiedDate
FROM Production.TransactionHistory WITH (UPDLOCK)
WHERE TransactionDate < DATEADD(YEAR, -1, GETDATE());

DECLARE @archived INT = @@ROWCOUNT;

-- Remove the archived rows from the live table
DELETE FROM Production.TransactionHistory
WHERE TransactionDate < DATEADD(YEAR, -1, GETDATE());

COMMIT TRANSACTION;

SELECT @archived;
";

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();
        await using var cmd = new SqlCommand(archiveSql, conn)
        {
            CommandTimeout = 120
        };

        var result = await cmd.ExecuteScalarAsync();
        return result is int count ? count : Convert.ToInt32(result);
    }
}
