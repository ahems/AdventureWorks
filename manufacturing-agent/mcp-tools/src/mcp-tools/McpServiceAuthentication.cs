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

    private static readonly string[] ReadTools =
    [
        "get_manufacturing_status", "get_active_manufacturing_operations",
        "get_production_feasibility", "get_all_products_feasibility",
        "get_manufacturing_catalog_snapshot", "get_overstock_items",
        "get_thin_margin_products", "get_component_shortage_forecast",
        "get_reorder_recommendations",
        "get_supply_chain_vendors", "get_vendor_details",
        "get_supply_catalog", "get_supply_quote",
        "get_active_supply_orders", "get_supply_order_history",
        "get_order_details", "check_inventory_availability", "get_product_details",
    ];

    internal static string[] GetToolsForMode(string mode) =>
        mode switch
        {
            "ReadOnly" or "ProposePending" => [.. ReadTools],
            "FullyAutonomous" => [.. ReadTools, "begin_manufacturing_run", "place_supply_order"],
            _ => throw new ArgumentOutOfRangeException(nameof(mode), "Unknown manufacturing agent mode."),
        };

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
            "Mode=ReadOnly (1)" => "ReadOnly",
            "Mode=ProposePending (2)" => "ProposePending",
            "Mode=FullyAutonomous (3)" => "FullyAutonomous",
            _ => throw new InvalidOperationException("Manufacturing invocation is missing a recognized mode."),
        };
    }

    internal async Task<string> GetTokenAsync(string mode, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(serverUrl) || serverUrl != serverUrl.Trim() ||
            serverUrl.IndexOfAny(['\\', '?', '#']) >= 0 ||
            !Uri.TryCreate(serverUrl, UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo))
            throw new InvalidOperationException("MCP_SERVICE_URL must be a canonical HTTPS endpoint without credentials, query, or fragment.");

        var authorityStart = serverUrl.IndexOf("://", StringComparison.Ordinal);
        if (authorityStart < 0)
            throw new InvalidOperationException("MCP_SERVICE_URL must be a canonical HTTPS endpoint.");
        authorityStart += 3;
        var pathStart = serverUrl.IndexOf('/', authorityStart);
        var authority = pathStart < 0 ? serverUrl[authorityStart..] : serverUrl[authorityStart..pathStart];
        var path = pathStart < 0 ? "/" : serverUrl[pathStart..];
        if (authority.Contains('@') || !string.Equals(path, uri.AbsolutePath, StringComparison.Ordinal))
            throw new InvalidOperationException("MCP_SERVICE_URL must be a canonical HTTPS endpoint.");

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

        var expectedScopes = scopes.ToHashSet(StringComparer.Ordinal);
        var grantedScopes = !root.TryGetProperty("scope", out var scopeElement)
            ? expectedScopes
            : scopeElement.ValueKind == JsonValueKind.String
                ? scopeElement.GetString()!.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                    .ToHashSet(StringComparer.Ordinal)
                : null;
        if (grantedScopes is null || !grantedScopes.SetEquals(expectedScopes))
            throw new InvalidOperationException("MCP service authentication returned an unexpected scope set.");

        // A fresh exchange for each invocation avoids sharing expired tokens between runs.
        return new AuthenticationHeaderValue("Bearer", token.GetString()).ToString();
    }
}
