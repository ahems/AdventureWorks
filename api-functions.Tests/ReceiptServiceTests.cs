using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using api_functions.Models;
using api_functions.Services;
using Microsoft.Data.SqlClient;
using Xunit;

namespace ApiFunctions.Tests;

public class ReceiptServiceTests
{
    [Theory]
    [InlineData(true, false)]
    [InlineData(true, true)]
    [InlineData(false, false)]
    public async Task Store_and_consumer_receipts_preserve_persisted_identity_addresses_and_totals(
        bool store, bool hasEmail)
    {
        var connection = new ReceiptConnection(store, hasEmail);
        var receipt = await new TestReceiptService(connection).GetReceiptDataBySalesOrderIDAsync(75126);

        Assert.NotNull(receipt);
        Assert.Equal(75126, receipt.SalesOrderID);
        Assert.Equal("SO75126", receipt.SalesOrderNumber);
        Assert.Equal(29800, receipt.CustomerID);
        Assert.Equal(store ? "The Bike Shop" : "Test Customer", receipt.CustomerName);
        Assert.Equal(hasEmail ? "contact@example.test" : "", receipt.CustomerEmail);
        Assert.Equal("1 Commerce Way", receipt.ShipToAddressLine1);
        Assert.Equal("2 Commerce Way", receipt.BillToAddressLine1);
        Assert.Equal("Delivered", receipt.StatusText);
        Assert.Equal(180m, receipt.SubTotal);
        Assert.Equal(15.75m, receipt.TaxAmt);
        Assert.Equal(15m, receipt.Freight);
        Assert.Equal(210.75m, receipt.TotalDue);
        Assert.Equal(receipt.SubTotal + receipt.TaxAmt + receipt.Freight, receipt.TotalDue);
        Assert.Equal(20m, receipt.DiscountAmt);
        var item = Assert.Single(receipt.LineItems);
        Assert.Equal(180m, item.LineTotal);
        Assert.Equal(receipt.SubTotal, item.LineTotal);
        Assert.Equal("Reseller promotion", Assert.Single(receipt.SpecialOffers));

        var header = Assert.Single(connection.Commands, c => c.Sql.Contains("soh.TotalDue"));
        Assert.Contains("LEFT JOIN Sales.Store store ON cust.StoreID = store.BusinessEntityID", header.Sql);
        Assert.Contains("LEFT JOIN Person.Person p ON cust.PersonID = p.BusinessEntityID", header.Sql);
        Assert.DoesNotContain("INNER JOIN Person.Person", header.Sql);
        Assert.Contains("COALESCE(store.Name, p.FirstName + ' ' + p.LastName)", header.Sql);
        Assert.Contains("OUTER APPLY", header.Sql);
        Assert.Contains("SELECT TOP 1 email.EmailAddress", header.Sql);
        Assert.Contains("ORDER BY email.EmailAddressID", header.Sql);
        Assert.Equal("SO75126", header.Parameters["SalesOrderNumber"]);
        Assert.Equal(75126, connection.Commands[0].Parameters["SalesOrderID"]);
    }

    [Fact]
    public async Task Order_number_lookup_supports_store_without_person_or_email()
    {
        var connection = new ReceiptConnection(store: true, hasEmail: false);
        var receipt = await new TestReceiptService(connection)
            .GetReceiptDataBySalesOrderNumberAsync("SO75126");

        Assert.NotNull(receipt);
        Assert.Equal("The Bike Shop", receipt.CustomerName);
        Assert.Empty(receipt.CustomerEmail);
        Assert.Equal(3, connection.Commands.Count);
    }

    [Fact]
    public async Task Missing_order_does_not_fabricate_receipt_data()
    {
        var connection = new ReceiptConnection(store: true, hasEmail: false, exists: false);
        Assert.Null(await new TestReceiptService(connection).GetReceiptDataBySalesOrderNumberAsync("SO99999"));
        Assert.Single(connection.Commands);
    }

    [Fact]
    public void Simulator_requires_persisted_receipt_totals_and_preserves_reseller_discount_units()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "azure.yaml")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var services = Path.Combine(directory.FullName, "api-functions", "Services");
        var agent = File.ReadAllText(Path.Combine(services, "OrderGenerationAgentService.cs"));
        Assert.Contains("result.TotalDue = receiptData.TotalDue;", agent);
        Assert.Contains("result.CustomerId = receiptData.CustomerID;", agent);
        Assert.Contains("throw new InvalidOperationException($\"Receipt data not found for created order", agent);
        Assert.DoesNotContain("validItems.Sum(", agent);
        var orders = File.ReadAllText(Path.Combine(services, "OrderGenerationService.cs"));
        Assert.Contains("so.DiscountPct AS Pct", orders);
        Assert.DoesNotContain("so.DiscountPct / 100", orders);
    }

    private sealed class TestReceiptService(ReceiptConnection connection) : ReceiptService("unused")
    {
        protected override Task<IDbConnection> GetConnectionAsync() => Task.FromResult<IDbConnection>(connection);
    }

    private sealed class ReceiptConnection(bool store, bool hasEmail, bool exists = true) : DbConnection
    {
        public List<(string Sql, Dictionary<string, object?> Parameters)> Commands { get; } = [];
        [AllowNull]
        public override string ConnectionString { get; set; } = "";
        public override string Database => "test";
        public override string DataSource => "test";
        public override string ServerVersion => "test";
        public override ConnectionState State => ConnectionState.Open;
        public override void Open() { }
        public override void Close() { }
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel) => throw new NotSupportedException();
        protected override DbCommand CreateDbCommand() => new ReceiptCommand(this);

        public DbDataReader Read(string sql, Dictionary<string, object?> parameters)
        {
            Commands.Add((sql, parameters));
            var table = new DataTable();
            if (sql.Contains("SELECT SalesOrderNumber"))
            {
                table.Columns.Add("SalesOrderNumber", typeof(string));
                if (exists) table.Rows.Add("SO75126");
            }
            else if (sql.Contains("soh.TotalDue"))
            {
                foreach (var property in typeof(ReceiptData).GetProperties()
                    .Where(p => p.Name != "LineItems" && p.Name != "SpecialOffers"))
                    table.Columns.Add(property.Name, Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType);
                var row = table.NewRow();
                row["SalesOrderID"] = 75126;
                row["SalesOrderNumber"] = "SO75126";
                row["CustomerID"] = 29800;
                row["CustomerName"] = store ? "The Bike Shop" : "Test Customer";
                row["CustomerEmail"] = hasEmail ? "contact@example.test" : DBNull.Value;
                row["OrderDate"] = new DateTime(2026, 11, 6);
                row["Status"] = "7";
                row["StatusText"] = "Delivered";
                row["ShipToAddressLine1"] = "1 Commerce Way";
                row["BillToAddressLine1"] = "2 Commerce Way";
                row["SubTotal"] = 180m;
                row["TaxAmt"] = 15.75m;
                row["Freight"] = 15m;
                row["TotalDue"] = 210.75m;
                if (exists) table.Rows.Add(row);
            }
            else if (sql.Contains("sod.LineTotal"))
            {
                foreach (var property in typeof(ReceiptLineItem).GetProperties())
                    table.Columns.Add(property.Name, property.PropertyType);
                table.Rows.Add(1, "Test Product", "TP-001", 2, 100m, 0.10m, 180m);
            }
            else
            {
                table.Columns.Add("Description", typeof(string));
                table.Rows.Add("Reseller promotion");
            }
            return table.CreateDataReader();
        }
    }

    private sealed class ReceiptCommand(ReceiptConnection connection) : DbCommand
    {
        private readonly SqlCommand _parameters = new();
        [AllowNull]
        public override string CommandText { get; set; } = "";
        public override int CommandTimeout { get; set; }
        public override CommandType CommandType { get; set; }
        public override bool DesignTimeVisible { get; set; }
        public override UpdateRowSource UpdatedRowSource { get; set; }
        protected override DbConnection? DbConnection { get; set; } = connection;
        protected override DbTransaction? DbTransaction { get; set; }
        protected override DbParameterCollection DbParameterCollection => _parameters.Parameters;
        protected override DbParameter CreateDbParameter() => new SqlParameter();
        public override void Cancel() { }
        public override void Prepare() { }
        public override int ExecuteNonQuery() => throw new NotSupportedException();
        public override object ExecuteScalar() => throw new NotSupportedException();
        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior) =>
            connection.Read(CommandText, Parameters.Cast<DbParameter>()
                .ToDictionary(p => p.ParameterName.TrimStart('@'), p => p.Value));
    }
}
