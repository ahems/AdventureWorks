using System.Text.Json;
using Azure.Core;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

/// <summary>
/// Obtains a short-lived api-mcp service access token for backend AI agent tool calls that run
/// without a delegated end-user token (e.g. "Generate Customer with AI" in the admin app).
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
    private const string AssertionScope = "api://AzureADTokenExchange/.default";
    private static readonly TimeSpan RefreshSkew = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan FailureBackoff = TimeSpan.FromSeconds(30);

    private readonly TokenCredential _credential;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<McpServiceTokenProvider> _logger;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private string? _token;
    private DateTimeOffset _expiresOn;
    private DateTimeOffset _retryAfter;

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
    /// Returns a cached or freshly issued service token, or null when it cannot be obtained
    /// (the tool call then proceeds unauthenticated and api-mcp returns a clear 401).
    /// </summary>
    public virtual async Task<string?> GetTokenAsync(CancellationToken cancellationToken)
    {
        if (McpOrigin is null)
        {
            return null;
        }

        var now = DateTimeOffset.UtcNow;
        if (_token is not null && _expiresOn - RefreshSkew > now)
        {
            return _token;
        }

        if (now < _retryAfter)
        {
            return null;
        }

        await _lock.WaitAsync(cancellationToken);
        try
        {
            now = DateTimeOffset.UtcNow;
            if (_token is not null && _expiresOn - RefreshSkew > now)
            {
                return _token;
            }

            var assertion = await _credential.GetTokenAsync(
                new TokenRequestContext(new[] { AssertionScope }), cancellationToken);

            var form = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = GrantType,
                ["client_id"] = ClientId,
                ["assertion"] = assertion.Token,
                ["resource"] = ResourceIdentifier!,
            });

            var http = _httpClientFactory.CreateClient(nameof(McpServiceTokenProvider));
            using var response = await http.PostAsync(McpOrigin + "/token", form, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                _retryAfter = DateTimeOffset.UtcNow + FailureBackoff;
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

            _token = token;
            _expiresOn = DateTimeOffset.UtcNow.AddSeconds(expiresIn);
            _logger.LogInformation("Obtained api-mcp service token (expires in {Seconds}s)", expiresIn);
            return _token;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _retryAfter = DateTimeOffset.UtcNow + FailureBackoff;
            _logger.LogWarning(ex, "Unable to obtain api-mcp service token");
            return null;
        }
        finally
        {
            _lock.Release();
        }
    }
}
