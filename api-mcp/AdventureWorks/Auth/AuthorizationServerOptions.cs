namespace AdventureWorks.Auth;

/// <summary>A first-party OAuth client (public, PKCE) registered at startup.</summary>
/// <param name="ClientId">Stable client identifier.</param>
/// <param name="DisplayName">Human-readable name shown on the consent page.</param>
/// <param name="RedirectUris">Exact redirect URIs (no wildcards).</param>
/// <param name="Scopes">Scopes the client is permitted to request.</param>
public sealed record OAuthClient(string ClientId, string DisplayName, IReadOnlyList<string> RedirectUris, IReadOnlyList<string> Scopes);

/// <summary>
/// Deployment-derived configuration for the self-contained authorization server.
/// Issuer, resource and redirect URIs come from configuration / environment
/// (never hard-coded Azure hostnames).
/// </summary>
public sealed class AuthorizationServerOptions
{
    /// <summary>
    /// Public HTTPS base URL of api-mcp, e.g. https://av-api-mcp-xxx.azurecontainerapps.io.
    /// Used as the OAuth issuer. Falls back to the request base in development.
    /// </summary>
    public string? PublicBaseUrl { get; set; }

    /// <summary>
    /// Canonical MCP protected-resource identifier (RFC 8707 resource indicator).
    /// Defaults to <c>{PublicBaseUrl}/mcp</c>.
    /// </summary>
    public string? ResourceIdentifier { get; set; }

    /// <summary>
    /// Canonical Data API Builder (DAB) protected-resource identifier (RFC 8707 resource
    /// indicator). The DAB GraphQL/REST API validates access tokens whose <c>aud</c> equals
    /// this value. Defaults to <c>{PublicBaseUrl}/dab</c>; override with
    /// <c>DAB_RESOURCE_IDENTIFIER</c> (e.g. the deployed DAB app URL). Never a hard-coded
    /// Azure hostname.
    /// </summary>
    public string? DabResourceIdentifier { get; set; }

    /// <summary>
    /// Canonical Azure Functions (api-functions) protected-resource identifier (RFC 8707
    /// resource indicator). The Functions API validates access tokens whose <c>aud</c> equals
    /// this value. Defaults to <c>{PublicBaseUrl}/functions</c>; override with
    /// <c>FUNCTIONS_RESOURCE_IDENTIFIER</c>. Never a hard-coded Azure hostname.
    /// </summary>
    public string? FunctionsResourceIdentifier { get; set; }

    /// <summary>Access token lifetime. Short-lived per the demo design (~10 minutes).</summary>
    public TimeSpan AccessTokenLifetime { get; set; } = TimeSpan.FromMinutes(10);

    /// <summary>
    /// Refresh token lifetime (absolute; sliding expiration is disabled). Refresh tokens are only
    /// issued to trusted first-party clients that request <c>offline_access</c>, so a signed-in
    /// employee keeps working silently for this long without re-entering credentials.
    /// </summary>
    public TimeSpan RefreshTokenLifetime { get; set; } = TimeSpan.FromHours(12);

    /// <summary>Registered first-party clients.</summary>
    public List<OAuthClient> Clients { get; } = new();

    /// <summary>
    /// First-party AdventureWorks clients whose users have already authenticated against the
    /// AdventureWorks login. The consent page is skipped for these (the grant is still
    /// restricted to the user's role-derived scopes) and they may request <c>offline_access</c>.
    /// Third-party clients such as the MCP Inspector always see the consent page.
    /// </summary>
    public HashSet<string> TrustedFirstPartyClientIds { get; } = new(StringComparer.Ordinal)
    {
        "adventureworks-admin",
        "adventureworks-eshop",
        "adventureworks-manufacturing",
    };

    // ---- Service (workload) tokens via managed-identity assertion ----

    /// <summary>Client id used by backend workloads for the managed-identity assertion grant.</summary>
    public const string ServiceClientId = "adventureworks-agents";

    /// <summary>
    /// Entra tenant id whose managed-identity tokens (audience <c>api://AzureADTokenExchange</c>)
    /// may be exchanged for a service MCP token. Empty disables the grant.
    /// </summary>
    public string? EntraTenantId { get; set; }

    /// <summary>
    /// Allow-list of Entra object ids (managed identity principal ids) permitted to obtain a
    /// service MCP token. Empty disables the grant.
    /// </summary>
    public HashSet<string> TrustedServicePrincipalIds { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Whether the managed-identity assertion grant is configured.</summary>
    public bool ServiceGrantEnabled =>
        !string.IsNullOrWhiteSpace(EntraTenantId) && TrustedServicePrincipalIds.Count > 0;

    // ---- Key Vault signing material ----

    /// <summary>Key Vault URI (https://{vault}.vault.azure.net/). When set, the signing certificate is read from Key Vault.</summary>
    public string? KeyVaultUri { get; set; }

    /// <summary>Name of the signing certificate/secret in Key Vault.</summary>
    public string SigningCertificateName { get; set; } = "mcp-signing";

    /// <summary>
    /// Client id of the user-assigned managed identity that has Key Vault access.
    /// Used to construct a dedicated <c>ManagedIdentityCredential</c> for the vault,
    /// independent of the shared credential used for SQL/OpenAI.
    /// </summary>
    public string? KeyVaultManagedIdentityClientId { get; set; }

    /// <summary>Whether Key Vault-backed signing is configured.</summary>
    public bool UseKeyVaultSigning => !string.IsNullOrWhiteSpace(KeyVaultUri);

    /// <summary>Resolves the canonical resource identifier.</summary>
    public string GetResourceIdentifier()
    {
        if (!string.IsNullOrWhiteSpace(ResourceIdentifier))
        {
            return ResourceIdentifier!.TrimEnd('/');
        }

        if (!string.IsNullOrWhiteSpace(PublicBaseUrl))
        {
            return PublicBaseUrl!.TrimEnd('/') + "/mcp";
        }

        return "urn:adventureworks:mcp";
    }

    /// <summary>
    /// Resolves the canonical DAB resource identifier (the <c>aud</c> of DAB-bound tokens).
    /// </summary>
    public string GetDabResourceIdentifier()
    {
        if (!string.IsNullOrWhiteSpace(DabResourceIdentifier))
        {
            return DabResourceIdentifier!.TrimEnd('/');
        }

        if (!string.IsNullOrWhiteSpace(PublicBaseUrl))
        {
            return PublicBaseUrl!.TrimEnd('/') + "/dab";
        }

        return "urn:adventureworks:dab";
    }

    /// <summary>
    /// Resolves the canonical Functions resource identifier (the <c>aud</c> of Functions-bound
    /// tokens).
    /// </summary>
    public string GetFunctionsResourceIdentifier()
    {
        if (!string.IsNullOrWhiteSpace(FunctionsResourceIdentifier))
        {
            return FunctionsResourceIdentifier!.TrimEnd('/');
        }

        if (!string.IsNullOrWhiteSpace(PublicBaseUrl))
        {
            return PublicBaseUrl!.TrimEnd('/') + "/functions";
        }

        return "urn:adventureworks:functions";
    }

    /// <summary>
    /// Allow-list of resource identifiers the authorization server will bind tokens to
    /// (RFC 8707 <c>resource</c> targets). A request may target at most one of these; an
    /// unknown target is rejected with <c>invalid_target</c>.
    /// </summary>
    public IReadOnlyList<string> AllowedResources() => new[]
    {
        GetResourceIdentifier(),
        GetDabResourceIdentifier(),
        GetFunctionsResourceIdentifier(),
    };
}
