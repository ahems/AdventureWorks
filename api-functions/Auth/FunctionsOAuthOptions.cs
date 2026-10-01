using Microsoft.Extensions.Configuration;

namespace ApiFunctions.Auth;

/// <summary>Enforcement posture for Functions OAuth, controlled by <c>FUNCTIONS_OAUTH_MODE</c>.</summary>
public enum OAuthEnforcementMode
{
    /// <summary>
    /// No enforcement — every route behaves as it did before OAuth (anonymous). Default, so a
    /// partial rollout (resource server deployed before the frontends attach tokens, or before the
    /// issuer/JWKS are wired by infra) never breaks the demo.
    /// </summary>
    Disabled,

    /// <summary>
    /// Validate tokens when present and emit structured allow/deny telemetry, but never block —
    /// a safe shadow mode to observe behavior before turning on enforcement.
    /// </summary>
    Audit,

    /// <summary>Full enforcement — protected routes require a valid, in-audience, correctly-scoped token.</summary>
    Enforced,
}

/// <summary>
/// Deployment-derived configuration for the api-functions resource server. All values come from
/// configuration / environment (never hard-coded Azure hostnames); when the issuer or audience is
/// absent the resource server stays in <see cref="OAuthEnforcementMode.Disabled"/> so local and
/// not-yet-wired deployments keep working unchanged.
/// </summary>
public sealed class FunctionsOAuthOptions
{
    /// <summary>OAuth issuer — the api-mcp public base URL (also the token <c>iss</c>).</summary>
    public string? Issuer { get; init; }

    /// <summary>
    /// Expected token audience — the Functions resource identifier (<c>{issuer}/functions</c> by
    /// default; overridable with <c>FUNCTIONS_RESOURCE_IDENTIFIER</c> to match the api-mcp AS).
    /// </summary>
    public string? Audience { get; init; }

    /// <summary>OpenID Connect metadata address used to discover signing keys (JWKS) and the issuer.</summary>
    public string? MetadataAddress { get; init; }

    /// <summary>Resolved enforcement posture.</summary>
    public OAuthEnforcementMode Mode { get; init; } = OAuthEnforcementMode.Disabled;

    /// <summary>Clock skew tolerated during lifetime validation.</summary>
    public TimeSpan ClockSkew { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>True when an issuer, audience and metadata address are all present.</summary>
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(Issuer)
        && !string.IsNullOrWhiteSpace(Audience)
        && !string.IsNullOrWhiteSpace(MetadataAddress);

    /// <summary>
    /// Builds options from configuration/environment. Issuer, audience and metadata are derived
    /// from the deployed api-mcp URL; the enforcement mode defaults to <c>Disabled</c> unless
    /// explicitly set AND the issuer/audience are configured.
    /// </summary>
    public static FunctionsOAuthOptions FromConfiguration(IConfiguration config)
    {
        string? Get(params string[] keys) => keys
            .Select(k => config[k] ?? Environment.GetEnvironmentVariable(k))
            .FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim();

        var issuer = Get("FUNCTIONS_JWT_ISSUER", "API_MCP_URL", "MCP_PUBLIC_BASE_URL", "MCP_SERVICE_URL")?.TrimEnd('/');

        // Audience = the Functions resource identifier. Default to {issuer}/functions so it matches
        // AuthorizationServerOptions.GetFunctionsResourceIdentifier() on the api-mcp side.
        var audience = Get("FUNCTIONS_JWT_AUDIENCE", "FUNCTIONS_RESOURCE_IDENTIFIER")?.TrimEnd('/');
        if (string.IsNullOrWhiteSpace(audience) && !string.IsNullOrWhiteSpace(issuer))
        {
            audience = issuer + "/functions";
        }

        var metadata = Get("FUNCTIONS_JWT_METADATA_ADDRESS");
        if (string.IsNullOrWhiteSpace(metadata) && !string.IsNullOrWhiteSpace(issuer))
        {
            metadata = issuer + "/.well-known/openid-configuration";
        }

        var requested = ParseMode(Get("FUNCTIONS_OAUTH_MODE"));

        // Can only enforce/audit when we actually have an issuer + audience + metadata to validate
        // against; otherwise stay disabled (fail-open to current anonymous behavior).
        var configured = !string.IsNullOrWhiteSpace(issuer)
            && !string.IsNullOrWhiteSpace(audience)
            && !string.IsNullOrWhiteSpace(metadata);
        var mode = configured ? requested : OAuthEnforcementMode.Disabled;

        return new FunctionsOAuthOptions
        {
            Issuer = issuer,
            Audience = audience,
            MetadataAddress = metadata,
            Mode = mode,
        };
    }

    private static OAuthEnforcementMode ParseMode(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "enforced" or "enforce" or "on" or "true" => OAuthEnforcementMode.Enforced,
        "audit" or "shadow" => OAuthEnforcementMode.Audit,
        _ => OAuthEnforcementMode.Disabled,
    };
}
