namespace AdventureWorks.Auth;

/// <summary>
/// An AdventureWorks user resolved from the database into an OAuth subject with
/// category, roles and scopes. This is the authoritative identity the authorization
/// server issues tokens for and the resource server enforces against.
/// </summary>
public sealed class ResolvedUser
{
    /// <summary>Stable, opaque subject (lowercased Person.rowguid). Unique across all user types.</summary>
    public required string Subject { get; init; }

    /// <summary>User category (see <see cref="UserCategories"/>).</summary>
    public required string Category { get; init; }

    /// <summary>Application role(s) resolved from seed data (never from user name).</summary>
    public required IReadOnlyList<string> Roles { get; init; }

    /// <summary>Granted scopes (union of role scopes).</summary>
    public required IReadOnlyList<string> Scopes { get; init; }

    /// <summary>Non-sensitive display name (first + last). Never an email or identifier.</summary>
    public required string DisplayName { get; init; }

    /// <summary>
    /// AdventureWorks Sales.Customer.CustomerID for consumers, used server-side for
    /// ownership checks. Null for internal users. Never placed in the token.
    /// </summary>
    public int? CustomerId { get; init; }

    /// <summary>Person.BusinessEntityID. Kept server-side only; never exposed in tokens.</summary>
    public int BusinessEntityId { get; init; }

    public bool IsConsumer => Category == UserCategories.Consumer;
}
