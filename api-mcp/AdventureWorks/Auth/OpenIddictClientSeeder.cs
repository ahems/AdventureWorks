using OpenIddict.Abstractions;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace AdventureWorks.Auth;

/// <summary>
/// Seeds OpenIddict scopes and first-party public (PKCE) clients on startup. Because the
/// OAuth store is in-memory and deterministic, this runs on every boot and is idempotent.
/// Scopes are bound to the canonical MCP resource so issued access tokens carry the
/// correct <c>aud</c>.
/// </summary>
public sealed class OpenIddictClientSeeder : IHostedService
{
    private readonly IServiceProvider _services;
    private readonly AuthorizationServerOptions _options;
    private readonly ILogger<OpenIddictClientSeeder> _logger;

    public OpenIddictClientSeeder(
        IServiceProvider services,
        AuthorizationServerOptions options,
        ILogger<OpenIddictClientSeeder> logger)
    {
        _services = services;
        _options = options;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        using var scope = _services.CreateScope();

        var context = scope.ServiceProvider.GetRequiredService<AuthDbContext>();
        await context.Database.EnsureCreatedAsync(cancellationToken);

        var resource = _options.GetResourceIdentifier();
        var dabResource = _options.GetDabResourceIdentifier();
        var functionsResource = _options.GetFunctionsResourceIdentifier();

        var scopeManager = scope.ServiceProvider.GetRequiredService<IOpenIddictScopeManager>();
        foreach (var name in OAuthScopes.All)
        {
            if (await scopeManager.FindByNameAsync(name, cancellationToken) is not null)
            {
                continue;
            }

            // Bind every scope to all protected resources so a client may target the MCP,
            // DAB or Functions resource via the RFC 8707 'resource' parameter. The effective
            // single audience is chosen server-side in the authorize handler.
            await scopeManager.CreateAsync(new OpenIddictScopeDescriptor
            {
                Name = name,
                DisplayName = OAuthScopes.Descriptions.TryGetValue(name, out var d) ? d : name,
                Resources = { resource, dabResource, functionsResource },
            }, cancellationToken);
        }

        var appManager = scope.ServiceProvider.GetRequiredService<IOpenIddictApplicationManager>();
        foreach (var client in _options.Clients)
        {
            if (await appManager.FindByClientIdAsync(client.ClientId, cancellationToken) is not null)
            {
                continue;
            }

            var descriptor = new OpenIddictApplicationDescriptor
            {
                ClientId = client.ClientId,
                ClientType = ClientTypes.Public,
                ConsentType = ConsentTypes.Explicit,
                DisplayName = client.DisplayName,
                Permissions =
                {
                    Permissions.Endpoints.Authorization,
                    Permissions.Endpoints.Token,
                    Permissions.GrantTypes.AuthorizationCode,
                    Permissions.ResponseTypes.Code,
                },
                Requirements =
                {
                    Requirements.Features.ProofKeyForCodeExchange,
                },
            };

            foreach (var uri in client.RedirectUris)
            {
                if (Uri.TryCreate(uri, UriKind.Absolute, out var parsed))
                {
                    descriptor.RedirectUris.Add(parsed);
                }
                else
                {
                    _logger.LogWarning("Ignoring invalid redirect URI '{Uri}' for client '{ClientId}'.", uri, client.ClientId);
                }
            }

            foreach (var s in client.Scopes)
            {
                descriptor.Permissions.Add(Permissions.Prefixes.Scope + s);
            }

            await appManager.CreateAsync(descriptor, cancellationToken);
            _logger.LogInformation(
                "Registered OAuth client '{ClientId}' with {RedirectCount} redirect URI(s) and {ScopeCount} scope(s).",
                client.ClientId, descriptor.RedirectUris.Count, client.Scopes.Count);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
