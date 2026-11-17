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
    private static readonly string[] ReadScopes =
    [
        "mcp.access", "products.read", "orders.read", "inventory.read", "manufacturing.read",
    ];

    internal static IReadOnlyCollection<string> GetScopesForMode(string mode) =>
        mode switch
        {
            "ReadOnly" or "ProposePending" => ReadScopes,
            "FullyAutonomous" => [.. ReadScopes, "manufacturing.write"],
            _ => throw new ArgumentOutOfRangeException(nameof(mode), "Unknown manufacturing agent mode."),
        };

    internal static string GetModeFromMessages(IEnumerable<string?> messages)
    {
        var modeLines = messages
            .Where(message => !string.IsNullOrEmpty(message))
            .SelectMany(message => message!.Split('\n'))
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.StartsWith("Mode=", StringComparison.Ordinal))
            .ToArray();

        if (modeLines.Length != 1)
            throw new InvalidOperationException("Manufacturing invocation must contain exactly one mode.");

        return modeLines[0] switch
        {
            "Mode=ReadOnly (0)" => "ReadOnly",
            "Mode=ProposePending (1)" => "ProposePending",
            "Mode=FullyAutonomous (2)" => "FullyAutonomous",
            _ => throw new InvalidOperationException("Manufacturing invocation is missing a recognized mode."),
        };
    }

    internal async Task<string> GetTokenAsync(string mode, CancellationToken cancellationToken)
    {
        var uri = new Uri(serverUrl, UriKind.Absolute);
        if (uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo))
            throw new InvalidOperationException("MCP_SERVICE_URL must be an HTTPS URL without credentials.");

        var origin = uri.GetLeftPart(UriPartial.Authority);
        var scopes = GetScopesForMode(mode);
        var scopeText = string.Join(' ', scopes);
        var assertion = await credential.GetTokenAsync(
            new TokenRequestContext(["api://AzureADTokenExchange/.default"]), cancellationToken);
        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "urn:adventureworks:params:oauth:grant-type:managed-identity",
            ["client_id"] = "adventureworks-agents",
            ["assertion"] = assertion.Token,
            ["resource"] = origin + "/mcp",
            ["scope"] = scopeText,
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

        var grantedScopeText = root.TryGetProperty("scope", out var scopeElement) &&
                              scopeElement.ValueKind == JsonValueKind.String
            ? scopeElement.GetString()
            : null;
        var expectedScopes = scopes.ToHashSet(StringComparer.Ordinal);
        var grantedScopes = grantedScopeText?.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .ToHashSet(StringComparer.Ordinal);
        if (grantedScopes is null || !grantedScopes.SetEquals(expectedScopes))
            throw new InvalidOperationException("MCP service authentication returned an unexpected scope set.");

        // A fresh exchange for each invocation avoids sharing expired tokens between runs.
        return new AuthenticationHeaderValue("Bearer", token.GetString()).ToString();
    }
}
