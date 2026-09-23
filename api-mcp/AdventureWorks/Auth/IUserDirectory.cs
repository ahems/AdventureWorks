namespace AdventureWorks.Auth;

/// <summary>
/// Resolves AdventureWorks database users into OAuth subjects (category, roles,
/// scopes, ownership identifiers) and verifies credentials against Person.Password.
/// Abstracted so the resource/authorization logic is unit-testable without SQL.
/// </summary>
public interface IUserDirectory
{
    /// <summary>Verifies a username (email) + password and resolves the user, or null if invalid.</summary>
    Task<ResolvedUser?> AuthenticateAsync(string username, string password, CancellationToken ct = default);

    /// <summary>Resolves a user by stable subject (lowercased Person.rowguid), or null.</summary>
    Task<ResolvedUser?> ResolveBySubjectAsync(string subject, CancellationToken ct = default);

    /// <summary>Resolves a user by Person.BusinessEntityID, or null.</summary>
    Task<ResolvedUser?> ResolveByBusinessEntityIdAsync(int businessEntityId, CancellationToken ct = default);
}
