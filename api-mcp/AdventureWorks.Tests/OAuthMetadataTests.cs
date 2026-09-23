using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Resource-server + discovery tests that require no AdventureWorks user: authorization-server
/// metadata (RFC 8414), JWKS (public key only), MCP protected-resource metadata (RFC 9728),
/// the unauthenticated <c>/mcp</c> 401 challenge, and health-probe availability.
/// </summary>
public class OAuthMetadataTests : IClassFixture<OAuthTestFactory>
{
    private readonly OAuthTestFactory _factory;

    public OAuthMetadataTests(OAuthTestFactory factory) => _factory = factory;

    [Fact]
    public async Task Authorization_server_metadata_advertises_endpoints_scopes_and_s256()
    {
        var client = _factory.CreateClient();
        var doc = await GetJsonAsync(client, "/.well-known/oauth-authorization-server");

        Assert.True(doc.TryGetProperty("issuer", out _));
        Assert.Contains("authorize", doc.GetProperty("authorization_endpoint").GetString());
        Assert.Contains("token", doc.GetProperty("token_endpoint").GetString());
        Assert.Contains("jwks", doc.GetProperty("jwks_uri").GetString());

        var responseTypes = doc.GetProperty("response_types_supported").EnumerateArray().Select(e => e.GetString());
        Assert.Contains("code", responseTypes);

        var grantTypes = doc.GetProperty("grant_types_supported").EnumerateArray().Select(e => e.GetString());
        Assert.Contains("authorization_code", grantTypes);

        var pkce = doc.GetProperty("code_challenge_methods_supported").EnumerateArray().Select(e => e.GetString());
        Assert.Contains("S256", pkce);
        Assert.DoesNotContain("plain", pkce);

        var scopes = doc.GetProperty("scopes_supported").EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Contains("mcp.access", scopes);
        Assert.Contains("products.read", scopes);
        Assert.Contains("orders.write", scopes);
    }

    [Fact]
    public async Task Jwks_exposes_only_public_key_material()
    {
        var client = _factory.CreateClient();
        var doc = await GetJsonAsync(client, "/.well-known/jwks");

        var keys = doc.GetProperty("keys");
        Assert.True(keys.GetArrayLength() > 0);

        foreach (var key in keys.EnumerateArray())
        {
            // RSA public parameters are present…
            Assert.Equal("RSA", key.GetProperty("kty").GetString());
            Assert.True(key.TryGetProperty("n", out _));
            Assert.True(key.TryGetProperty("e", out _));

            // …but no private component (d/p/q/dp/dq/qi) is ever published.
            Assert.False(key.TryGetProperty("d", out _), "JWKS must not expose the private exponent 'd'.");
            Assert.False(key.TryGetProperty("p", out _));
            Assert.False(key.TryGetProperty("q", out _));
        }
    }

    [Fact]
    public async Task Protected_resource_metadata_points_to_resource_and_scopes()
    {
        var client = _factory.CreateClient();
        var doc = await GetJsonAsync(client, "/.well-known/oauth-protected-resource");

        Assert.Equal(OAuthTestFactory.ResourceIdentifier, doc.GetProperty("resource").GetString());

        var servers = doc.GetProperty("authorization_servers").EnumerateArray().Select(e => e.GetString());
        Assert.NotEmpty(servers);

        var scopes = doc.GetProperty("scopes_supported").EnumerateArray().Select(e => e.GetString());
        Assert.Contains("mcp.access", scopes);
    }

    [Fact]
    public async Task Unauthenticated_mcp_returns_401_with_resource_metadata_challenge()
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsync("/mcp", new StringContent(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}",
            System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);

        var header = response.Headers.WwwAuthenticate.ToString();
        Assert.Contains("resource_metadata", header);
        Assert.Contains("oauth-protected-resource", header);
        Assert.Contains("mcp.access", header);
    }

    [Theory]
    [InlineData("/health")]
    [InlineData("/alive")]
    public async Task Health_probes_remain_anonymous(string path)
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync(path);

        // Container Apps probes must never be blocked by the OAuth layer.
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private static async Task<JsonElement> GetJsonAsync(HttpClient client, string path)
    {
        var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);
        return doc.RootElement.Clone();
    }
}
