using System.Data;
using System.Data.Common;
using Dapper;
using Microsoft.Data.SqlClient;

namespace api_functions.Services;

public sealed record CreateOrderHeaderRequest(
    int BillToAddressId,
    int ShipToAddressId,
    int ShipMethodId,
    decimal SubTotal,
    decimal TaxAmt,
    decimal Freight,
    int? CustomerId = null,
    int? BusinessEntityId = null);

public interface IOrderHeaderService
{
    Task<int?> CreateAsync(int customerId, int businessEntityId, CreateOrderHeaderRequest request);
}

public class OrderHeaderService(string connectionString) : IOrderHeaderService
{
    protected virtual DbConnection CreateConnection() => new SqlConnection(connectionString);

    public async Task<int?> CreateAsync(int customerId, int businessEntityId, CreateOrderHeaderRequest request)
    {
        await using var connection = CreateConnection();
        await connection.OpenAsync();
        using var transaction = connection.BeginTransaction(IsolationLevel.Serializable);

        var allowed = await connection.ExecuteScalarAsync<bool>(@"
            SELECT CONVERT(bit, CASE WHEN
                EXISTS (
                    SELECT 1 FROM [Sales].[Customer] c WITH (UPDLOCK, HOLDLOCK)
                    WHERE c.CustomerID = @CustomerId AND c.PersonID = @BusinessEntityId
                )
                AND EXISTS (
                    SELECT 1 FROM [Person].[Address] a WITH (UPDLOCK, HOLDLOCK)
                    INNER JOIN [Person].[BusinessEntityAddress] bea WITH (UPDLOCK, HOLDLOCK)
                        ON bea.AddressID = a.AddressID
                    WHERE a.AddressID = @BillToAddressId AND bea.BusinessEntityID = @BusinessEntityId
                )
                AND EXISTS (
                    SELECT 1 FROM [Person].[Address] a WITH (UPDLOCK, HOLDLOCK)
                    INNER JOIN [Person].[BusinessEntityAddress] bea WITH (UPDLOCK, HOLDLOCK)
                        ON bea.AddressID = a.AddressID
                    WHERE a.AddressID = @ShipToAddressId AND bea.BusinessEntityID = @BusinessEntityId
                )
                AND EXISTS (
                    SELECT 1 FROM [Purchasing].[ShipMethod] WITH (HOLDLOCK)
                    WHERE ShipMethodID = @ShipMethodId
                )
            THEN 1 ELSE 0 END)",
            new
            {
                CustomerId = customerId,
                BusinessEntityId = businessEntityId,
                request.BillToAddressId,
                request.ShipToAddressId,
                request.ShipMethodId
            }, transaction);
        if (!allowed)
        {
            transaction.Rollback();
            return null;
        }

        var orderId = await connection.ExecuteScalarAsync<int>(@"
            INSERT INTO [Sales].[SalesOrderHeader]
                (RevisionNumber, OrderDate, DueDate, Status, OnlineOrderFlag, CustomerID,
                 BillToAddressID, ShipToAddressID, ShipMethodID, SubTotal, TaxAmt, Freight)
            OUTPUT INSERTED.SalesOrderID
            VALUES
                (1, GETUTCDATE(), DATEADD(day, 7, GETUTCDATE()), 1, 1, @CustomerId,
                 @BillToAddressId, @ShipToAddressId, @ShipMethodId, @SubTotal, @TaxAmt, @Freight)",
            new
            {
                CustomerId = customerId,
                request.BillToAddressId,
                request.ShipToAddressId,
                request.ShipMethodId,
                request.SubTotal,
                request.TaxAmt,
                request.Freight
            }, transaction);
        transaction.Commit();
        return orderId;
    }
}
