using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using api_functions.Services;
using Microsoft.Data.SqlClient;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class OrderDetailServiceTests
{
    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Read_filters_the_join_by_signed_owner_and_maps_only_requested_lines(int owner)
    {
        var connection = new Connection(
            [123, 1, 5, (short)2, 10.25m, 0.1m, 18.45m, "Fixture product"],
            [124, null, null, null, null, null, null, null]);
        var result = await new Service(connection).ReadAsync([123, 124], owner);

        Assert.NotNull(result);
        Assert.Equal(new OrderDetailRead(123, 5, 2, 10.25m, 0.1m, 18.45m, "Fixture product"),
            Assert.Single(result));
        Assert.Contains("LEFT JOIN Sales.SalesOrderDetail AS sod ON sod.SalesOrderID = soh.SalesOrderID",
            connection.Sql);
        Assert.Contains("soh.SalesOrderID IN", connection.Sql);
        Assert.Contains("(@OwnerCustomerId IS NULL OR soh.CustomerID = @OwnerCustomerId)", connection.Sql);
        Assert.Equal(owner, connection.Parameters["OwnerCustomerId"]);
        Assert.Equal(123, connection.Parameters["SalesOrderIds1"]);
        Assert.Equal(124, connection.Parameters["SalesOrderIds2"]);
    }

    [Fact]
    public async Task Mixed_or_missing_order_batch_never_returns_partial_details()
    {
        var connection = new Connection([123, 1, 5, (short)2, 10m, 0m, 20m, "Fixture product"]);

        Assert.Null(await new Service(connection).ReadAsync([123, 456], 7));
        Assert.Equal(7, connection.Parameters["OwnerCustomerId"]);
    }

    [Fact]
    public async Task Owned_order_without_lines_is_empty_but_missing_order_is_denied()
    {
        var owned = new Connection([123, null, null, null, null, null, null, null]);
        Assert.Empty((await new Service(owned).ReadAsync([123], 7))!);

        var missing = new Connection();
        Assert.Null(await new Service(missing).ReadAsync([123], 7));
    }

    [Fact]
    public async Task Internal_read_uses_null_owner_without_dropping_the_sql_filter()
    {
        var connection = new Connection([123, 1, 5, (short)1, 10m, 0m, 10m, "Fixture product"]);
        Assert.Single((await new Service(connection).ReadAsync([123], null))!);
        Assert.Equal(DBNull.Value, connection.Parameters["OwnerCustomerId"]);
        Assert.Contains("(@OwnerCustomerId IS NULL OR soh.CustomerID = @OwnerCustomerId)", connection.Sql);
    }

    [Fact]
    public async Task Missing_product_data_fails_instead_of_fabricating_a_line()
    {
        var connection = new Connection([123, 1, 5, (short)1, 10m, 0m, 10m, null]);
        await Assert.ThrowsAsync<InvalidOperationException>(() => new Service(connection).ReadAsync([123], 7));
    }

    private sealed class Service(Connection connection) : OrderDetailService("unused")
    {
        protected override DbConnection CreateConnection() => connection;
    }

    private sealed class Connection(params object?[][] rows) : DbConnection
    {
        public string Sql { get; set; } = "";
        public Dictionary<string, object?> Parameters { get; } = [];
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
        protected override DbCommand CreateDbCommand() => new Command(this, rows);
    }

    private sealed class Command(Connection connection, object?[][] rows) : DbCommand
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

        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
        {
            connection.Sql = CommandText;
            foreach (DbParameter parameter in Parameters)
                connection.Parameters[parameter.ParameterName.TrimStart('@')] = parameter.Value;

            var table = new DataTable();
            table.Columns.Add("SalesOrderId", typeof(int));
            table.Columns.Add("SalesOrderDetailId", typeof(int));
            table.Columns.Add("ProductId", typeof(int));
            table.Columns.Add("OrderQty", typeof(short));
            table.Columns.Add("UnitPrice", typeof(decimal));
            table.Columns.Add("UnitPriceDiscount", typeof(decimal));
            table.Columns.Add("LineTotal", typeof(decimal));
            table.Columns.Add("ProductName", typeof(string));
            foreach (var row in rows)
                table.Rows.Add(row.Select(value => value ?? DBNull.Value).ToArray());
            return table.CreateDataReader();
        }
    }
}
