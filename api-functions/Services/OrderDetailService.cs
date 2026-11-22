using System.Data.Common;
using Dapper;
using Microsoft.Data.SqlClient;

namespace api_functions.Services;

public sealed record OrderDetailRead(
    int SalesOrderId,
    int ProductId,
    short OrderQty,
    decimal UnitPrice,
    decimal UnitPriceDiscount,
    decimal LineTotal,
    string ProductName);

public interface IOrderDetailService
{
    Task<IReadOnlyList<OrderDetailRead>?> ReadAsync(IReadOnlyCollection<int> salesOrderIds, int? ownerCustomerId);
}

public class OrderDetailService : IOrderDetailService
{
    public const int MaximumOrderIds = 100;
    private readonly string _connectionString;

    public OrderDetailService(string connectionString)
    {
        _connectionString = connectionString;
    }

    protected virtual DbConnection CreateConnection() => new SqlConnection(_connectionString);

    public async Task<IReadOnlyList<OrderDetailRead>?> ReadAsync(
        IReadOnlyCollection<int> salesOrderIds,
        int? ownerCustomerId)
    {
        ArgumentNullException.ThrowIfNull(salesOrderIds);
        if (salesOrderIds.Count is 0 or > MaximumOrderIds ||
            salesOrderIds.Any(id => id <= 0) || salesOrderIds.Distinct().Count() != salesOrderIds.Count)
        {
            throw new ArgumentException("Order IDs must be distinct positive integers within the batch limit.",
                nameof(salesOrderIds));
        }

        await using var connection = CreateConnection();
        await connection.OpenAsync();
        var rows = (await connection.QueryAsync<OrderDetailRow>("""
            SELECT soh.SalesOrderID AS SalesOrderId, sod.SalesOrderDetailID AS SalesOrderDetailId,
                   sod.ProductID AS ProductId, sod.OrderQty, sod.UnitPrice, sod.UnitPriceDiscount,
                   sod.LineTotal, p.Name AS ProductName
            FROM Sales.SalesOrderHeader AS soh
            LEFT JOIN Sales.SalesOrderDetail AS sod ON sod.SalesOrderID = soh.SalesOrderID
            LEFT JOIN Production.Product AS p ON p.ProductID = sod.ProductID
            WHERE soh.SalesOrderID IN @SalesOrderIds
              AND (@OwnerCustomerId IS NULL OR soh.CustomerID = @OwnerCustomerId)
            ORDER BY soh.SalesOrderID, sod.SalesOrderDetailID
            """, new { SalesOrderIds = salesOrderIds, OwnerCustomerId = ownerCustomerId })).AsList();

        if (!rows.Select(row => row.SalesOrderId).ToHashSet().SetEquals(salesOrderIds))
            return null;

        var details = new List<OrderDetailRead>();
        foreach (var row in rows)
        {
            if (row.SalesOrderDetailId is null)
                continue;
            if (row.ProductId is not int productId || row.OrderQty is not short quantity ||
                row.UnitPrice is not decimal unitPrice || row.UnitPriceDiscount is not decimal discount ||
                row.LineTotal is not decimal lineTotal || row.ProductName is not string productName)
            {
                throw new InvalidOperationException("An order detail is missing required product or price data.");
            }
            details.Add(new(row.SalesOrderId, productId, quantity, unitPrice, discount, lineTotal, productName));
        }
        return details;
    }

    private sealed class OrderDetailRow
    {
        public int SalesOrderId { get; set; }
        public int? SalesOrderDetailId { get; set; }
        public int? ProductId { get; set; }
        public short? OrderQty { get; set; }
        public decimal? UnitPrice { get; set; }
        public decimal? UnitPriceDiscount { get; set; }
        public decimal? LineTotal { get; set; }
        public string? ProductName { get; set; }
    }
}
