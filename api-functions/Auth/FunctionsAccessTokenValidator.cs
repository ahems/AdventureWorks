using System.Security.Claims;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace ApiFunctions.Auth;

/// <summary>Outcome of validating a bearer token against the api-mcp authorization server.</summary>
/// <param name="Succeeded">True when signature, issuer, audience and lifetime all validated.</param>
/// <param name="Principal">The validated principal (claims) when <paramref name="Succeeded"/> is true.</param>
/// <param name="Error">A short, non-sensitive reason when validation fails.</param>
public sealed record AccessTokenValidationResult(bool Succeeded, ClaimsPrincipal? Principal, string? Error)
{
    public static AccessTokenValidationResult Success(ClaimsPrincipal principal) => new(true, principal, null);

    public static AccessTokenValidationResult Fail(string error) => new(false, null, error);
}

/// <summary>
/// Validates JWT access tokens issued by the self-hosted api-mcp OpenIddict authorization server,
/// treating api-functions as a standalone OAuth resource server. Signing keys (JWKS) and the
/// issuer are discovered from the api-mcp OpenID Connect metadata document and cached/rotated by a
/// <see cref="ConfigurationManager{T}"/>. Signature, issuer, audience, and lifetime are all
/// enforced; the caller additionally checks scope / category / ownership.
/// </summary>
public sealed class FunctionsAccessTokenValidator
{
    private readonly FunctionsOAuthOptions _options;
    private readonly ILogger<FunctionsAccessTokenValidator> _logger;
    private readonly ConfigurationManager<OpenIdConnectConfiguration>? _configurationManager;
    private readonly JsonWebTokenHandler _handler = new();

    public FunctionsAccessTokenValidator(FunctionsOAuthOptions options, ILogger<FunctionsAccessTokenValidator> logger)
    {
        _options = options;
        _logger = logger;

        if (_options.IsConfigured)
        {
            var requireHttps = _options.MetadataAddress!.StartsWith("https", StringComparison.OrdinalIgnoreCase);
            _configurationManager = new ConfigurationManager<OpenIdConnectConfiguration>(
                _options.MetadataAddress!,
                new OpenIdConnectConfigurationRetriever(),
                new HttpDocumentRetriever { RequireHttps = requireHttps });
        }
    }

    /// <summary>Validates a raw bearer token. Returns the principal on success, or a reason on failure.</summary>
    public async Task<AccessTokenValidationResult> ValidateAsync(string token, CancellationToken cancellationToken)
    {
        if (_configurationManager is null)
        {
            return AccessTokenValidationResult.Fail("resource_server_not_configured");
        }

        if (string.IsNullOrWhiteSpace(token))
        {
            return AccessTokenValidationResult.Fail("missing_token");
        }

        OpenIdConnectConfiguration configuration;
        try
        {
            configuration = await _configurationManager.GetConfigurationAsync(cancellationToken);
        }
        catch (Exception ex)
        {
            // Treat a metadata/JWKS fetch failure as a validation failure (fail-closed at the caller).
            _logger.LogWarning(ex, "Failed to retrieve OpenID configuration from {Metadata}", _options.MetadataAddress);
            return AccessTokenValidationResult.Fail("metadata_unavailable");
        }

        var parameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = _options.Issuer,
            ValidateAudience = true,
            ValidAudience = _options.Audience,
            ValidateLifetime = true,
            RequireExpirationTime = true,
            RequireSignedTokens = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKeys = configuration.SigningKeys,
            ClockSkew = _options.ClockSkew,
            NameClaimType = "name",
            RoleClaimType = "role",
        };

        var result = await _handler.ValidateTokenAsync(token, parameters);
        if (!result.IsValid)
        {
            var reason = result.Exception?.GetType().Name ?? "invalid_token";
            _logger.LogInformation("Access token rejected: {Reason}", reason);
            return AccessTokenValidationResult.Fail(reason);
        }

        var principal = new ClaimsPrincipal(result.ClaimsIdentity);
        return AccessTokenValidationResult.Success(principal);
    }
}
