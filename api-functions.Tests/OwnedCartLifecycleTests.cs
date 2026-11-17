using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using System.Net;
using System.Security.Cryptography;
using api_functions.Services;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class OwnedCartLifecycleTests
{
    private static readonly DateTimeOffset CreatedAt = new(2026, 11, 13, 0, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset ExpiresAt = CreatedAt.AddDays(1);
    private static readonly byte[] Hash = SHA256.HashData(new byte[32]);
    private const string CartId = "guest-lifecycle-test";

    [Theory]
    [InlineData(-1, true)]
    [InlineData(0, false)]
    [InlineData(1, false)]
    public async Task Guest_read_enforces_exact_expiry_without_extending_lifetime(long ticks, bool allowed)
    {
        var clock = new Clock(ExpiresAt.AddTicks(ticks));
        var connection = new Connection(ExpiresAt);
        var service = new Service(connection, clock);

        if (allowed)
        {
            Assert.Empty(await service.ReadAsync(new(null, Hash, CartId), default));
            Assert.True(connection.Transaction.Committed);
        }
        else
        {
            var error = await Assert.ThrowsAsync<CartAccessException>(
                () => service.ReadAsync(new(null, Hash, CartId), default));
            Assert.Equal(HttpStatusCode.Unauthorized, error.Status);
            Assert.False(connection.Transaction.Committed);
        }

        Assert.Empty(connection.Mutations);
        Assert.Equal(ExpiresAt, connection.ExpiresAt);
        Assert.True(connection.Transaction.Disposed);
    }

    [Theory]
    [InlineData("READ")]
    [InlineData("DELETE")]
    [InlineData("RETIRE")]
    [InlineData("MERGE")]
    public async Task Expiry_during_cart_lock_stops_before_data_access_or_mutation(string operation)
    {
        var clock = new Clock(ExpiresAt.AddSeconds(-1));
        var connection = new Connection(ExpiresAt) { OnLock = () => clock.Now = ExpiresAt };
        var service = new Service(connection, clock);

        var error = await Assert.ThrowsAsync<CartAccessException>(() => Invoke(service, operation));

        Assert.Equal(HttpStatusCode.Unauthorized, error.Status);
        Assert.Equal("guest_session_expired_or_invalid", error.Message);
        Assert.Empty(connection.Mutations);
        Assert.Equal(0, connection.CartReads);
        Assert.False(connection.Transaction.Committed);
        Assert.True(connection.Transaction.Disposed);
    }

    [Fact]
    public async Task Merge_rechecks_expiry_after_waiting_for_the_account_lock()
    {
        var clock = new Clock(ExpiresAt.AddSeconds(-1));
        var connection = new Connection(ExpiresAt);
        connection.OnLock = () =>
        {
            if (connection.LockCount == 2)
                clock.Now = ExpiresAt;
        };
        var service = new Service(connection, clock);

        await Assert.ThrowsAsync<CartAccessException>(() => service.MergeAsync(7, Hash, default));

        Assert.Equal(2, connection.LockCount);
        Assert.Empty(connection.Mutations);
        Assert.False(connection.Transaction.Committed);
    }

    [Theory]
    [InlineData("READ")]
    [InlineData("DELETE")]
    [InlineData("RETIRE")]
    [InlineData("MERGE")]
    public async Task Retired_session_cannot_be_reused_before_expiry(string operation)
    {
        var clock = new Clock(CreatedAt.AddHours(1));
        var connection = new Connection(ExpiresAt) { RetiredAt = CreatedAt.AddMinutes(30) };
        var service = new Service(connection, clock);

        await Assert.ThrowsAsync<CartAccessException>(() => Invoke(service, operation));

        Assert.Empty(connection.Mutations);
        Assert.Equal(0, connection.LockCount);
        Assert.False(connection.Transaction.Committed);
    }

    [Theory]
    [InlineData(7, -1, true)]
    [InlineData(8, -1, false)]
    [InlineData(7, 0, false)]
    public async Task Merge_retry_is_idempotent_only_for_same_owner_before_expiry(
        int owner, long ticks, bool allowed)
    {
        var clock = new Clock(ExpiresAt.AddTicks(ticks));
        var connection = new Connection(ExpiresAt)
        {
            RetiredAt = CreatedAt.AddHours(1),
            MergedOwner = 7,
        };
        var service = new Service(connection, clock);

        if (allowed)
            await service.MergeAsync(owner, Hash, default);
        else
            await Assert.ThrowsAsync<CartAccessException>(() => service.MergeAsync(owner, Hash, default));

        Assert.Empty(connection.Mutations);
        Assert.Equal(0, connection.LockCount);
        Assert.Equal(allowed, connection.Transaction.Committed);
    }

    [Fact]
    public async Task New_session_has_fixed_lifetime_and_persists_only_hashed_proof()
    {
        var clock = new Clock(CreatedAt);
        var connection = new Connection(ExpiresAt);
        var service = new Service(connection, clock);

        var session = await service.CreateSessionAsync(default);

        var insert = Assert.Single(connection.Mutations);
        Assert.Equal(CreatedAt.UtcDateTime, insert.Parameters["@now"]);
        Assert.Equal(ExpiresAt.UtcDateTime, insert.Parameters["@expires"]);
        Assert.Equal(ExpiresAt, session.ExpiresAt);
        Assert.Equal(SHA256.HashData(Convert.FromHexString(session.Token)), insert.Parameters["@hash"]);
        Assert.DoesNotContain(session.Token, insert.Parameters.Values.OfType<string>());
        Assert.True(connection.Transaction.Committed);
        Assert.Equal(IsolationLevel.Serializable, connection.Transaction.IsolationLevel);
    }

    [Fact]
    public async Task Expected_cart_mismatch_is_denied_before_lock_or_data_access()
    {
        var connection = new Connection(ExpiresAt);
        var service = new Service(connection, new Clock(CreatedAt));

        var error = await Assert.ThrowsAsync<CartAccessException>(
            () => service.ReadAsync(new(null, Hash, "guest-other"), default));

        Assert.Equal(HttpStatusCode.Forbidden, error.Status);
        Assert.Empty(connection.Mutations);
        Assert.Equal(0, connection.LockCount);
        Assert.Equal(0, connection.CartReads);
    }

    private static Task Invoke(OwnedCartService service, string operation) => operation switch
    {
        "READ" => service.ReadAsync(new(null, Hash, CartId), default),
        "DELETE" => service.DeleteAsync(new(null, Hash, CartId), null, default),
        "RETIRE" => service.RetireAsync(Hash, default),
        "MERGE" => service.MergeAsync(7, Hash, default),
        _ => throw new ArgumentOutOfRangeException(nameof(operation)),
    };

    private sealed class Clock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class Service(Connection connection, TimeProvider clock) : OwnedCartService(
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SQL_CONNECTION_STRING"] = "unused",
        }).Build(), clock)
    {
        protected override DbConnection CreateConnection() => connection;
    }

    private sealed record Mutation(string Sql, Dictionary<string, object?> Parameters);

    private sealed class Connection(DateTimeOffset expiresAt) : DbConnection
    {
        public DateTimeOffset ExpiresAt { get; } = expiresAt;
        public DateTimeOffset? RetiredAt { get; init; }
        public int? MergedOwner { get; init; }
        public Action? OnLock { get; set; }
        public int LockCount { get; private set; }
        public int CartReads { get; private set; }
        public List<Mutation> Mutations { get; } = [];
        public Transaction Transaction { get; } = new();
        [AllowNull]
        public override string ConnectionString { get; set; } = "";
        public override string Database => "unit-test";
        public override string DataSource => "unit-test";
        public override string ServerVersion => "unit-test";
        public override ConnectionState State => ConnectionState.Open;
        public override void Open() { }
        public override void Close() { }
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        protected override DbCommand CreateDbCommand() => new Command(this);
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel)
        {
            Assert.Equal(IsolationLevel.Serializable, isolationLevel);
            return Transaction;
        }

        public DbDataReader Read(string sql)
        {
            var table = new DataTable();
            if (sql.Contains("FROM Sales.GuestCartSession", StringComparison.Ordinal))
            {
                table.Columns.Add("CartID", typeof(string));
                table.Columns.Add("ExpiresUtc", typeof(DateTime));
                table.Columns.Add("RetiredUtc", typeof(DateTime));
                table.Columns.Add("MergedBusinessEntityID", typeof(int));
                table.Rows.Add(CartId, ExpiresAt.UtcDateTime,
                    RetiredAt.HasValue ? RetiredAt.Value.UtcDateTime : DBNull.Value,
                    MergedOwner.HasValue ? MergedOwner.Value : DBNull.Value);
            }
            else
            {
                CartReads++;
            }
            return table.CreateDataReader();
        }

        public int Execute(string sql, Dictionary<string, object?> parameters)
        {
            if (sql.Contains("sp_getapplock", StringComparison.Ordinal))
            {
                LockCount++;
                OnLock?.Invoke();
            }
            else
            {
                Mutations.Add(new(sql, parameters));
            }
            return 1;
        }
    }

    private sealed class Transaction : DbTransaction
    {
        public bool Committed { get; private set; }
        public bool Disposed { get; private set; }
        public override IsolationLevel IsolationLevel => IsolationLevel.Serializable;
        protected override DbConnection? DbConnection => null;
        public override void Commit() => Committed = true;
        public override void Rollback() => Committed = false;
        protected override void Dispose(bool disposing)
        {
            Disposed = true;
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
        public override int ExecuteNonQuery() => connection.Execute(CommandText,
            Parameters.Cast<DbParameter>().ToDictionary(parameter => parameter.ParameterName, parameter => parameter.Value));
        public override object ExecuteScalar() => 0L;
        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior) => connection.Read(CommandText);
    }
}
