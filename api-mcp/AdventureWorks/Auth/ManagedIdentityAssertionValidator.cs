using System.Security.Claims;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace AdventureWorks.Auth;

/// <summary>Result of validating a workload (managed identity) assertion.</summary>
/// <param name="ObjectId">Entra object id (principal id) of the managed identity.</param>
public sealed record ServiceAssertion(string ObjectId);

/// <summary>
/// Validates an Entra-issued managed-identity token presented as an assertion at the token
/// endpoint (custom grant <see cref="ManagedIdentityGrant.GrantType"/>). Lets a trusted backend
/// workload (api-functions) obtain a short-lived MCP service token for Foundry agent tool calls
/// without any shared secret.
/// </summary>
public interface IServiceAssertionValidator
{
    /// <summary>Returns the validated identity, or <c>null</c> when the assertion is not acceptable.</summary>
    Task<ServiceAssertion?> ValidateAsync(string assertion, CancellationToken cancellationToken);
}

/// <summary>Custom grant constants.</summary>
public static class ManagedIdentityGrant
{
    public const string GrantType = "urn:adventureworks:params:oauth:grant-type:managed-identity";

    /// <summary>Well-known app id of the Entra token-exchange resource (api://AzureADTokenExchange).</summary>
    public const string TokenExchangeAudience = "fb60f99c-7a34-4190-8149-302f77469936";
}

/// <summary>
/// Validates the assertion signature against the tenant's Entra JWKS (cached), then issuer,
/// audience (<c>api://AzureADTokenExchange</c>), lifetime and the object-id allow-list.
/// </summary>
public sealed class EntraManagedIdentityAssertionValidator : IServiceAssertionValidator
{
    private static readonly TimeSpan KeyCacheLifetime = TimeSpan.FromHours(12);
    private static readonly TimeSpan MinRefreshInterval = TimeSpan.FromMinutes(5);

    private readonly AuthorizationServerOptions _options;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<EntraManagedIdentityAssertionValidator> _logger;
    private readonly JsonWebTokenHandler _handler = new();
    private readonly SemaphoreSlim _keysLock = new(1, 1);

    private JsonWebKeySet? _keys;
    private DateTimeOffset _keysFetchedAt = DateTimeOffset.MinValue;

    public EntraManagedIdentityAssertionValidator(
        AuthorizationServerOptions options,
        IHttpClientFactory httpClientFactory,
        ILogger<EntraManagedIdentityAssertionValidator> logger)
    {
        _options = options;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<ServiceAssertion?> ValidateAsync(string assertion, CancellationToken cancellationToken)
    {
        if (!_options.ServiceGrantEnabled || string.IsNullOrWhiteSpace(assertion))
        {
            return null;
        }

        var result = await ValidateWithKeysAsync(assertion, forceRefresh: false, cancellationToken);
        if (result is { IsValid: false, Exception: SecurityTokenSignatureKeyNotFoundException })
        {
            // Entra rotated its signing keys since the last fetch.
            result = await ValidateWithKeysAsync(assertion, forceRefresh: true, cancellationToken);
        }

        if (result is null || !result.IsValid)
        {
            _logger.LogWarning(result?.Exception, "Managed-identity assertion rejected: token validation failed.");
            return null;
        }

        var oid = result.ClaimsIdentity.FindFirst("oid")?.Value
            ?? result.ClaimsIdentity.FindFirst("http://schemas.microsoft.com/identity/claims/objectidentifier")?.Value;
        if (string.IsNullOrWhiteSpace(oid) || !_options.TrustedServicePrincipalIds.Contains(oid))
        {
            _logger.LogWarning("Managed-identity assertion rejected: object id {ObjectId} is not trusted.", oid ?? "(none)");
            return null;
        }

        return new ServiceAssertion(oid);
    }

    private async Task<TokenValidationResult?> ValidateWithKeysAsync(string assertion, bool forceRefresh, CancellationToken ct)
    {
        var keys = await GetKeysAsync(forceRefresh, ct);
        if (keys is null)
        {
            return null;
        }

        var tenant = _options.EntraTenantId!.Trim();
        var parameters = new TokenValidationParameters
        {
            ValidIssuers = new[]
            {
                $"https://login.microsoftonline.com/{tenant}/v2.0",
                $"https://sts.windows.net/{tenant}/",
            },
            ValidAudiences = new[] { ManagedIdentityGrant.TokenExchangeAudience, "api://AzureADTokenExchange" },
            IssuerSigningKeys = keys.GetSigningKeys(),
            ValidateIssuerSigningKey = true,
            RequireSignedTokens = true,
            RequireExpirationTime = true,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(2),
        };

        return await _handler.ValidateTokenAsync(assertion, parameters);
    }

    private async Task<JsonWebKeySet?> GetKeysAsync(bool forceRefresh, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var age = now - _keysFetchedAt;
        if (_keys is not null && age < KeyCacheLifetime && (!forceRefresh || age < MinRefreshInterval))
        {
            return _keys;
        }

        await _keysLock.WaitAsync(ct);
        try
        {
            age = DateTimeOffset.UtcNow - _keysFetchedAt;
            if (_keys is not null && age < KeyCacheLifetime && (!forceRefresh || age < MinRefreshInterval))
            {
                return _keys;
            }

            var url = $"https://login.microsoftonline.com/{Uri.EscapeDataString(_options.EntraTenantId!.Trim())}/discovery/v2.0/keys";
            var client = _httpClientFactory.CreateClient(nameof(EntraManagedIdentityAssertionValidator));
            var json = await client.GetStringAsync(url, ct);
            _keys = new JsonWebKeySet(json);
            _keysFetchedAt = DateTimeOffset.UtcNow;
            return _keys;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or ArgumentException)
        {
            _logger.LogError(ex, "Failed to fetch Entra signing keys for managed-identity assertion validation.");
            return _keys;
        }
        finally
        {
            _keysLock.Release();
        }
    }
}
