using Dapper;
using Microsoft.Data.SqlClient;

namespace AdventureWorks.Auth;

/// <summary>
/// Dapper-based <see cref="IUserDirectory"/> over the AdventureWorks database.
/// Resolves category / role / scope / ownership purely from data:
/// Person, Sales.Customer, HumanResources.EmployeeDepartmentHistory and the
/// deterministic <c>Auth.*</c> seed tables (with in-code fallbacks that mirror the seed).
/// Never maps permissions by user name.
/// </summary>
public sealed class SqlUserDirectory : IUserDirectory
{
    private readonly string _connectionString;
    private readonly ILogger<SqlUserDirectory> _logger;

    public SqlUserDirectory(string connectionString, ILogger<SqlUserDirectory> logger)
    {
        _connectionString = connectionString;
        _logger = logger;
    }

    /// <summary>Fallback department → role mapping (mirrors Auth.DepartmentRole seed).</summary>
    private static readonly IReadOnlyDictionary<int, string> DepartmentRoleFallback = new Dictionary<int, string>
    {
        [3] = ApplicationRoles.SalesAdmin,            // Sales
        [4] = ApplicationRoles.MarketingAdmin,        // Marketing
        [5] = ApplicationRoles.InventoryAdmin,        // Purchasing (Inventory Management)
        [15] = ApplicationRoles.InventoryAdmin,       // Shipping and Receiving (Inventory Management)
        [7] = ApplicationRoles.ManufacturingEngineer, // Production (Manufacturing)
        [8] = ApplicationRoles.ManufacturingEngineer, // Production Control (Manufacturing)
        [16] = ApplicationRoles.ExecutiveAdmin,       // Executive
    };

    private async Task<SqlConnection> OpenAsync(CancellationToken ct)
    {
        var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        return conn;
    }

    public async Task<ResolvedUser?> AuthenticateAsync(string username, string password, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
        {
            return null;
        }

        await using var conn = await OpenAsync(ct);
        var cred = await conn.QueryFirstOrDefaultAsync<(int BusinessEntityID, string? PasswordHash, string? PasswordSalt)>(
            new CommandDefinition(
                @"SELECT TOP 1 p.BusinessEntityID, pw.PasswordHash, pw.PasswordSalt
                  FROM Person.EmailAddress e
                  INNER JOIN Person.Person p ON p.BusinessEntityID = e.BusinessEntityID
                  LEFT JOIN Person.[Password] pw ON pw.BusinessEntityID = p.BusinessEntityID
                  WHERE e.EmailAddress = @Username
                  ORDER BY p.BusinessEntityID",
                new { Username = username.Trim() }, cancellationToken: ct));

        if (cred.BusinessEntityID == 0 || string.IsNullOrEmpty(cred.PasswordHash) || string.IsNullOrEmpty(cred.PasswordSalt))
        {
            return null;
        }

        if (!PasswordHasher.Verify(password, cred.PasswordHash!, cred.PasswordSalt!))
        {
            return null;
        }

        return await ResolveByBusinessEntityIdAsync(cred.BusinessEntityID, ct);
    }

    public async Task<ResolvedUser?> ResolveBySubjectAsync(string subject, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(subject))
        {
            return null;
        }

        await using var conn = await OpenAsync(ct);
        var beid = await conn.QueryFirstOrDefaultAsync<int?>(
            new CommandDefinition(
                @"SELECT TOP 1 p.BusinessEntityID FROM Person.Person p
                  WHERE LOWER(CONVERT(varchar(36), p.rowguid)) = @Subject",
                new { Subject = subject.Trim().ToLowerInvariant() }, cancellationToken: ct));

        return beid is null or 0 ? null : await ResolveByBusinessEntityIdAsync(beid.Value, ct);
    }

    public async Task<ResolvedUser?> ResolveByBusinessEntityIdAsync(int businessEntityId, CancellationToken ct = default)
    {
        if (businessEntityId <= 0)
        {
            return null;
        }

        await using var conn = await OpenAsync(ct);

        var person = await conn.QueryFirstOrDefaultAsync<(int BusinessEntityID, string Subject, string PersonType, string? FirstName, string? LastName)>(
            new CommandDefinition(
                @"SELECT p.BusinessEntityID,
                         LOWER(CONVERT(varchar(36), p.rowguid)) AS Subject,
                         p.PersonType, p.FirstName, p.LastName
                  FROM Person.Person p
                  WHERE p.BusinessEntityID = @Beid",
                new { Beid = businessEntityId }, cancellationToken: ct));

        if (person.BusinessEntityID == 0)
        {
            return null;
        }

        int? customerId = await conn.QueryFirstOrDefaultAsync<int?>(
            new CommandDefinition(
                @"SELECT TOP 1 c.CustomerID FROM Sales.Customer c
                  WHERE c.PersonID = @Beid ORDER BY c.CustomerID",
                new { Beid = businessEntityId }, cancellationToken: ct));

        string category;
        IReadOnlyList<string> roles;

        bool isEmployee = string.Equals(person.PersonType, "EM", StringComparison.OrdinalIgnoreCase);
        if (isEmployee)
        {
            int? departmentId = await conn.QueryFirstOrDefaultAsync<int?>(
                new CommandDefinition(
                    @"SELECT TOP 1 edh.DepartmentID
                      FROM HumanResources.EmployeeDepartmentHistory edh
                      WHERE edh.BusinessEntityID = @Beid AND edh.EndDate IS NULL
                      ORDER BY edh.StartDate DESC",
                    new { Beid = businessEntityId }, cancellationToken: ct));

            string role = await ResolveDepartmentRoleAsync(conn, departmentId, ct);
            roles = new[] { role };
            category = ApplicationRoles.CategoryFor(role);
        }
        else
        {
            // Individuals (and any non-employee with a customer row) are consumers.
            roles = new[] { ApplicationRoles.Consumer };
            category = UserCategories.Consumer;
        }

        var scopes = await ResolveScopesAsync(conn, roles, ct);

        var displayName = string.Join(' ', new[] { person.FirstName, person.LastName }
            .Where(s => !string.IsNullOrWhiteSpace(s))).Trim();
        if (string.IsNullOrWhiteSpace(displayName))
        {
            displayName = category;
        }

        return new ResolvedUser
        {
            Subject = person.Subject,
            Category = category,
            Roles = roles,
            Scopes = scopes,
            DisplayName = displayName,
            CustomerId = category == UserCategories.Consumer ? customerId : null,
            BusinessEntityId = person.BusinessEntityID,
        };
    }

    private async Task<string> ResolveDepartmentRoleAsync(SqlConnection conn, int? departmentId, CancellationToken ct)
    {
        if (departmentId is null)
        {
            return ApplicationRoles.OperationsAdmin;
        }

        try
        {
            var role = await conn.QueryFirstOrDefaultAsync<string?>(
                new CommandDefinition(
                    "SELECT TOP 1 RoleName FROM Auth.DepartmentRole WHERE DepartmentId = @DepartmentId",
                    new { DepartmentId = departmentId.Value }, cancellationToken: ct));
            if (!string.IsNullOrWhiteSpace(role))
            {
                return role!;
            }
        }
        catch (SqlException ex)
        {
            _logger.LogDebug(ex, "Auth.DepartmentRole unavailable; using in-code fallback map");
        }

        return DepartmentRoleFallback.TryGetValue(departmentId.Value, out var fallback)
            ? fallback
            : ApplicationRoles.OperationsAdmin;
    }

    private async Task<IReadOnlyList<string>> ResolveScopesAsync(SqlConnection conn, IReadOnlyList<string> roles, CancellationToken ct)
    {
        try
        {
            var scopes = (await conn.QueryAsync<string>(
                new CommandDefinition(
                    "SELECT DISTINCT Scope FROM Auth.RoleScope WHERE RoleName IN @Roles",
                    new { Roles = roles }, cancellationToken: ct))).ToList();
            if (scopes.Count > 0)
            {
                return NormalizeScopes(scopes);
            }
        }
        catch (SqlException ex)
        {
            _logger.LogDebug(ex, "Auth.RoleScope unavailable; using in-code fallback scopes");
        }

        var fallback = roles
            .SelectMany(r => ApplicationRoles.DefaultRoleScopes.TryGetValue(r, out var s) ? s : Array.Empty<string>());
        return NormalizeScopes(fallback);
    }

    private static IReadOnlyList<string> NormalizeScopes(IEnumerable<string> scopes) =>
        scopes.Where(OAuthScopes.IsKnown).Distinct(StringComparer.Ordinal)
              .OrderBy(s => OAuthScopes.All.ToList().IndexOf(s)).ToList();
}
