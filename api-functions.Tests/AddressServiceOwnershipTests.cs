using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using AddressFunctions.Models;
using AddressFunctions.Services;
using Microsoft.Data.SqlClient;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class AddressServiceOwnershipTests
{
    [Theory]
    [InlineData(7, 101, true)]
    [InlineData(8, 102, true)]
    [InlineData(7, 102, false)]
    [InlineData(8, 101, false)]
    public async Task Single_read_filters_in_the_address_query(int owner, int address, bool allowed)
    {
        var connection = new Connection();
        var result = await new Service(connection).GetAddressByIdAsync(address, owner);
        Assert.Equal(allowed, result is not null);
        Assert.Equal(owner, connection.ReadOwner);
    }

    [Theory]
    [InlineData(7, 101)]
    [InlineData(8, 102)]
    public async Task Owned_update_checks_links_and_orders_in_one_serializable_transaction(int owner, int address)
    {
        var connection = new Connection();
        connection.OrderOwners.Add((address, owner));
        var result = await new Service(connection).UpdateOwnedAddressAsync(address, owner,
            new UpdateAddressRequest { City = "New city" });
        Assert.Equal(OwnedAddressUpdateStatus.Updated, result.Status);
        Assert.Equal("New city", result.Address!.City);
        Assert.Equal("New city", connection.Cities[address]);
        Assert.True(connection.Transaction!.Committed);
        Assert.Equal(IsolationLevel.Serializable, connection.Transaction.IsolationLevel);
        Assert.True(connection.CheckedForSharing);
    }

    [Theory]
    [InlineData(7, 102)]
    [InlineData(8, 101)]
    [InlineData(7, 999)]
    public async Task Foreign_or_missing_update_never_mutates(int owner, int address)
    {
        var connection = new Connection();
        var result = await new Service(connection).UpdateOwnedAddressAsync(address, owner,
            new UpdateAddressRequest { City = "New city" });
        Assert.Equal(OwnedAddressUpdateStatus.NotOwned, result.Status);
        Assert.False(connection.CheckedForSharing);
        Assert.Equal(0, connection.Updates);
        Assert.True(connection.Transaction!.RolledBack);
    }

    [Theory]
    [InlineData("link")]
    [InlineData("foreign-order")]
    [InlineData("unbound-order")]
    public async Task Shared_link_or_other_order_blocks_physical_update(string sharing)
    {
        var connection = new Connection();
        if (sharing == "link") connection.Links.Add((101, 8, 3));
        if (sharing == "foreign-order") connection.OrderOwners.Add((101, 8));
        if (sharing == "unbound-order") connection.OrderOwners.Add((101, null));
        var result = await new Service(connection).UpdateOwnedAddressAsync(101, 7,
            new UpdateAddressRequest { City = "New city" });
        Assert.Equal(OwnedAddressUpdateStatus.Shared, result.Status);
        Assert.Equal("Original city", connection.Cities[101]);
        Assert.Equal(0, connection.Updates);
        Assert.True(connection.Transaction!.RolledBack);
    }

    [Fact]
    public async Task Unchanged_shared_address_can_still_be_saved_without_physical_mutation()
    {
        var connection = new Connection();
        connection.Links.Add((101, 8, 3));
        var result = await new Service(connection).UpdateOwnedAddressAsync(101, 7,
            new UpdateAddressRequest { City = "Original city" });
        Assert.Equal(OwnedAddressUpdateStatus.Updated, result.Status);
        Assert.False(connection.CheckedForSharing);
        Assert.Equal(0, connection.Updates);
        Assert.True(connection.Transaction!.Committed);
    }

    [Fact]
    public async Task Removed_owner_before_update_cannot_mutate_and_rolls_back()
    {
        var connection = new Connection { RemoveOwnerBeforeUpdate = true };
        var result = await new Service(connection).UpdateOwnedAddressAsync(101, 7,
            new UpdateAddressRequest { City = "New city" });
        Assert.Equal(OwnedAddressUpdateStatus.NotOwned, result.Status);
        Assert.Equal("Original city", connection.Cities[101]);
        Assert.True(connection.Transaction!.RolledBack);
    }

    [Fact]
    public async Task Update_failure_does_not_commit()
    {
        var connection = new Connection { FailAddressUpdate = true };
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            new Service(connection).UpdateOwnedAddressAsync(101, 7, new UpdateAddressRequest { City = "New city" }));
        Assert.Equal("Original city", connection.Cities[101]);
        Assert.True(connection.Transaction!.RolledBack);
    }

    [Theory]
    [InlineData(7, 101)]
    [InlineData(8, 102)]
    public async Task Delete_removes_only_the_signed_owners_links_and_unreferenced_address(int owner, int address)
    {
        var connection = new Connection();
        Assert.True(await new Service(connection).DeleteOwnedAddressAsync(address, owner));
        Assert.DoesNotContain(connection.Links, link => link.Address == address && link.Owner == owner);
        Assert.DoesNotContain(address, connection.Addresses);
        Assert.Contains(connection.Links, link => link.Owner != owner);
        Assert.True(connection.Transaction!.Committed);
        Assert.Equal(IsolationLevel.Serializable, connection.Transaction.IsolationLevel);
    }

    [Theory]
    [InlineData(8, 101)]
    [InlineData(7, 102)]
    [InlineData(7, 999)]
    public async Task Foreign_or_missing_address_rolls_back_without_changes(int owner, int address)
    {
        var connection = new Connection();
        var before = connection.Links.ToHashSet();
        Assert.False(await new Service(connection).DeleteOwnedAddressAsync(address, owner));
        Assert.True(before.SetEquals(connection.Links));
        Assert.Equal(new[] { 101, 102 }, connection.Addresses.Order().ToArray());
        Assert.True(connection.Transaction!.RolledBack);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Shared_or_order_referenced_address_is_retained(bool shared)
    {
        var connection = new Connection();
        if (shared)
            connection.Links.Add((101, 8, 3));
        else
            connection.OrderAddresses.Add(101);

        Assert.True(await new Service(connection).DeleteOwnedAddressAsync(101, 7));
        Assert.Contains(101, connection.Addresses);
        Assert.DoesNotContain(connection.Links, link => link.Address == 101 && link.Owner == 7);
        if (shared)
            Assert.Contains((101, 8, 3), connection.Links);
    }

    [Fact]
    public async Task Delete_failure_does_not_commit_unlinking()
    {
        var connection = new Connection { FailAddressDelete = true };
        var before = connection.Links.ToHashSet();
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => new Service(connection).DeleteOwnedAddressAsync(101, 7));
        Assert.True(before.SetEquals(connection.Links));
        Assert.True(connection.Transaction!.RolledBack);
    }

    private sealed class Service(Connection connection) : AddressService("unused")
    {
        protected override Task<DbConnection> CreateConnectionAsync() => Task.FromResult<DbConnection>(connection);
    }

    private sealed class Connection : DbConnection
    {
        public HashSet<int> Addresses { get; } = [101, 102];
        public HashSet<(int Address, int Owner, int Type)> Links { get; } =
            [(101, 7, 2), (101, 7, 3), (102, 8, 2)];
        public HashSet<int> OrderAddresses { get; } = [];
        public List<(int Address, int? Person)> OrderOwners { get; } = [];
        public Dictionary<int, string> Cities { get; } = new() { [101] = "Original city", [102] = "Original city" };
        public Transaction? Transaction { get; private set; }
        public bool FailAddressDelete { get; init; }
        public bool FailAddressUpdate { get; init; }
        public bool RemoveOwnerBeforeUpdate { get; init; }
        public bool CheckedForSharing { get; set; }
        public int Updates { get; set; }
        public int? ReadOwner { get; set; }
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
        private readonly HashSet<int> _addresses = connection.Addresses.ToHashSet();
        private readonly HashSet<(int Address, int Owner, int Type)> _links = connection.Links.ToHashSet();
        private readonly Dictionary<int, string> _cities = new(connection.Cities);
        public bool Committed { get; private set; }
        public bool RolledBack { get; private set; }
        public override IsolationLevel IsolationLevel => isolationLevel;
        protected override DbConnection DbConnection => connection;
        public override void Commit() => Committed = true;
        public override void Rollback()
        {
            connection.Addresses.Clear();
            connection.Addresses.UnionWith(_addresses);
            connection.Links.Clear();
            connection.Links.UnionWith(_links);
            connection.Cities.Clear();
            foreach (var (address, city) in _cities) connection.Cities[address] = city;
            RolledBack = true;
        }
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
        private int Parameter(string name) =>
            Convert.ToInt32(Parameters.Cast<DbParameter>().Single(p => p.ParameterName.TrimStart('@') == name).Value);
        private object? ParameterValue(string name) =>
            Parameters.Cast<DbParameter>().Single(p => p.ParameterName.TrimStart('@') == name).Value;

        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
        {
            int address = Parameter("Id");
            object? ownerValue = ParameterValue("BusinessEntityId");
            int? owner = ownerValue is DBNull or null ? null : Convert.ToInt32(ownerValue);
            connection.ReadOwner = owner;
            Assert.Contains("@BusinessEntityId IS NULL OR EXISTS", CommandText);
            Assert.Contains("bea.BusinessEntityID = @BusinessEntityId", CommandText);

            if (DbTransaction is not null)
            {
                Assert.Same(connection.Transaction, DbTransaction);
                if (CommandText.Contains("SELECT a.AddressID"))
                    Assert.Equal(2, CommandText.Split("WITH (UPDLOCK, HOLDLOCK)").Length - 1);
            }

            if (CommandText.Contains("UPDATE [Person].[Address]"))
            {
                Assert.Same(connection.Transaction, DbTransaction);
                if (connection.RemoveOwnerBeforeUpdate && owner is int removedOwner)
                    connection.Links.RemoveWhere(link => link.Address == address && link.Owner == removedOwner);
                if (connection.FailAddressUpdate) throw new InvalidOperationException("Simulated database failure");
            }

            bool allowed = connection.Addresses.Contains(address) &&
                (owner is null || connection.Links.Any(link => link.Address == address && link.Owner == owner));
            if (allowed && CommandText.Contains("UPDATE [Person].[Address]"))
            {
                connection.Updates++;
                connection.Cities[address] = (string)ParameterValue("City")!;
            }

            var table = new DataTable();
            table.Columns.Add("AddressID", typeof(int));
            table.Columns.Add("AddressLine1", typeof(string));
            table.Columns.Add("AddressLine2", typeof(string));
            table.Columns.Add("City", typeof(string));
            table.Columns.Add("StateProvinceID", typeof(int));
            table.Columns.Add("PostalCode", typeof(string));
            table.Columns.Add("rowguid", typeof(Guid));
            table.Columns.Add("ModifiedDate", typeof(DateTime));
            if (allowed)
                table.Rows.Add(address, "Fixture street", DBNull.Value, connection.Cities[address],
                    1, "00000", Guid.Empty, DateTime.UnixEpoch);
            return table.CreateDataReader();
        }

        public override object ExecuteScalar()
        {
            Assert.Same(connection.Transaction, DbTransaction);
            Assert.Contains("WITH (UPDLOCK, HOLDLOCK)", CommandText);
            if (CommandText.Contains("SELECT CASE WHEN EXISTS"))
            {
                connection.CheckedForSharing = true;
                Assert.Contains("BusinessEntityID <> @BusinessEntityId", CommandText);
                Assert.Contains("soh.BillToAddressID = @Id OR soh.ShipToAddressID = @Id", CommandText);
                Assert.Contains("customer.PersonID IS NULL OR customer.PersonID <> @BusinessEntityId", CommandText);
                Assert.Contains("[Sales].[Customer] customer WITH (HOLDLOCK)", CommandText);
                int id = Parameter("Id");
                int owner = Parameter("BusinessEntityId");
                return connection.Links.Any(link => link.Address == id && link.Owner != owner) ||
                    connection.OrderOwners.Any(order => order.Address == id && order.Person != owner) ? 1 : 0;
            }
            int address = Parameter("AddressId");
            return connection.Addresses.Contains(address) ? address : DBNull.Value;
        }

        public override int ExecuteNonQuery()
        {
            Assert.Same(connection.Transaction, DbTransaction);
            int address = Parameter("AddressId");
            if (CommandText.Contains("DELETE FROM [Person].[BusinessEntityAddress]"))
            {
                Assert.Contains("BusinessEntityID = @BusinessEntityId", CommandText);
                int owner = Parameter("BusinessEntityId");
                return connection.Links.RemoveWhere(link => link.Address == address && link.Owner == owner);
            }

            Assert.Contains("NOT EXISTS", CommandText);
            Assert.Contains("[Person].[BusinessEntityAddress]", CommandText);
            Assert.Contains("[Sales].[SalesOrderHeader]", CommandText);
            Assert.Contains("BillToAddressID = @AddressId OR ShipToAddressID = @AddressId", CommandText);
            if (connection.FailAddressDelete) throw new InvalidOperationException("Simulated database failure");
            return !connection.Links.Any(link => link.Address == address) &&
                   !connection.OrderAddresses.Contains(address) && connection.Addresses.Remove(address) ? 1 : 0;
        }
    }
}
