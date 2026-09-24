using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AdventureWorks.Auth;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Verifies the dedicated-DAB-resource audience strategy through the real OpenIddict
/// pipeline: honoring the RFC 8707 <c>resource</c> parameter against the allow-list
/// {mcp, dab}, binding the token audience accordingly, emitting the plural <c>roles</c>
/// claim Data API Builder reads, and adding the non-sensitive <c>customer_id</c> ownership
/// claim ONLY to DAB-audience tokens.
/// </summary>
[Collection(OAuthServerCollection.Name)]
public class DabResourceTokenTests : IClassFixture<OAuthTestFactory>
{
    private const string Client = "adventureworks-eshop";
    private const string Redirect = "http://localhost:5173/oauth/callback";

    private readonly OAuthTestFactory _factory;

    public DabResourceTokenTests(OAuthTestFactory factory)
    {
        _factory = factory;
        _factory.Directory.Add("dab-consumer@demo.test", "pw", new ResolvedUser
        {
            Subject = "22222222-2222-2222-2222-222222222222",
            Category = UserCategories.Consumer,
            Roles = new[] { ApplicationRoles.Consumer },
            Scopes = new[] { OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.OrdersRead, OAuthScopes.OrdersWrite },
            DisplayName = "DAB Consumer",
            CustomerId = 30001,
            BusinessEntityId = 2002,
        });
    }

    private HttpClient CreateClient() => _factory.CreateClient(new WebApplicationFactoryClientOptions
    {
        AllowAutoRedirect = false,
        HandleCookies = true,
    });

    [Fact]
    public async Task Dab_resource_request_binds_dab_audience_roles_and_owner_claim()
    {
        var client = CreateClient();
        var verifier = CreateVerifier();

        await LoginAsync(client, "dab-consumer@demo.test", "pw");
        var code = await AuthorizeAsync(client, Challenge(verifier), "mcp.access orders.read", "d1",
            OAuthTestFactory.DabResourceIdentifier);
        Assert.False(string.IsNullOrEmpty(code));

        var payload = DecodeJwtPayload(await ExchangeAsync(client, code!, verifier));

        // Audience is bound to the DAB resource (single audience).
        Assert.Equal(OAuthTestFactory.DabResourceIdentifier, Audience(payload));

        // Plural 'roles' claim is present and contains the consumer role (DAB reads this).
        var roles = StringOrArray(payload, "roles");
        Assert.Contains(ApplicationRoles.Consumer, roles);

        // Non-sensitive ownership claims are present for DAB-audience tokens.
        Assert.True(payload.TryGetProperty("customer_id", out var cid));
        Assert.Equal("30001", cid.GetString());
        Assert.True(payload.TryGetProperty("business_entity_id", out var beid));
        Assert.Equal("2002", beid.GetString());
    }

    [Fact]
    public async Task Mcp_resource_request_omits_owner_claim()
    {
        var client = CreateClient();
        var verifier = CreateVerifier();

        await LoginAsync(client, "dab-consumer@demo.test", "pw");
        var code = await AuthorizeAsync(client, Challenge(verifier), "mcp.access orders.read", "d2",
            OAuthTestFactory.ResourceIdentifier);

        var payload = DecodeJwtPayload(await ExchangeAsync(client, code!, verifier));

        Assert.Equal(OAuthTestFactory.ResourceIdentifier, Audience(payload));
        // Ownership ids must never leak into MCP-audience tokens.
        Assert.False(payload.TryGetProperty("customer_id", out _));
        Assert.False(payload.TryGetProperty("business_entity_id", out _));
        // Roles are still present for informational/consistency purposes.
        Assert.Contains(ApplicationRoles.Consumer, StringOrArray(payload, "roles"));
    }

    [Fact]
    public async Task Unknown_resource_target_is_rejected()
    {
        var client = CreateClient();
        var verifier = CreateVerifier();

        await LoginAsync(client, "dab-consumer@demo.test", "pw");

        // Approve with an unregistered resource target: no authorization code is issued.
        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = Client,
            ["redirect_uri"] = Redirect,
            ["response_type"] = "code",
            ["scope"] = "mcp.access",
            ["state"] = "d3",
            ["code_challenge"] = Challenge(verifier),
            ["code_challenge_method"] = "S256",
            ["resource"] = "https://attacker.example/api",
            ["decision"] = "allow",
        });

        var response = await client.PostAsync("/authorize", form);
        Assert.DoesNotContain("code=", response.Headers.Location?.Query ?? string.Empty);
    }

    // -------------------------------------------------------------- flow helpers

    private static async Task LoginAsync(HttpClient client, string username, string password)
    {
        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["username"] = username,
            ["password"] = password,
            ["returnUrl"] = "/",
        });

        var response = await client.PostAsync("/login", form);
        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
    }

    private async Task<string?> AuthorizeAsync(HttpClient client, string challenge, string scope, string state, string resource)
    {
        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = Client,
            ["redirect_uri"] = Redirect,
            ["response_type"] = "code",
            ["scope"] = scope,
            ["state"] = state,
            ["code_challenge"] = challenge,
            ["code_challenge_method"] = "S256",
            ["resource"] = resource,
            ["decision"] = "allow",
        });

        var approved = await client.PostAsync("/authorize", form);
        Assert.Equal(HttpStatusCode.Found, approved.StatusCode);

        var q = ParseQuery(approved.Headers.Location!.Query);
        Assert.Equal(state, q.GetValueOrDefault("state"));
        return q.GetValueOrDefault("code");
    }

    private async Task<string> ExchangeAsync(HttpClient client, string code, string verifier)
    {
        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["client_id"] = Client,
            ["redirect_uri"] = Redirect,
            ["code_verifier"] = verifier,
        });

        var response = await client.PostAsync("/token", form);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return doc.RootElement.GetProperty("access_token").GetString()!;
    }

    // ----------------------------------------------------------------- utilities

    private static string CreateVerifier() => Base64Url(RandomNumberGenerator.GetBytes(32));

    private static string Challenge(string verifier) => Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static JsonElement DecodeJwtPayload(string jwt)
    {
        var parts = jwt.Split('.');
        Assert.Equal(3, parts.Length);
        var payload = parts[1].Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
        using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(payload)));
        return doc.RootElement.Clone();
    }

    private static string Audience(JsonElement payload)
    {
        var aud = payload.GetProperty("aud");
        return aud.ValueKind == JsonValueKind.Array ? aud[0].GetString()! : aud.GetString()!;
    }

    private static IReadOnlyCollection<string> StringOrArray(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var value))
        {
            return Array.Empty<string>();
        }

        return value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray().Select(e => e.GetString()!).ToArray()
            : new[] { value.GetString()! };
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = pair.Split('=', 2);
            result[Uri.UnescapeDataString(kv[0])] = kv.Length > 1 ? Uri.UnescapeDataString(kv[1]) : string.Empty;
        }

        return result;
    }
}
