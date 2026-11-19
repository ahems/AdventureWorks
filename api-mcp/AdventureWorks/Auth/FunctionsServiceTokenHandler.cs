using System.Net.Http.Headers;
using System.Security.Claims;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using OpenIddict.Server;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace AdventureWorks.Auth;

/// <summary>Canonical Functions origin to which api-mcp may send service credentials.</summary>
public sealed class FunctionsEndpoint
{
    public Uri Address { get; }

    public FunctionsEndpoint(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value != value.Trim() ||
            value.IndexOfAny(['\\', '?', '#']) >= 0 ||
            !Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            !(uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback) ||
            !string.IsNullOrEmpty(uri.UserInfo))
            throw new InvalidOperationException("API_FUNCTIONS_URL must be an HTTPS origin without credentials, path, query, or fragment; HTTP is allowed only on loopback.");

        var authorityStart = value.IndexOf("://", StringComparison.Ordinal);
        if (authorityStart < 0)
            throw new InvalidOperationException("API_FUNCTIONS_URL must be a canonical origin.");
        authorityStart += 3;
        var pathStart = value.IndexOf('/', authorityStart);
        var authority = pathStart < 0 ? value[authorityStart..] : value[authorityStart..pathStart];
        var path = pathStart < 0 ? "" : value[pathStart..];
        if (authority.Contains('@') || path is not ("" or "/"))
            throw new InvalidOperationException("API_FUNCTIONS_URL must be a canonical origin.");

        Address = new Uri(uri.GetLeftPart(UriPartial.Authority) + "/");
    }

    public bool Contains(Uri? target)
    {
        if (target is null || !target.IsAbsoluteUri || !string.IsNullOrEmpty(target.UserInfo) ||
            !string.IsNullOrEmpty(target.Fragment) || target.OriginalString.Contains('\\'))
            return false;

        var authorityStart = target.OriginalString.IndexOf("://", StringComparison.Ordinal);
        if (authorityStart < 0) return false;
        authorityStart += 3;
        var authorityEnd = target.OriginalString.IndexOfAny(['/', '?', '#'], authorityStart);
        var authority = authorityEnd < 0 ? target.OriginalString[authorityStart..] :
            target.OriginalString[authorityStart..authorityEnd];
        return !authority.Contains('@') &&
               string.Equals(target.Scheme, Address.Scheme, StringComparison.OrdinalIgnoreCase) &&
               string.Equals(target.IdnHost, Address.IdnHost, StringComparison.OrdinalIgnoreCase) &&
               target.Port == Address.Port;
    }
}

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
    private readonly FunctionsEndpoint _endpoint;

    public FunctionsServiceTokenHandler(
        AuthorizationServerOptions options,
        IOptionsMonitor<OpenIddictServerOptions> serverOptions,
        IHttpContextAccessor httpContextAccessor,
        ILogger<FunctionsServiceTokenHandler> logger,
        FunctionsEndpoint endpoint)
    {
        _options = options;
        _serverOptions = serverOptions;
        _httpContextAccessor = httpContextAccessor;
        _logger = logger;
        _endpoint = endpoint;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (!_endpoint.Contains(request.RequestUri) || request.Headers.NonValidated.Contains("Host"))
            throw new InvalidOperationException("Functions service credentials are restricted to the configured endpoint.");
        if (request.Headers.NonValidated.Contains("Authorization"))
            throw new InvalidOperationException("Functions proxy requests cannot supply their own authorization header.");

        var token = CreateToken();
        if (token is not null)
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        return base.SendAsync(request, cancellationToken);
    }

    private string? CreateToken()
    {
        if (string.IsNullOrWhiteSpace(_options.PublicBaseUrl))
        {
            if (_endpoint.Address.IsLoopback)
                return null;
            throw new InvalidOperationException("Functions service authentication requires a configured OAuth issuer.");
        }

        var credentials = _serverOptions.CurrentValue.SigningCredentials.FirstOrDefault();
        if (credentials is null)
        {
            _logger.LogError("No OpenIddict signing credentials are available for the Functions service token.");
            throw new InvalidOperationException("Functions service authentication is unavailable.");
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
