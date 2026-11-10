using System.Data;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;

namespace api_functions.Services;

public sealed class CartAccessException(HttpStatusCode status, string code) : Exception(code)
{
    public HttpStatusCode Status { get; } = status;
}

public sealed record CartActor(int? BusinessEntityId, byte[]? GuestHash, string? ExpectedCartId = null)
{
    public static byte[] HashToken(string token)
    {
        if (token.Length != 64 || !token.All(Uri.IsHexDigit))
            throw new CartAccessException(HttpStatusCode.Unauthorized, "invalid_guest_session");
        return SHA256.HashData(Convert.FromHexString(token));
    }
}

public sealed record GuestCartSession(
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("cartId")] string CartId,
    [property: JsonPropertyName("expiresAt")] DateTimeOffset ExpiresAt);

public sealed record OwnedCartItem(
    [property: JsonPropertyName("ShoppingCartItemID")] int ShoppingCartItemID,
    [property: JsonPropertyName("ShoppingCartID")] string ShoppingCartID,
    [property: JsonPropertyName("ProductID")] int ProductID,
    [property: JsonPropertyName("Quantity")] int Quantity,
    [property: JsonPropertyName("DateCreated")] DateTime DateCreated,
    [property: JsonPropertyName("ModifiedDate")] DateTime ModifiedDate);

public interface IOwnedCartService
{
    Task<GuestCartSession> CreateSessionAsync(CancellationToken cancellationToken);
    Task<IReadOnlyList<OwnedCartItem>> ReadAsync(CartActor actor, CancellationToken cancellationToken);
    Task<OwnedCartItem> AddAsync(CartActor actor, int productId, int quantity, CancellationToken cancellationToken);
    Task<OwnedCartItem> UpdateAsync(CartActor actor, int itemId, int quantity, CancellationToken cancellationToken);
    Task DeleteAsync(CartActor actor, int? itemId, CancellationToken cancellationToken);
    Task RetireAsync(byte[] hash, CancellationToken cancellationToken);
    Task MergeAsync(int businessEntityId, byte[] hash, CancellationToken cancellationToken);
    Task CleanupAsync(CancellationToken cancellationToken);
}

public sealed class OwnedCartService(IConfiguration configuration, TimeProvider clock) : IOwnedCartService
{
    private const string Columns = "ShoppingCartItemID, ShoppingCartID, ProductID, Quantity, DateCreated, ModifiedDate";
    private readonly string _connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is required.");

    private static SqlCommand Command(SqlConnection connection, SqlTransaction transaction, string sql,
        params (string Name, object Value)[] parameters)
    {
        var command = new SqlCommand(sql, connection, transaction);
        foreach (var (name, value) in parameters)
            command.Parameters.AddWithValue(name, value);
        return command;
    }

    private async Task<T> TransactionAsync<T>(
        Func<SqlConnection, SqlTransaction, Task<T>> work, CancellationToken cancellationToken)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(
            IsolationLevel.Serializable, cancellationToken);
        try
        {
            var result = await work(connection, transaction);
            await transaction.CommitAsync(cancellationToken);
            return result;
        }
        catch (SqlException error) when (error.Number == 51101)
        {
            throw new CartAccessException(HttpStatusCode.Conflict, "cart_quantity_limit");
        }
        catch (SqlException error) when (error.Number == 51102)
        {
            throw new CartAccessException(HttpStatusCode.NotFound, "product_not_found");
        }
        catch (SqlException error) when (error.Number == 51103)
        {
            throw new CartAccessException(HttpStatusCode.Conflict, "cart_busy");
        }
    }

    private static async Task LockCartAsync(SqlConnection connection, SqlTransaction transaction,
        string cartId, CancellationToken cancellationToken)
    {
        await using var command = Command(connection, transaction, """
            DECLARE @result int;
            EXEC @result = sys.sp_getapplock @Resource = @resource, @LockMode = 'Exclusive',
                @LockOwner = 'Transaction', @LockTimeout = 10000;
            IF @result < 0 THROW 51103, 'Cart is busy.', 1;
            """, ("@resource", "owned-cart:" + cartId));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<string> ResolveAsync(SqlConnection connection, SqlTransaction transaction,
        CartActor actor, CancellationToken cancellationToken)
    {
        string cartId;
        if (actor.BusinessEntityId is > 0 && actor.GuestHash is null)
            cartId = actor.BusinessEntityId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        else if (actor.BusinessEntityId is null && actor.GuestHash is { Length: 32 })
        {
            await using var query = Command(connection, transaction, """
                SELECT CartID FROM Sales.GuestCartSession WITH (UPDLOCK, HOLDLOCK)
                WHERE TokenHash = @hash AND ExpiresUtc > @now AND RetiredUtc IS NULL;
                """, ("@hash", actor.GuestHash), ("@now", clock.GetUtcNow().UtcDateTime));
            cartId = await query.ExecuteScalarAsync(cancellationToken) as string
                ?? throw new CartAccessException(HttpStatusCode.Unauthorized, "guest_session_expired_or_invalid");
        }
        else
            throw new CartAccessException(HttpStatusCode.Unauthorized, "cart_identity_required");
        if (actor.ExpectedCartId is not null && actor.ExpectedCartId != cartId)
            throw new CartAccessException(HttpStatusCode.Forbidden, "cart_owner_mismatch");
        await LockCartAsync(connection, transaction, cartId, cancellationToken);
        return cartId;
    }

    public Task<GuestCartSession> CreateSessionAsync(CancellationToken cancellationToken) =>
        TransactionAsync(async (connection, transaction) =>
        {
            await using var count = Command(connection, transaction,
                "SELECT COUNT_BIG(*) FROM Sales.GuestCartSession WITH (UPDLOCK, HOLDLOCK);");
            if (Convert.ToInt64(await count.ExecuteScalarAsync(cancellationToken)) >= 10000)
                throw new CartAccessException(HttpStatusCode.TooManyRequests, "guest_session_capacity_reached");
            var now = clock.GetUtcNow();
            var session = new GuestCartSession(Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
                "guest-" + Guid.NewGuid().ToString("N"), now.AddDays(1));
            await using var insert = Command(connection, transaction, """
                INSERT Sales.GuestCartSession (CartID, TokenHash, CreatedUtc, ExpiresUtc)
                VALUES (@cart, @hash, @now, @expires);
                """, ("@cart", session.CartId), ("@hash", CartActor.HashToken(session.Token)),
                ("@now", now.UtcDateTime), ("@expires", session.ExpiresAt.UtcDateTime));
            await insert.ExecuteNonQueryAsync(cancellationToken);
            return session;
        }, cancellationToken);

    private static async Task<IReadOnlyList<OwnedCartItem>> RowsAsync(
        SqlCommand command, CancellationToken cancellationToken)
    {
        var rows = new List<OwnedCartItem>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            rows.Add(new(reader.GetInt32(0), reader.GetString(1), reader.GetInt32(2),
                Convert.ToInt32(reader.GetValue(3)), DateTime.SpecifyKind(reader.GetDateTime(4), DateTimeKind.Utc),
                DateTime.SpecifyKind(reader.GetDateTime(5), DateTimeKind.Utc)));
        return rows;
    }

    public Task<IReadOnlyList<OwnedCartItem>> ReadAsync(CartActor actor, CancellationToken cancellationToken) =>
        TransactionAsync(async (connection, transaction) =>
        {
            var cart = await ResolveAsync(connection, transaction, actor, cancellationToken);
            await using var query = Command(connection, transaction,
                $"SELECT {Columns} FROM Sales.ShoppingCartItem WHERE ShoppingCartID = @cart ORDER BY ShoppingCartItemID;",
                ("@cart", cart));
            return await RowsAsync(query, cancellationToken);
        }, cancellationToken);

    public Task<OwnedCartItem> AddAsync(CartActor actor, int productId, int quantity, CancellationToken cancellationToken)
    {
        ValidateQuantity(quantity);
        if (productId <= 0)
            throw new CartAccessException(HttpStatusCode.BadRequest, "invalid_product");
        return TransactionAsync(async (connection, transaction) =>
        {
            var cart = await ResolveAsync(connection, transaction, actor, cancellationToken);
            await using var add = Command(connection, transaction, $"""
                IF NOT EXISTS (SELECT 1 FROM Production.Product WHERE ProductID = @product)
                    THROW 51102, 'Product not found.', 1;
                DECLARE @id int = (SELECT MIN(ShoppingCartItemID) FROM Sales.ShoppingCartItem
                    WHERE ShoppingCartID = @cart AND ProductID = @product);
                DECLARE @total bigint = COALESCE((SELECT SUM(CONVERT(bigint, Quantity)) FROM Sales.ShoppingCartItem
                    WHERE ShoppingCartID = @cart AND ProductID = @product), 0) + @quantity;
                IF @total > 32767 THROW 51101, 'Cart quantity limit.', 1;
                IF @id IS NULL
                    INSERT Sales.ShoppingCartItem (ShoppingCartID, ProductID, Quantity)
                    VALUES (@cart, @product, @quantity);
                ELSE
                BEGIN
                    DELETE Sales.ShoppingCartItem WHERE ShoppingCartID = @cart AND ProductID = @product
                        AND ShoppingCartItemID <> @id;
                    UPDATE Sales.ShoppingCartItem SET Quantity = @total, ModifiedDate = SYSUTCDATETIME()
                        WHERE ShoppingCartID = @cart AND ShoppingCartItemID = @id;
                END;
                SELECT {Columns} FROM Sales.ShoppingCartItem WHERE ShoppingCartID = @cart AND ProductID = @product;
                """, ("@cart", cart), ("@product", productId), ("@quantity", quantity));
            return (await RowsAsync(add, cancellationToken)).Single();
        }, cancellationToken);
    }

    public Task<OwnedCartItem> UpdateAsync(CartActor actor, int itemId, int quantity, CancellationToken cancellationToken)
    {
        ValidateQuantity(quantity);
        return TransactionAsync(async (connection, transaction) =>
        {
            var cart = await ResolveAsync(connection, transaction, actor, cancellationToken);
            await using var update = Command(connection, transaction, $"""
                UPDATE Sales.ShoppingCartItem SET Quantity = @quantity, ModifiedDate = SYSUTCDATETIME()
                WHERE ShoppingCartID = @cart AND ShoppingCartItemID = @id;
                SELECT {Columns} FROM Sales.ShoppingCartItem WHERE ShoppingCartID = @cart AND ShoppingCartItemID = @id;
                """, ("@cart", cart), ("@id", itemId), ("@quantity", quantity));
            return (await RowsAsync(update, cancellationToken)).SingleOrDefault()
                ?? throw new CartAccessException(HttpStatusCode.NotFound, "cart_item_not_found");
        }, cancellationToken);
    }

    public async Task DeleteAsync(CartActor actor, int? itemId, CancellationToken cancellationToken) =>
        _ = await TransactionAsync(async (connection, transaction) =>
        {
            var cart = await ResolveAsync(connection, transaction, actor, cancellationToken);
            await using var delete = Command(connection, transaction, """
                DELETE Sales.ShoppingCartItem WHERE ShoppingCartID = @cart AND (@id IS NULL OR ShoppingCartItemID = @id);
                """, ("@cart", cart), ("@id", itemId.HasValue ? itemId.Value : DBNull.Value));
            var changed = await delete.ExecuteNonQueryAsync(cancellationToken);
            if (itemId.HasValue && changed == 0)
                throw new CartAccessException(HttpStatusCode.NotFound, "cart_item_not_found");
            return true;
        }, cancellationToken);

    public async Task RetireAsync(byte[] hash, CancellationToken cancellationToken) =>
        _ = await TransactionAsync(async (connection, transaction) =>
        {
            var cart = await ResolveAsync(connection, transaction, new(null, hash), cancellationToken);
            await using var retire = Command(connection, transaction, """
                DELETE Sales.ShoppingCartItem WHERE ShoppingCartID = @cart;
                UPDATE Sales.GuestCartSession SET RetiredUtc = @now WHERE TokenHash = @hash;
                """, ("@cart", cart), ("@hash", hash), ("@now", clock.GetUtcNow().UtcDateTime));
            await retire.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    public async Task MergeAsync(int businessEntityId, byte[] hash, CancellationToken cancellationToken) =>
        _ = await TransactionAsync(async (connection, transaction) =>
        {
            if (businessEntityId <= 0)
                throw new CartAccessException(HttpStatusCode.Forbidden, "consumer_identity_required");
            await using var session = Command(connection, transaction, """
                SELECT MergedBusinessEntityID FROM Sales.GuestCartSession WITH (UPDLOCK, HOLDLOCK)
                WHERE TokenHash = @hash AND ExpiresUtc > @now;
                """, ("@hash", hash), ("@now", clock.GetUtcNow().UtcDateTime));
            var previous = await session.ExecuteScalarAsync(cancellationToken);
            if (previous is int owner && owner == businessEntityId)
                return true;
            var guest = await ResolveAsync(connection, transaction, new(null, hash), cancellationToken);
            var account = businessEntityId.ToString(System.Globalization.CultureInfo.InvariantCulture);
            await LockCartAsync(connection, transaction, account, cancellationToken);
            await using var merge = Command(connection, transaction, """
                DECLARE @totals TABLE (ProductID int PRIMARY KEY, Quantity bigint, DateCreated datetime);
                INSERT @totals
                SELECT ProductID, SUM(CONVERT(bigint, Quantity)), MIN(DateCreated)
                FROM Sales.ShoppingCartItem
                WHERE ShoppingCartID IN (@guest, @account) AND ProductID IN
                    (SELECT ProductID FROM Sales.ShoppingCartItem WHERE ShoppingCartID = @guest)
                GROUP BY ProductID;
                IF EXISTS (SELECT 1 FROM @totals WHERE Quantity > 32767)
                    THROW 51101, 'Cart quantity limit.', 1;
                DELETE Sales.ShoppingCartItem WHERE ShoppingCartID = @account AND ProductID IN
                    (SELECT ProductID FROM @totals);
                INSERT Sales.ShoppingCartItem (ShoppingCartID, ProductID, Quantity, DateCreated)
                    SELECT @account, ProductID, Quantity, DateCreated FROM @totals;
                DELETE Sales.ShoppingCartItem WHERE ShoppingCartID = @guest;
                UPDATE Sales.GuestCartSession SET RetiredUtc = @now, MergedBusinessEntityID = @owner
                    WHERE TokenHash = @hash;
                """, ("@guest", guest), ("@account", account), ("@hash", hash),
                ("@owner", businessEntityId), ("@now", clock.GetUtcNow().UtcDateTime));
            await merge.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    public async Task CleanupAsync(CancellationToken cancellationToken) =>
        _ = await TransactionAsync(async (connection, transaction) =>
        {
            await using var cleanup = Command(connection, transaction, """
                DECLARE @expired TABLE (CartID varchar(50) PRIMARY KEY);
                INSERT @expired SELECT TOP (500) CartID FROM Sales.GuestCartSession WITH (UPDLOCK, HOLDLOCK)
                    WHERE ExpiresUtc <= @now ORDER BY ExpiresUtc;
                DELETE c FROM Sales.ShoppingCartItem c JOIN @expired e ON c.ShoppingCartID = e.CartID;
                DELETE s FROM Sales.GuestCartSession s JOIN @expired e ON s.CartID = e.CartID;
                """, ("@now", clock.GetUtcNow().UtcDateTime));
            await cleanup.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    private static void ValidateQuantity(int quantity)
    {
        if (quantity is < 1 or > short.MaxValue)
            throw new CartAccessException(HttpStatusCode.BadRequest, "invalid_quantity");
    }
}
