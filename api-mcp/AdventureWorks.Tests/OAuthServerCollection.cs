using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Groups every test class that boots the api-mcp host through <see cref="OAuthTestFactory"/>
/// into a single, non-parallel xUnit collection. Those hosts share process-global state — the
/// static EF Core in-memory OpenIddict store and environment variables set in the factory's
/// static constructor — so running two factories concurrently races in the scope/client seeder.
/// Serializing only these integration classes keeps the fast pure-unit tests fully parallel.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class OAuthServerCollection
{
    public const string Name = "OAuthServer";
}
