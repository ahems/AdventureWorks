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

        if (Uri.TryCreate(mcpServiceUrl, UriKind.Absolute, out var uri))
        {
            McpOrigin = $"{uri.Scheme}://{uri.Authority}";
        }
    }

    /// <summary>Origin of the api-mcp server (scheme://host[:port]); null when not configured.</summary>
    public string? McpOrigin { get; }

    /// <summary>The MCP resource identifier (audience) requested for service tokens.</summary>
    public string? ResourceIdentifier => McpOrigin is null ? null : McpOrigin + "/mcp";

    /// <summary>True when <paramref name="serverUrl"/> points at the api-mcp server.</summary>
    public bool IsMcpServer(string? serverUrl)
    {
        if (McpOrigin is null || !Uri.TryCreate(serverUrl, UriKind.Absolute, out var uri))
        {
            return false;
        }

        return string.Equals($"{uri.Scheme}://{uri.Authority}", McpOrigin, StringComparison.OrdinalIgnoreCase);
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
            var http = _httpClientFactory.CreateClient(nameof(McpServiceTokenProvider));
            using var response = await http.PostAsync(McpOrigin + "/token", form, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                _retryAfter[scopeKey] = DateTimeOffset.UtcNow + FailureBackoff;
                _logger.LogWarning(
                    "api-mcp service token request failed with HTTP {Status}: {Body}",
                    (int)response.StatusCode, body.Length > 300 ? body[..300] : body);
                return null;
            }

            using var doc = JsonDocument.Parse(body);
            var token = doc.RootElement.GetProperty("access_token").GetString();
            var expiresIn = doc.RootElement.TryGetProperty("expires_in", out var exp) && exp.TryGetInt32(out var secs)
                ? secs
                : 600;

            if (string.IsNullOrWhiteSpace(token))
            {
                throw new JsonException("api-mcp returned an empty service access token.");
            }

            var expectedScopes = scopeKey.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .ToHashSet(StringComparer.Ordinal);
            var grantedScopes = !doc.RootElement.TryGetProperty("scope", out var scopeElement)
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
