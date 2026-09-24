using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AdventureWorks.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace AdventureWorks.Tests;

/// <summary>
/// Boots the api-mcp OAuth authorization server in-process with deterministic, SQL-free
/// configuration. A <see cref="FakeUserDirectory"/> replaces <see cref="IUserDirectory"/>
/// so authorization flows never touch Azure SQL. Signing uses the ephemeral dev RSA key
/// (no Key Vault), which is sufficient to validate metadata, JWKS and the PKCE code flow.
/// </summary>
public sealed class OAuthTestFactory : WebApplicationFactory<Program>
{
    public const string ResourceIdentifier = "https://mcp.adventureworks.test/mcp";
    public const string DabResourceIdentifier = "https://mcp.adventureworks.test/dab";
    public const string FunctionsResourceIdentifier = "https://mcp.adventureworks.test/functions";

    static OAuthTestFactory()
    {
        // Program.cs reads these via builder.Configuration BEFORE WebApplicationFactory's
        // ConfigureAppConfiguration callbacks run, so they must exist as environment
        // variables (which CreateBuilder's env-var source picks up immediately). None of
        // these endpoints are ever contacted — the SQL directory is replaced with a fake.
        Environment.SetEnvironmentVariable("AZURE_OPENAI_ENDPOINT", "https://openai.invalid/");
        Environment.SetEnvironmentVariable("API_FUNCTIONS_URL", "http://localhost:9099");
        Environment.SetEnvironmentVariable("MCP_OAUTH_ALLOW_HTTP", "true");
        Environment.SetEnvironmentVariable("MCP_RESOURCE_IDENTIFIER", ResourceIdentifier);
        Environment.SetEnvironmentVariable("DAB_RESOURCE_IDENTIFIER", DabResourceIdentifier);
        Environment.SetEnvironmentVariable("FUNCTIONS_RESOURCE_IDENTIFIER", FunctionsResourceIdentifier);
    }

    public FakeUserDirectory Directory { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");

        builder.ConfigureAppConfiguration((_, config) =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:AdventureWorks"] = "Server=(local);Database=none;Trusted_Connection=True;",
            });
        });

        builder.ConfigureTestServices(services =>
        {
            // Replace the SQL-backed directory with an in-memory fake.
            var existing = services.Where(d => d.ServiceType == typeof(IUserDirectory)).ToList();
            foreach (var d in existing)
            {
                services.Remove(d);
            }

            services.AddSingleton<IUserDirectory>(Directory);
        });
    }
}

/// <summary>In-memory <see cref="IUserDirectory"/> for authorization-flow tests.</summary>
public sealed class FakeUserDirectory : IUserDirectory
{
    private readonly Dictionary<string, ResolvedUser> _byUsername = new(System.StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<int, ResolvedUser> _byBeid = new();
    private readonly Dictionary<string, ResolvedUser> _bySubject = new(System.StringComparer.Ordinal);
    private readonly Dictionary<string, string> _passwords = new(System.StringComparer.OrdinalIgnoreCase);

    public void Add(string username, string password, ResolvedUser user)
    {
        _byUsername[username] = user;
        _byBeid[user.BusinessEntityId] = user;
        _bySubject[user.Subject] = user;
        _passwords[username] = password;
    }

    public Task<ResolvedUser?> AuthenticateAsync(string username, string password, CancellationToken ct = default)
    {
        if (_passwords.TryGetValue(username, out var expected) && expected == password &&
            _byUsername.TryGetValue(username, out var user))
        {
            return Task.FromResult<ResolvedUser?>(user);
        }

        return Task.FromResult<ResolvedUser?>(null);
    }

    public Task<ResolvedUser?> ResolveBySubjectAsync(string subject, CancellationToken ct = default) =>
        Task.FromResult(_bySubject.TryGetValue(subject, out var u) ? u : null);

    public Task<ResolvedUser?> ResolveByBusinessEntityIdAsync(int businessEntityId, CancellationToken ct = default) =>
        Task.FromResult(_byBeid.TryGetValue(businessEntityId, out var u) ? u : null);
}
