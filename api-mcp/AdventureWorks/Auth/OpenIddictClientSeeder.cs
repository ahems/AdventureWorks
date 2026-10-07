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

            // Trusted first-party apps may request offline_access and redeem refresh tokens so
            // the signed-in user is never prompted again during the session.
            if (_options.TrustedFirstPartyClientIds.Contains(client.ClientId))
            {
                descriptor.Permissions.Add(Permissions.GrantTypes.RefreshToken);
            }

            await appManager.CreateAsync(descriptor, cancellationToken);
            _logger.LogInformation(
                "Registered OAuth client '{ClientId}' with {RedirectCount} redirect URI(s) and {ScopeCount} scope(s).",
                client.ClientId, descriptor.RedirectUris.Count, client.Scopes.Count);
        }

        // Backend workload client (no redirect, token endpoint only) for the managed-identity
        // assertion grant. The assertion itself authenticates the caller.
        if (await appManager.FindByClientIdAsync(AuthorizationServerOptions.ServiceClientId, cancellationToken) is null)
        {
            var serviceDescriptor = new OpenIddictApplicationDescriptor
            {
                ClientId = AuthorizationServerOptions.ServiceClientId,
                ClientType = ClientTypes.Public,
                DisplayName = "AdventureWorks AI Agents (service)",
                Permissions =
                {
                    Permissions.Endpoints.Token,
                    Permissions.Prefixes.GrantType + ManagedIdentityGrant.GrantType,
                },
            };

            foreach (var s in OAuthScopes.All)
            {
                serviceDescriptor.Permissions.Add(Permissions.Prefixes.Scope + s);
            }

            await appManager.CreateAsync(serviceDescriptor, cancellationToken);
            _logger.LogInformation(
                "Registered service client '{ClientId}' (managed-identity grant {Status}).",
                AuthorizationServerOptions.ServiceClientId,
                _options.ServiceGrantEnabled ? "enabled" : "disabled: MCP_ENTRA_TENANT_ID / MCP_TRUSTED_SERVICE_PRINCIPAL_IDS not set");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
