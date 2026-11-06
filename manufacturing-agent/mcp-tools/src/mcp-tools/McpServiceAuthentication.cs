using System.Net.Http.Headers;
using System.Text.Json;
using Azure.Core;

namespace McpTools;

/// <summary>
/// Uses the same managed-identity assertion grant as Functions' McpServiceTokenProvider.
/// Kept inside the hosted service's build context so Foundry remote code builds include it.
/// </summary>
internal sealed class McpServiceAuthentication(TokenCredential credential, HttpClient http, string serverUrl)
{
    internal async Task<string> GetTokenAsync(CancellationToken cancellationToken)
    {
        var uri = new Uri(serverUrl, UriKind.Absolute);
        if (uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo))
            throw new InvalidOperationException("MCP_SERVICE_URL must be an HTTPS URL without credentials.");

        var origin = uri.GetLeftPart(UriPartial.Authority);
        var assertion = await credential.GetTokenAsync(
            new TokenRequestContext(["api://AzureADTokenExchange/.default"]), cancellationToken);
        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "urn:adventureworks:params:oauth:grant-type:managed-identity",
            ["client_id"] = "adventureworks-agents",
            ["assertion"] = assertion.Token,
            ["resource"] = origin + "/mcp",
        });
        using var request = new HttpRequestMessage(HttpMethod.Post, origin + "/token") { Content = form };
        using var response = await http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(
                $"MCP service authentication failed (HTTP {(int)response.StatusCode}); verify the hosted agent identity is trusted by api-mcp.");

        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        var root = body.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("access_token", out var token) ||
            token.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(token.GetString()) ||
            !root.TryGetProperty("token_type", out var tokenType) ||
            tokenType.ValueKind != JsonValueKind.String ||
            !string.Equals(tokenType.GetString(), "Bearer", StringComparison.OrdinalIgnoreCase) ||
            !root.TryGetProperty("expires_in", out var expires) ||
            expires.ValueKind != JsonValueKind.Number || !expires.TryGetInt32(out var seconds) || seconds <= 0)
            throw new InvalidOperationException("MCP service authentication returned an invalid token response.");

        // A fresh exchange for each invocation avoids sharing expired tokens between runs.
        return new AuthenticationHeaderValue("Bearer", token.GetString()).ToString();
    }
}
