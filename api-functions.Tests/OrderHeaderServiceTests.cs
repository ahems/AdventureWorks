using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using api_functions.Services;
using Microsoft.Data.SqlClient;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class OrderHeaderServiceTests
{
    [Theory]
    [InlineData(7, 71, 101)]
    [InlineData(8, 72, 102)]
    public async Task Customer_and_both_addresses_are_checked_before_insert_in_one_transaction(
        int customer, int person, int address)
    {
        var connection = new Connection();
        var result = await new Service(connection).CreateAsync(customer, person,
            new CreateOrderHeaderRequest(address, address, 5, 10.25m, 1, 2));
        Assert.Equal(123, result);
        Assert.Equal(1, connection.Inserts);
        Assert.Equal(customer, connection.InsertCustomer);
        Assert.True(connection.Transaction!.Committed);
        Assert.Equal(IsolationLevel.Serializable, connection.Transaction.IsolationLevel);
    }

    [Theory]
    [InlineData("customer")]
    [InlineData("billing")]
    [InlineData("shipping")]
    [InlineData("missing-address")]
    [InlineData("ship-method")]
    public async Task Invalid_customer_address_or_ship_method_never_inserts(string defect)
    {
        var connection = new Connection();
        if (defect == "missing-address") connection.Addresses.Remove(101);
        var request = new CreateOrderHeaderRequest(
            defect == "billing" ? 102 : 101,
            defect == "shipping" ? 102 : 101,
            defect == "ship-method" ? 999 : 5, 10, 1, 2);
        var result = await new Service(connection).CreateAsync(defect == "customer" ? 8 : 7, 71, request);
        Assert.Null(result);
        Assert.Equal(0, connection.Inserts);
        Assert.True(connection.Transaction!.RolledBack);
    }

    [Fact]
    public async Task Insert_failure_rolls_back_the_guarded_transaction()
    {
        var connection = new Connection { FailInsert = true };
        await Assert.ThrowsAsync<InvalidOperationException>(() => new Service(connection).CreateAsync(
            7, 71, new CreateOrderHeaderRequest(101, 101, 5, 10, 1, 2)));
        Assert.True(connection.Transaction!.RolledBack);
        Assert.False(connection.Transaction.Committed);
    }

    private sealed class Service(Connection connection) : OrderHeaderService("unused")
    {
        protected override DbConnection CreateConnection() => connection;
    }

    private sealed class Connection : DbConnection
    {
        public Dictionary<int, int> Customers { get; } = new() { [7] = 71, [8] = 72 };
        public HashSet<int> Addresses { get; } = [101, 102];
        public HashSet<(int Address, int Person)> Links { get; } = [(101, 71), (102, 72)];
        public Transaction? Transaction { get; private set; }
        public bool FailInsert { get; init; }
        public int Inserts { get; set; }
        public int? InsertCustomer { get; set; }
        [AllowNull]
        public override string ConnectionString { get; set; } = "";
        public override string Database => "test";
        public override string DataSource => "test";
        public override string ServerVersion => "test";
        public override ConnectionState State => ConnectionState.Open;
        public override void Open() { }
        public override void Close() { }
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel) =>
            Transaction = new Transaction(this, isolationLevel);
        protected override DbCommand CreateDbCommand() => new Command(this);
    }

    private sealed class Transaction(Connection connection, IsolationLevel isolationLevel) : DbTransaction
    {
        public bool Committed { get; private set; }
        public bool RolledBack { get; private set; }
        public override IsolationLevel IsolationLevel => isolationLevel;
        protected override DbConnection DbConnection => connection;
        public override void Commit() => Committed = true;
        public override void Rollback() => RolledBack = true;
        protected override void Dispose(bool disposing)
        {
            if (disposing && !Committed && !RolledBack) Rollback();
            base.Dispose(disposing);
        }
    }

    private sealed class Command(Connection connection) : DbCommand
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
        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior) => throw new NotSupportedException();
        private int Parameter(string name) =>
            Convert.ToInt32(Parameters.Cast<DbParameter>().Single(p => p.ParameterName.TrimStart('@') == name).Value);

        public override object ExecuteScalar()
        {
            Assert.Same(connection.Transaction, DbTransaction);
            if (CommandText.Contains("INSERT INTO [Sales].[SalesOrderHeader]"))
            {
                if (connection.FailInsert) throw new InvalidOperationException("Simulated database failure");
                connection.Inserts++;
                connection.InsertCustomer = Parameter("CustomerId");
                Assert.Contains("OUTPUT INSERTED.SalesOrderID", CommandText);
                return 123;
            }

            Assert.Contains("c.CustomerID = @CustomerId AND c.PersonID = @BusinessEntityId", CommandText);
            Assert.Contains("a.AddressID = @BillToAddressId AND bea.BusinessEntityID = @BusinessEntityId", CommandText);
            Assert.Contains("a.AddressID = @ShipToAddressId AND bea.BusinessEntityID = @BusinessEntityId", CommandText);
            Assert.Contains("ShipMethodID = @ShipMethodId", CommandText);
            Assert.Equal(5, CommandText.Split("WITH (UPDLOCK, HOLDLOCK)").Length - 1);
            int customer = Parameter("CustomerId");
            int person = Parameter("BusinessEntityId");
            int billing = Parameter("BillToAddressId");
            int shipping = Parameter("ShipToAddressId");
            return connection.Customers.TryGetValue(customer, out var actualPerson) && actualPerson == person &&
                   connection.Addresses.Contains(billing) && connection.Links.Contains((billing, person)) &&
                   connection.Addresses.Contains(shipping) && connection.Links.Contains((shipping, person)) &&
                   Parameter("ShipMethodId") == 5;
        }
    }
}
