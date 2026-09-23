using Microsoft.EntityFrameworkCore;

namespace AdventureWorks.Auth;

/// <summary>
/// EF Core context backing OpenIddict's client/scope/authorization/token stores.
/// Uses the in-memory provider: OAuth registration data is deterministic and re-seeded
/// on every startup, so no external database or migration is required and the
/// AdventureWorks SQL database is never touched for OAuth storage.
/// </summary>
public sealed class AuthDbContext : DbContext
{
    public AuthDbContext(DbContextOptions<AuthDbContext> options) : base(options)
    {
    }
}
