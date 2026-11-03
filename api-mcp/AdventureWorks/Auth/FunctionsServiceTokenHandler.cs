using System.Net.Http.Headers;
using System.Security.Claims;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using OpenIddict.Server;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace AdventureWorks.Auth;

/// <summary>
/// Attaches a short-lived, Functions-audience service token to every api-mcp → api-functions
/// call (manufacturing, supply chain, bank/financials, simulators).
///
/// api-mcp is itself the authorization server, so it signs the token with its own OpenIddict
/// signing key; api-functions validates it exactly like any other token from this issuer. The
/// caller's per-tool scope was already enforced by <see cref="McpToolAuthorizationFilter"/>
/// before the tool ran, so the service token only carries the scopes the proxied routes need.
/// The signed-in user's subject (when known) is recorded as <c>obo_sub</c> for audit only.
/// </summary>
public sealed class FunctionsServiceTokenHandler : DelegatingHandler
{
    public const string Subject = "service:api-mcp";

    /// <summary>Scopes required by the Functions routes that MCP tools proxy.</summary>
    public static readonly string[] ServiceScopes =
    {
        OAuthScopes.ManufacturingRead,
        OAuthScopes.ManufacturingWrite,
        OAuthScopes.InventoryRead,
        OAuthScopes.SalesRead,
        OAuthScopes.AdminRead,
        OAuthScopes.AdminWrite,
    };

    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private static readonly JsonWebTokenHandler Handler = new();

    private readonly AuthorizationServerOptions _options;
    private readonly IOptionsMonitor<OpenIddictServerOptions> _serverOptions;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly ILogger<FunctionsServiceTokenHandler> _logger;

    public FunctionsServiceTokenHandler(
        AuthorizationServerOptions options,
        IOptionsMonitor<OpenIddictServerOptions> serverOptions,
        IHttpContextAccessor httpContextAccessor,
        ILogger<FunctionsServiceTokenHandler> logger)
    {
        _options = options;
        _serverOptions = serverOptions;
        _httpContextAccessor = httpContextAccessor;
        _logger = logger;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.Headers.Authorization is null)
        {
            var token = CreateToken();
            if (token is not null)
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            }
        }

        return base.SendAsync(request, cancellationToken);
    }

    private string? CreateToken()
    {
        if (string.IsNullOrWhiteSpace(_options.PublicBaseUrl))
        {
            // Local development without a public issuer: Functions runs with OAuth disabled.
            return null;
        }

        var credentials = _serverOptions.CurrentValue.SigningCredentials.FirstOrDefault();
        if (credentials is null)
        {
            _logger.LogWarning("No OpenIddict signing credentials available; calling api-functions without a service token.");
            return null;
        }

        var now = DateTime.UtcNow;
        var claims = new Dictionary<string, object>
        {
            [Claims.Subject] = Subject,
            [Claims.Name] = "AdventureWorks MCP server",
            [AwClaims.Category] = UserCategories.Service,
            [AwClaims.Application] = "adventureworks-mcp",
            [Claims.Scope] = string.Join(' ', ServiceScopes),
            [Claims.JwtId] = Guid.NewGuid().ToString("N"),
        };

        var onBehalfOf = _httpContextAccessor.HttpContext?.User?.FindFirst(Claims.Subject)?.Value;
        if (!string.IsNullOrEmpty(onBehalfOf))
        {
            claims["obo_sub"] = onBehalfOf;
        }

        return Handler.CreateToken(new SecurityTokenDescriptor
        {
            Issuer = _options.PublicBaseUrl!.TrimEnd('/') + "/",
            Audience = _options.GetFunctionsResourceIdentifier(),
            IssuedAt = now,
            NotBefore = now,
            Expires = now.Add(Lifetime),
            Claims = claims,
            SigningCredentials = credentials,
            TokenType = "at+jwt",
        });
    }
}
