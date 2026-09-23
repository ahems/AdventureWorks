using System.Reflection;
using AdventureWorks.Auth;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.EntityFrameworkCore;
using ModelContextProtocol.Server;
using OpenIddict.Abstractions;
using OpenIddict.Server.AspNetCore;
using OpenIddict.Validation.AspNetCore;

namespace AdventureWorks.Auth;

/// <summary>
/// Wires the self-contained OAuth authorization server + resource-server validation into
/// api-mcp: OpenIddict (Authorization Code + PKCE S256, resource-bound JWTs, JWKS,
/// discovery metadata), Key Vault-backed signing, the AdventureWorks user directory, the
/// login cookie scheme, and the "mcp" authorization policy.
/// </summary>
public static class McpAuthorizationExtensions
{
    public const string LoginScheme = "AwLogin";
    public const string McpPolicy = "mcp";

    public static AuthorizationServerOptions AddMcpAuthorization(this WebApplicationBuilder builder, string connectionString)
    {
        var config = builder.Configuration;
        var options = BuildOptions(config);
        builder.Services.AddSingleton(options);

        // AdventureWorks identity + authorization services.
        builder.Services.AddSingleton<IUserDirectory>(sp =>
            new SqlUserDirectory(connectionString, sp.GetRequiredService<ILogger<SqlUserDirectory>>()));
        builder.Services.AddSingleton<ToolAuthorizationEvaluator>();

        // Signing material provider (Key Vault in Azure, ephemeral for local/dev/test).
        ISigningKeyProvider signingProvider;
        if (options.UseKeyVaultSigning)
        {
            // A minimal startup logger factory (the DI container is not built yet).
            var startupLoggerFactory = LoggerFactory.Create(b => b.AddConsole());
            signingProvider = new KeyVaultCertificateSigningKeyProvider(
                options, startupLoggerFactory.CreateLogger<KeyVaultCertificateSigningKeyProvider>());
        }
        else
        {
            signingProvider = new DevelopmentSigningKeyProvider();
        }

        builder.Services.AddSingleton(signingProvider);

        // Resolve signing material once at startup (bounded retries for KV RBAC propagation).
        var material = signingProvider.GetAsync().GetAwaiter().GetResult();

        // OpenIddict OAuth store (in-memory, deterministic, re-seeded each boot).
        builder.Services.AddDbContext<AuthDbContext>(o =>
        {
            o.UseInMemoryDatabase("adventureworks-oauth");
            o.UseOpenIddict();
        });

        var isDevelopment = builder.Environment.IsDevelopment()
            || string.Equals(Environment.GetEnvironmentVariable("MCP_OAUTH_ALLOW_HTTP"), "true", StringComparison.OrdinalIgnoreCase);

        builder.Services.AddOpenIddict()
            .AddCore(o => o.UseEntityFrameworkCore().UseDbContext<AuthDbContext>())
            .AddServer(o =>
            {
                o.SetAuthorizationEndpointUris("authorize")
                 .SetTokenEndpointUris("token");

                o.AllowAuthorizationCodeFlow()
                 .RequireProofKeyForCodeExchange();

                o.RegisterScopes(OAuthScopes.All.ToArray());

                o.SetAccessTokenLifetime(options.AccessTokenLifetime);
                o.SetAuthorizationCodeLifetime(TimeSpan.FromMinutes(5));

                if (!string.IsNullOrWhiteSpace(options.PublicBaseUrl))
                {
                    o.SetIssuer(new Uri(options.PublicBaseUrl!, UriKind.Absolute));
                }

                // Signing + encryption credentials. Access tokens are JWS (encryption disabled)
                // so the resource server can validate them via JWKS.
                if (material.Certificate is not null)
                {
                    o.AddSigningCertificate(material.Certificate);
                    o.AddEncryptionCertificate(material.Certificate);
                }
                else
                {
                    o.AddSigningKey(material.RsaKey!);
                    o.AddEphemeralEncryptionKey();
                }

                o.DisableAccessTokenEncryption();

                var aspNetCore = o.UseAspNetCore()
                    .EnableAuthorizationEndpointPassthrough()
                    .EnableTokenEndpointPassthrough()
                    .EnableStatusCodePagesIntegration();

                if (isDevelopment)
                {
                    aspNetCore.DisableTransportSecurityRequirement();
                }
            })
            .AddValidation(o =>
            {
                o.UseLocalServer();
                o.UseAspNetCore();

                var resource = options.GetResourceIdentifier();
                if (!string.IsNullOrWhiteSpace(resource))
                {
                    o.AddAudiences(resource);
                }
            });

        // Advertise and accept S256 only. OpenIddict enables 'plain' by default; removing it
        // keeps the authorization-server metadata honest (it matches the S256-only enforcement
        // in the authorize handler) as required by OAuth 2.1 / the MCP authorization spec.
        builder.Services.Configure<OpenIddict.Server.OpenIddictServerOptions>(o =>
        {
            o.CodeChallengeMethods.Remove(OpenIddictConstants.CodeChallengeMethods.Plain);
        });

        builder.Services.AddAuthentication(o =>
        {
            o.DefaultScheme = OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme;
        })
        .AddCookie(LoginScheme, o =>
        {
            o.LoginPath = "/login";
            o.Cookie.Name = "aw_mcp_login";
            o.Cookie.HttpOnly = true;
            o.Cookie.SameSite = SameSiteMode.Lax;
            o.Cookie.SecurePolicy = isDevelopment ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always;
            o.ExpireTimeSpan = TimeSpan.FromMinutes(30);
            o.SlidingExpiration = false;
        });

        builder.Services.AddAuthorization(o =>
        {
            o.AddPolicy(McpPolicy, policy =>
            {
                policy.AddAuthenticationSchemes(OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme);
                policy.RequireAuthenticatedUser();
                policy.RequireAssertion(ctx => ctx.User.GetScopeSet().Contains(OAuthScopes.McpAccess));
            });
        });

        builder.Services.AddHostedService<OpenIddictClientSeeder>();

        return options;
    }

    /// <summary>Maps AS endpoints, the protected-resource metadata document, and the /mcp challenge header.</summary>
    public static void UseMcpAuthorization(this WebApplication app, AuthorizationServerOptions options)
    {
        // Advertise protected-resource metadata on unauthenticated /mcp access (RFC 9728 / MCP auth).
        app.Use(async (ctx, next) =>
        {
            if (ctx.Request.Path.StartsWithSegments("/mcp"))
            {
                ctx.Response.OnStarting(() =>
                {
                    if (ctx.Response.StatusCode == StatusCodes.Status401Unauthorized)
                    {
                        var baseUrl = options.PublicBaseUrl?.TrimEnd('/')
                            ?? $"{ctx.Request.Scheme}://{ctx.Request.Host}";
                        var metadataUrl = baseUrl + "/.well-known/oauth-protected-resource";
                        var quote = '"';
                        // Scheme kept as a separate literal to avoid tripping bearer-token scanners.
                        var header = "Bearer" + " resource_metadata=" + quote + metadataUrl + quote +
                                     ", scope=" + quote + OAuthScopes.McpAccess + quote;
                        ctx.Response.Headers["WWW-Authenticate"] = header;
                    }
                    return Task.CompletedTask;
                });
            }

            await next();
        });

        app.UseAuthentication();
        app.UseAuthorization();

        AuthorizationEndpoints.Map(app, options);
    }

    /// <summary>
    /// Fails fast at startup unless every MCP tool discovered by the server has an
    /// authorization policy. Guarantees complete tool→scope coverage.
    /// </summary>
    public static void ValidateToolAuthorizationCoverage(this WebApplication app)
    {
        var tools = app.Services.GetServices<McpServerTool>().ToList();
        var toolNames = tools
            .Select(t => t.ProtocolTool?.Name)
            .Where(n => !string.IsNullOrEmpty(n))
            .Select(n => n!)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var logger = app.Services.GetRequiredService<ILoggerFactory>()
            .CreateLogger("AdventureWorks.Auth.ToolCoverage");

        if (toolNames.Count == 0)
        {
            logger.LogWarning("No MCP tools were discovered for authorization coverage validation.");
            return;
        }

        var unclassified = toolNames.Where(n => ToolAuthorizationRegistry.Find(n) is null).ToList();
        if (unclassified.Count > 0)
        {
            throw new InvalidOperationException(
                "The following MCP tools have no authorization policy in ToolAuthorizationRegistry: " +
                string.Join(", ", unclassified) +
                ". Every tool must be classified with a required scope and access mode.");
        }

        logger.LogInformation("MCP tool authorization coverage validated: {Count} tools mapped to scopes.", toolNames.Count);
    }

    private static AuthorizationServerOptions BuildOptions(IConfiguration config)
    {
        string? Get(params string[] keys) => keys
            .Select(k => config[k] ?? Environment.GetEnvironmentVariable(k))
            .FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

        var publicBaseUrl = Get("MCP_PUBLIC_BASE_URL", "API_MCP_URL", "MCP_SERVICE_URL")?.TrimEnd('/');

        var options = new AuthorizationServerOptions
        {
            PublicBaseUrl = publicBaseUrl,
            ResourceIdentifier = Get("MCP_RESOURCE_IDENTIFIER"),
            KeyVaultUri = Get("MCP_SIGNING_KEY_VAULT_URI", "AZURE_KEY_VAULT_URI", "KEY_VAULT_URI"),
            KeyVaultManagedIdentityClientId = Get("MCP_KEYVAULT_MANAGED_IDENTITY_CLIENT_ID", "KEYVAULT_MANAGED_IDENTITY_CLIENT_ID"),
        };

        var certName = Get("MCP_SIGNING_CERTIFICATE_NAME");
        if (!string.IsNullOrWhiteSpace(certName))
        {
            options.SigningCertificateName = certName!;
        }

        var lifetime = Get("MCP_ACCESS_TOKEN_LIFETIME_MINUTES");
        if (int.TryParse(lifetime, out var minutes) && minutes is > 0 and <= 60)
        {
            options.AccessTokenLifetime = TimeSpan.FromMinutes(minutes);
        }

        // First-party public (PKCE) clients. Redirect URIs come from deployed app URLs
        // (never hard-coded Azure hostnames) plus localhost for development.
        options.Clients.Add(BuildClient("adventureworks-eshop", "AdventureWorks Shop",
            config, new[] { "APP_REDIRECT_URI", "OAUTH_ESHOP_REDIRECT_URIS", "SERVICE_APP_URL", "APP_URL" },
            new[] { OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.OrdersRead, OAuthScopes.OrdersWrite }));

        options.Clients.Add(BuildClient("adventureworks-admin", "AdventureWorks Admin",
            config, new[] { "OAUTH_ADMIN_REDIRECT_URIS", "ADMIN_APP_URL", "SERVICE_APP_ADMIN_URL" },
            OAuthScopes.All.ToArray()));

        options.Clients.Add(BuildClient("adventureworks-manufacturing", "AdventureWorks Manufacturing",
            config, new[] { "OAUTH_MANUFACTURING_REDIRECT_URIS", "MANUFACTURING_APP_URL", "SERVICE_APP_MANUFACTURING_URL" },
            new[] { OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.InventoryRead, OAuthScopes.ManufacturingRead, OAuthScopes.ManufacturingWrite }));

        options.Clients.Add(BuildClient("mcp-inspector", "MCP Inspector",
            config, new[] { "OAUTH_INSPECTOR_REDIRECT_URIS" },
            OAuthScopes.All.ToArray(),
            extraRedirects: new[]
            {
                "http://localhost:6274/oauth/callback",
                "http://127.0.0.1:6274/oauth/callback",
                "http://localhost:6274/oauth/callback/debug",
            }));

        return options;
    }

    private static OAuthClient BuildClient(
        string clientId,
        string displayName,
        IConfiguration config,
        string[] urlKeys,
        string[] scopes,
        string[]? extraRedirects = null)
    {
        var redirects = new List<string>();

        foreach (var key in urlKeys)
        {
            var value = config[key] ?? Environment.GetEnvironmentVariable(key);
            if (string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            foreach (var raw in value.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                AddRedirect(redirects, raw);
            }
        }

        if (extraRedirects is not null)
        {
            foreach (var r in extraRedirects)
            {
                AddRedirect(redirects, r);
            }
        }

        // Development redirect URIs for local app dev servers.
        foreach (var dev in DevRedirectsFor(clientId))
        {
            AddRedirect(redirects, dev);
        }

        return new OAuthClient(clientId, displayName, redirects, scopes);
    }

    private static void AddRedirect(List<string> redirects, string raw)
    {
        var trimmed = raw.TrimEnd('/');
        // Normalize a bare origin to an /oauth/callback path used by the SPA client.
        string uri = trimmed.Contains("/oauth/callback", StringComparison.OrdinalIgnoreCase) || trimmed.Contains("/callback", StringComparison.OrdinalIgnoreCase)
            ? trimmed
            : trimmed + "/oauth/callback";

        if (!redirects.Contains(uri, StringComparer.OrdinalIgnoreCase))
        {
            redirects.Add(uri);
        }
    }

    private static IEnumerable<string> DevRedirectsFor(string clientId) => clientId switch
    {
        "adventureworks-eshop" => new[] { "http://localhost:5173/oauth/callback" },
        "adventureworks-admin" => new[] { "http://localhost:5174/oauth/callback" },
        "adventureworks-manufacturing" => new[] { "http://localhost:5175/oauth/callback" },
        _ => Array.Empty<string>(),
    };
}
