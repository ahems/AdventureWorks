using System.Data.Common;
using Dapper;
using Microsoft.Data.SqlClient;

namespace api_functions.Services;

public enum OrderCancelResult { Cancelled, NotFound, NotCancellable }

public interface IOrderCancellationService
{
    Task<(OrderCancelResult Result, byte? Status)> CancelAsync(int salesOrderId);
}

/// <summary>
/// Admin order cancellation. Only orders that have not left the warehouse
/// (In process 1, Approved 2, Backordered 3) can be cancelled; Rejected (4), Shipped (5),
/// Cancelled (6) and Delivered (7) are rejected. The check and update are one atomic statement.
/// </summary>
public class OrderCancellationService(string connectionString) : IOrderCancellationService
{
    public static readonly IReadOnlySet<byte> CancellableStatuses = new HashSet<byte> { 1, 2, 3 };

    protected virtual DbConnection CreateConnection() => new SqlConnection(connectionString);

    public async Task<(OrderCancelResult Result, byte? Status)> CancelAsync(int salesOrderId)
    {
        await using var connection = CreateConnection();
        await connection.OpenAsync();
        var row = await connection.QuerySingleOrDefaultAsync<CancelRow>("""
            DECLARE @Cancelled TABLE (SalesOrderID int);
            UPDATE Sales.SalesOrderHeader
            SET    Status = 6,
                   ModifiedDate = GETDATE()
            OUTPUT INSERTED.SalesOrderID INTO @Cancelled
            WHERE  SalesOrderID = @SalesOrderId
              AND  Status IN (1, 2, 3);
            SELECT CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM @Cancelled) THEN 1 ELSE 0 END) AS Cancelled,
                   (SELECT Status FROM Sales.SalesOrderHeader WHERE SalesOrderID = @SalesOrderId) AS Status;
            """, new { SalesOrderId = salesOrderId });
        return Classify(row?.Cancelled ?? false, row?.Status);
    }

    public static (OrderCancelResult Result, byte? Status) Classify(bool cancelled, byte? currentStatus) =>
        cancelled ? (OrderCancelResult.Cancelled, (byte)6)
        : currentStatus is null ? (OrderCancelResult.NotFound, null)
        : (OrderCancelResult.NotCancellable, currentStatus);

    private sealed class CancelRow
    {
        public bool Cancelled { get; set; }
        public byte? Status { get; set; }
    }
}
