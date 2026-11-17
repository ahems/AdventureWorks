using Dapper;
using Microsoft.Data.SqlClient;

namespace AdventureWorks.Auth;

/// <summary>
/// Dapper-based <see cref="IUserDirectory"/> over the AdventureWorks database.
/// Resolves user identity and ownership from Person, Sales.Customer and
/// HumanResources.EmployeeDepartmentHistory. Role and scope policy comes from the
/// source-controlled <see cref="ApplicationRoles"/> map.
/// Never maps permissions by user name.
/// </summary>
public sealed class SqlUserDirectory : IUserDirectory
{
    private readonly string _connectionString;

    public SqlUserDirectory(string connectionString)
    {
        _connectionString = connectionString;
    }

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

            string role = ApplicationRoles.RoleForDepartment(departmentId);
            roles = new[] { role };
            category = ApplicationRoles.CategoryFor(role);
        }
        else
        {
            // Individuals (and any non-employee with a customer row) are consumers.
            roles = new[] { ApplicationRoles.Consumer };
            category = UserCategories.Consumer;
        }

        var scopes = ResolveScopes(roles);

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

    private static IReadOnlyList<string> ResolveScopes(IReadOnlyList<string> roles)
    {
        var scopes = roles
            .SelectMany(r => ApplicationRoles.DefaultRoleScopes.TryGetValue(r, out var s) ? s : Array.Empty<string>());
        return NormalizeScopes(scopes);
    }

    private static IReadOnlyList<string> NormalizeScopes(IEnumerable<string> scopes) =>
        scopes.Where(OAuthScopes.IsKnown).Distinct(StringComparer.Ordinal)
              .OrderBy(s => OAuthScopes.All.ToList().IndexOf(s)).ToList();
}
