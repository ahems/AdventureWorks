using System.Collections.Concurrent;
using System.Text.Json;
using Azure.Core;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

/// <summary>
/// Obtains a short-lived, explicitly scoped api-mcp service access token for backend AI agent
/// tool calls that run without a delegated end-user token (e.g. customer/order generation).
///
/// Flow: the Function App's user-assigned managed identity requests an Entra token for the
/// federated-credential audience <c>api://AzureADTokenExchange</c>, then presents it to the
/// api-mcp authorization server using the custom managed-identity assertion grant. api-mcp
/// validates the Entra signature and checks the identity's object ID against its allowlist
/// before issuing an MCP-resource token. No secrets are stored anywhere.
/// </summary>
public class McpServiceTokenProvider
{
    public const string GrantType = "urn:adventureworks:params:oauth:grant-type:managed-identity";
    public const string ClientId = "adventureworks-agents";
    public const string McpAccessScope = "mcp.access";
    public const string ProductsReadScope = "products.read";
    public const string CustomersReadScope = "customers.read";
    public const string InventoryReadScope = "inventory.read";
    public const string OrdersReadScope = "orders.read";
    public const string AdminWriteScope = "admin.write";
    public const string ManufacturingReadScope = "manufacturing.read";
    public const string ManufacturingWriteScope = "manufacturing.write";
    private const string AssertionScope = "api://AzureADTokenExchange/.default";
    private static readonly TimeSpan RefreshSkew = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan FailureBackoff = TimeSpan.FromSeconds(30);

    private readonly TokenCredential _credential;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<McpServiceTokenProvider> _logger;
    private readonly Uri? _mcpEndpoint;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private readonly ConcurrentDictionary<string, (string Token, DateTimeOffset ExpiresOn)> _tokens = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _retryAfter = new(StringComparer.Ordinal);

    public McpServiceTokenProvider(
        TokenCredential credential,
        IHttpClientFactory httpClientFactory,
        ILogger<McpServiceTokenProvider> logger,
        string mcpServiceUrl)
    {
        _credential = credential;
        _httpClientFactory = httpClientFactory;
        _logger = logger;

        if (TryParseEndpoint(mcpServiceUrl, out var uri))
        {
            _mcpEndpoint = uri;
            McpOrigin = uri.GetLeftPart(UriPartial.Authority);
        }
        else if (!string.IsNullOrEmpty(mcpServiceUrl))
            _logger.LogError("MCP_SERVICE_URL must be a canonical HTTPS endpoint without credentials, query, or fragment; HTTP is allowed only on loopback.");
    }

    /// <summary>Origin of the api-mcp server (scheme://host[:port]); null when not configured.</summary>
    public string? McpOrigin { get; }

    /// <summary>The MCP resource identifier (audience) requested for service tokens.</summary>
    public string? ResourceIdentifier => McpOrigin is null ? null : McpOrigin + "/mcp";

    /// <summary>True only for the configured api-mcp endpoint, including its path.</summary>
    public bool IsMcpServer(string? serverUrl) =>
        _mcpEndpoint is not null && MatchesEndpoint(_mcpEndpoint, serverUrl);

    internal static bool MatchesEndpoint(string? configuredUrl, string? serverUrl) =>
        TryParseEndpoint(configuredUrl, out var endpoint) && MatchesEndpoint(endpoint, serverUrl);

    private static bool MatchesEndpoint(Uri configured, string? serverUrl)
    {
        if (!TryParseEndpoint(serverUrl, out var target))
            return false;

        static string PathWithoutFinalSlash(Uri uri) =>
            uri.AbsolutePath.Length > 1 && uri.AbsolutePath.EndsWith('/')
                ? uri.AbsolutePath[..^1]
                : uri.AbsolutePath;

        return string.Equals(configured.Scheme, target.Scheme, StringComparison.OrdinalIgnoreCase) &&
               string.Equals(configured.IdnHost, target.IdnHost, StringComparison.OrdinalIgnoreCase) &&
               configured.Port == target.Port &&
               string.Equals(PathWithoutFinalSlash(configured), PathWithoutFinalSlash(target), StringComparison.Ordinal);
    }

    private static bool TryParseEndpoint(string? value, out Uri endpoint)
    {
        endpoint = null!;
        if (string.IsNullOrWhiteSpace(value) || value != value.Trim() ||
            value.IndexOfAny(['\\', '?', '#']) >= 0 ||
            !Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            !(uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)) ||
            !string.IsNullOrEmpty(uri.UserInfo))
            return false;

        var authorityStart = value.IndexOf("://", StringComparison.Ordinal);
        if (authorityStart < 0)
            return false;
        authorityStart += 3;
        var pathStart = value.IndexOf('/', authorityStart);
        var authority = pathStart < 0 ? value[authorityStart..] : value[authorityStart..pathStart];
        var path = pathStart < 0 ? "/" : value[pathStart..];
        if (authority.Contains('@') || !string.Equals(path, uri.AbsolutePath, StringComparison.Ordinal))
            return false;

        endpoint = uri;
        return true;
    }

    /// <summary>
    /// Returns an MCP service token limited to the requested scopes plus mcp.access.
    /// Tokens are cached separately by their normalized scope set so a narrow token cannot
    /// reuse a broader one. The issued scope claim must exactly match the request.
    /// </summary>
    public virtual Task<string?> GetTokenAsync(
        IReadOnlyCollection<string> scopes,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(scopes);
        if (scopes.Count == 0 || scopes.Any(scope =>
                string.IsNullOrWhiteSpace(scope) || scope != scope.Trim() || scope.Contains(' ')))
        {
            throw new ArgumentException("At least one non-empty MCP scope is required.", nameof(scopes));
        }

        return GetTokenAsyncCore(
            string.Join(' ', scopes.Append(McpAccessScope).Distinct(StringComparer.Ordinal)
                .OrderBy(scope => scope, StringComparer.Ordinal)),
            cancellationToken);
    }

    private async Task<string?> GetTokenAsyncCore(
        string scopeKey,
        CancellationToken cancellationToken)
    {
        if (McpOrigin is null)
        {
            return null;
        }

        var now = DateTimeOffset.UtcNow;
        if (_tokens.TryGetValue(scopeKey, out var cached) && cached.ExpiresOn - RefreshSkew > now)
        {
            return cached.Token;
        }

        if (_retryAfter.TryGetValue(scopeKey, out var retryAfter) && now < retryAfter)
        {
            return null;
        }

        await _lock.WaitAsync(cancellationToken);
        try
        {
            now = DateTimeOffset.UtcNow;
            if (_tokens.TryGetValue(scopeKey, out cached) && cached.ExpiresOn - RefreshSkew > now)
            {
                return cached.Token;
            }

            var assertion = await _credential.GetTokenAsync(
                new TokenRequestContext(new[] { AssertionScope }), cancellationToken);

            var formValues = new Dictionary<string, string>
            {
                ["grant_type"] = GrantType,
                ["client_id"] = ClientId,
                ["assertion"] = assertion.Token,
                ["resource"] = ResourceIdentifier!,
                ["scope"] = scopeKey,
            };

            using var form = new FormUrlEncodedContent(formValues);
            using var http = _httpClientFactory.CreateClient(nameof(McpServiceTokenProvider));
            using var response = await http.PostAsync(McpOrigin + "/token", form, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                _retryAfter[scopeKey] = DateTimeOffset.UtcNow + FailureBackoff;
                _logger.LogWarning(
                    "api-mcp service token request failed with HTTP {Status}",
                    (int)response.StatusCode);
                return null;
            }

            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("access_token", out var tokenElement) ||
                tokenElement.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(tokenElement.GetString()) ||
                !root.TryGetProperty("token_type", out var tokenType) ||
                tokenType.ValueKind != JsonValueKind.String ||
                !string.Equals(tokenType.GetString(), "Bearer", StringComparison.OrdinalIgnoreCase) ||
                !root.TryGetProperty("expires_in", out var exp) ||
                exp.ValueKind != JsonValueKind.Number || !exp.TryGetInt32(out var expiresIn) || expiresIn <= 0)
                throw new JsonException("api-mcp returned an invalid service token response.");

            var expectedScopes = scopeKey.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .ToHashSet(StringComparer.Ordinal);
            var grantedScopes = !root.TryGetProperty("scope", out var scopeElement)
                ? expectedScopes
                : scopeElement.ValueKind == JsonValueKind.String
                    ? scopeElement.GetString()!.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                        .ToHashSet(StringComparer.Ordinal)
                    : null;
            if (grantedScopes is null || !grantedScopes.SetEquals(expectedScopes))
            {
                throw new JsonException("api-mcp granted a service-token scope set that differs from the request.");
            }

            var expiresOn = DateTimeOffset.UtcNow.AddSeconds(expiresIn);
            var token = tokenElement.GetString()!;
            _tokens[scopeKey] = (token, expiresOn);
            _logger.LogInformation("Obtained api-mcp service token (expires in {Seconds}s)", expiresIn);
            return token;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _retryAfter[scopeKey] = DateTimeOffset.UtcNow + FailureBackoff;
            _logger.LogWarning(ex, "Unable to obtain api-mcp service token");
            return null;
        }
        finally
        {
            _lock.Release();
        }
    }
}
