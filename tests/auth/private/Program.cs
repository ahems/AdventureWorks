using System.Text.Json;
using Azure.Core;
using Azure.Identity;
using Microsoft.Data.SqlClient;

var configuration = JsonDocument.Parse(File.ReadAllText(
    Environment.GetEnvironmentVariable("AUTH_ASSURANCE_MANIFEST_FILE")
    ?? throw new InvalidOperationException("Private assurance manifest is required."))).RootElement;
var checks = new List<object>();
var identity = configuration.GetProperty("identity");
try
{
    var credential = new ManagedIdentityCredential(
        ManagedIdentityId.FromUserAssignedClientId(identity.GetProperty("clientId").GetString()!));
    var token = await credential.GetTokenAsync(new TokenRequestContext(["https://database.windows.net/.default"]));
    var payload = token.Token.Split('.')[1].Replace('-', '+').Replace('_', '/');
    using var claims = JsonDocument.Parse(Convert.FromBase64String(payload.PadRight((payload.Length + 3) / 4 * 4, '=')));
    if (claims.RootElement.GetProperty("oid").GetString() != identity.GetProperty("principalId").GetString()
        || claims.RootElement.GetProperty("tid").GetString() != identity.GetProperty("tenantId").GetString())
        throw new InvalidOperationException("Unexpected managed identity.");
    checks.Add(new { id = "shared-uami", group = "private", status = "PASS", detail = "SQL token acquired from the configured runtime managed identity and tenant." });
    var sql = configuration.GetProperty("sql");
    var builder = new SqlConnectionStringBuilder
    {
        DataSource = sql.GetProperty("host").GetString(),
        InitialCatalog = sql.GetProperty("database").GetString(),
        Encrypt = true, TrustServerCertificate = false, ConnectTimeout = 30,
    };
    await using var connection = new SqlConnection(builder.ConnectionString) { AccessToken = token.Token };
    await connection.OpenAsync();
    if (args.Length == 2 && args[0] == "--address-marker")
    {
        Console.WriteLine(JsonSerializer.Serialize(await AddressMarker.ReadAsync(connection, configuration, args[1])));
        return 0;
    }
    if (args.Length == 1 && args[0] == "--address-audit")
    {
        Console.WriteLine(JsonSerializer.Serialize(await AddressFixtures.ReadAsync(connection, configuration)));
        return 0;
    }
    if (args.Length == 4 && args[0] == "--customer-state")
    {
        Console.WriteLine(JsonSerializer.Serialize(await CustomerState.ReadAsync(connection, args[1..])));
        return 0;
    }
    if (args.Length != 0)
        throw new InvalidOperationException("Unknown private probe operation.");
    if ((configuration.TryGetProperty("sqlOnly", out var sqlOnly) && sqlOnly.GetBoolean()) ||
        (configuration.TryGetProperty("mutations", out var mutations) && mutations.GetBoolean()))
    {
        var permissions = await SqlPermissions.ReadAsync(connection, Guid.Parse(identity.GetProperty("clientId").GetString()!));
        checks.AddRange(permissions);
        Console.WriteLine(JsonSerializer.Serialize(new { checks }));
        return permissions.Any(item => item.status == "FAIL") ? 1 :
            permissions.Any(item => item.status == "BLOCKED") ? 2 : 0;
    }
    await using var command = connection.CreateCommand();
    command.CommandTimeout = 30;
    command.CommandText = """
        SELECT USER_NAME() AS principal, ORIGINAL_LOGIN() AS originalLogin,
            IS_ROLEMEMBER('db_owner') AS owner,
            HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL') AS databaseControl,
            HAS_PERMS_BY_NAME('Production.Product', 'OBJECT', 'SELECT') AS readProduct,
            HAS_PERMS_BY_NAME('Sales.ShoppingCartItem', 'OBJECT', 'UPDATE') AS updateCart;
        """;
    await using var reader = await command.ExecuteReaderAsync();
    if (!await reader.ReadAsync()) throw new InvalidOperationException("Missing SQL principal evidence.");
    var hasRead = !reader.IsDBNull(4) && reader.GetInt32(4) == 1;
    checks.Add(new { id = "sql-effective-product-read", group = "private", status = hasRead ? "PASS" : "FAIL",
        detail = "Actual private SQL connection and effective SELECT on Production.Product; no records exported." });
    var inventory = new
    {
        principal = reader.GetString(0), originalLogin = reader.GetString(1),
        dbOwner = reader.IsDBNull(2) ? (int?)null : reader.GetInt32(2),
        databaseControl = reader.IsDBNull(3) ? (int?)null : reader.GetInt32(3),
        cartUpdate = reader.IsDBNull(5) ? (int?)null : reader.GetInt32(5),
    };
    Console.WriteLine(JsonSerializer.Serialize(new { checks, inventory }));
}
catch (Exception error) when (error is Azure.Identity.AuthenticationFailedException
    or Azure.Identity.CredentialUnavailableException or SqlException or InvalidOperationException)
{
    checks.Add(new { id = "private-sql", group = "private", status = "BLOCKED",
        detail = "Private identity/SQL probe failed; inspect restricted runtime diagnostics. No exception, token or connection details exported." });
    Console.WriteLine(JsonSerializer.Serialize(new { checks }));
    return 2;
}
return 0;
