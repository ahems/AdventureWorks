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

    /// <summary>Access token lifetime. Short-lived per the demo design (~10 minutes).</summary>
    public TimeSpan AccessTokenLifetime { get; set; } = TimeSpan.FromMinutes(10);

    /// <summary>Registered first-party clients.</summary>
    public List<OAuthClient> Clients { get; } = new();

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
}
