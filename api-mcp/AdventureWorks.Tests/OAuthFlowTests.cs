using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AdventureWorks.Auth;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// End-to-end Authorization Code + PKCE (S256) tests driven through the real OpenIddict
/// pipeline: login → consent → code → token, plus negative cases (missing PKCE, code reuse,
/// bad redirect). Asserts the issued JWT carries the correct issuer, audience/resource,
/// subject, scopes, application, category and ~10-minute lifetime.
/// </summary>
[Collection(OAuthServerCollection.Name)]
public class OAuthFlowTests : IClassFixture<OAuthTestFactory>
{
    private const string Client = "mcp-inspector";
    private const string Redirect = "http://localhost:6274/oauth/callback";

    private readonly OAuthTestFactory _factory;

    public OAuthFlowTests(OAuthTestFactory factory)
    {
        _factory = factory;
        Seed();
    }

    private void Seed()
    {
        _factory.Directory.Add("consumer@demo.test", "pw-consumer", new ResolvedUser
        {
            Subject = "11111111-1111-1111-1111-111111111111",
            Category = UserCategories.Consumer,
            Roles = new[] { ApplicationRoles.Consumer },
            Scopes = new[] { OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.OrdersRead, OAuthScopes.OrdersWrite },
            DisplayName = "Demo Consumer",
            CustomerId = 29485,
            BusinessEntityId = 2001,
        });
    }

    private HttpClient CreateClient() => _factory.CreateClient(new WebApplicationFactoryClientOptions
    {
        AllowAutoRedirect = false,
        HandleCookies = true,
    });

    [Fact]
    public async Task Full_pkce_s256_flow_issues_resource_bound_jwt()
    {
        var client = CreateClient();
        var verifier = CreateVerifier();
        var challenge = Challenge(verifier);

        await LoginAsync(client, "consumer@demo.test", "pw-consumer");

        var code = await AuthorizeAsync(client, challenge, "mcp.access products.read orders.read", state: "xyz-state");
        Assert.False(string.IsNullOrEmpty(code));

        var token = await ExchangeAsync(client, code!, verifier);
        var payload = DecodeJwtPayload(token);

        Assert.Contains("localhost", payload.GetProperty("iss").GetString());
        Assert.Equal(OAuthTestFactory.ResourceIdentifier, Audience(payload));
        Assert.Equal("11111111-1111-1111-1111-111111111111", payload.GetProperty("sub").GetString());
        Assert.Equal(Client, payload.GetProperty("app").GetString());
        Assert.Equal(UserCategories.Consumer, payload.GetProperty("category").GetString());

        var scopes = Scopes(payload);
        Assert.Contains("mcp.access", scopes);
        Assert.Contains("products.read", scopes);
        Assert.Contains("orders.read", scopes);

        var iat = payload.GetProperty("iat").GetInt64();
        var exp = payload.GetProperty("exp").GetInt64();
        Assert.InRange(exp - iat, 570, 630); // ~10 minutes
    }

    [Fact]
    public async Task Authorization_code_cannot_be_replayed()
    {
        var client = CreateClient();
        var verifier = CreateVerifier();

        await LoginAsync(client, "consumer@demo.test", "pw-consumer");
        var code = await AuthorizeAsync(client, Challenge(verifier), "mcp.access", state: "s1");

        var first = await PostTokenAsync(client, code!, verifier);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var second = await PostTokenAsync(client, code!, verifier);
        Assert.NotEqual(HttpStatusCode.OK, second.StatusCode);
    }

    [Fact]
    public async Task Token_exchange_requires_matching_verifier()
    {
        var client = CreateClient();
        var verifier = CreateVerifier();

        await LoginAsync(client, "consumer@demo.test", "pw-consumer");
        var code = await AuthorizeAsync(client, Challenge(verifier), "mcp.access", state: "s2");

        var wrong = await PostTokenAsync(client, code!, CreateVerifier());
        Assert.NotEqual(HttpStatusCode.OK, wrong.StatusCode);
    }

    [Fact]
    public async Task Authorize_without_pkce_is_rejected()
    {
        var client = CreateClient();
        await LoginAsync(client, "consumer@demo.test", "pw-consumer");

        var query = $"?client_id={Client}&redirect_uri={Uri.EscapeDataString(Redirect)}" +
                    "&response_type=code&scope=mcp.access&state=nopkce";

        var response = await client.GetAsync("/authorize" + query);

        // No redirect back to the client with a code is ever produced.
        Assert.NotEqual(HttpStatusCode.Found, response.StatusCode);
        if (response.StatusCode == HttpStatusCode.Redirect || response.StatusCode == HttpStatusCode.Found)
        {
            Assert.DoesNotContain("code=", response.Headers.Location?.Query ?? string.Empty);
        }
    }

    [Fact]
    public async Task Authorize_with_unregistered_redirect_is_rejected()
    {
        var client = CreateClient();
        await LoginAsync(client, "consumer@demo.test", "pw-consumer");

        var evil = "https://attacker.example/callback";
        var query = $"?client_id={Client}&redirect_uri={Uri.EscapeDataString(evil)}" +
                    $"&response_type=code&scope=mcp.access&state=evil&code_challenge={Challenge(CreateVerifier())}" +
                    "&code_challenge_method=S256";

        var response = await client.GetAsync("/authorize" + query);

        // OpenIddict must not redirect to an unregistered URI.
        Assert.NotEqual(HttpStatusCode.Found, response.StatusCode);
        Assert.DoesNotContain("attacker.example", response.Headers.Location?.ToString() ?? string.Empty);
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

    private async Task<string?> AuthorizeAsync(HttpClient client, string challenge, string scope, string state)
    {
        var query = $"?client_id={Client}&redirect_uri={Uri.EscapeDataString(Redirect)}" +
                    $"&response_type=code&scope={Uri.EscapeDataString(scope)}&state={state}" +
                    $"&code_challenge={challenge}&code_challenge_method=S256" +
                    $"&resource={Uri.EscapeDataString(OAuthTestFactory.ResourceIdentifier)}";

        // Consent page renders for the authenticated user.
        var consent = await client.GetAsync("/authorize" + query);
        Assert.Equal(HttpStatusCode.OK, consent.StatusCode);

        // Approve.
        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = Client,
            ["redirect_uri"] = Redirect,
            ["response_type"] = "code",
            ["scope"] = scope,
            ["state"] = state,
            ["code_challenge"] = challenge,
            ["code_challenge_method"] = "S256",
            ["resource"] = OAuthTestFactory.ResourceIdentifier,
            ["decision"] = "allow",
        });

        var approved = await client.PostAsync("/authorize", form);
        Assert.Equal(HttpStatusCode.Found, approved.StatusCode);

        var location = approved.Headers.Location!;
        var q = HttpUtilityParse(location.Query);
        Assert.Equal(state, q.GetValueOrDefault("state"));
        return q.GetValueOrDefault("code");
    }

    private async Task<HttpResponseMessage> PostTokenAsync(HttpClient client, string code, string verifier)
    {
        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["client_id"] = Client,
            ["redirect_uri"] = Redirect,
            ["code_verifier"] = verifier,
        });

        return await client.PostAsync("/token", form);
    }

    private async Task<string> ExchangeAsync(HttpClient client, string code, string verifier)
    {
        var response = await PostTokenAsync(client, code, verifier);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetProperty("access_token").GetString()!;
    }

    // ----------------------------------------------------------------- PKCE utils

    private static string CreateVerifier()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Base64Url(bytes);
    }

    private static string Challenge(string verifier)
    {
        var hash = SHA256.HashData(Encoding.ASCII.GetBytes(verifier));
        return Base64Url(hash);
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static JsonElement DecodeJwtPayload(string jwt)
    {
        var parts = jwt.Split('.');
        Assert.Equal(3, parts.Length); // JWS: header.payload.signature (not encrypted)

        var payload = parts[1].Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
        var json = Encoding.UTF8.GetString(Convert.FromBase64String(payload));
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private static string Audience(JsonElement payload)
    {
        var aud = payload.GetProperty("aud");
        return aud.ValueKind == JsonValueKind.Array ? aud[0].GetString()! : aud.GetString()!;
    }

    private static IReadOnlyCollection<string> Scopes(JsonElement payload)
    {
        if (payload.TryGetProperty("scope", out var single) && single.ValueKind == JsonValueKind.String)
        {
            return single.GetString()!.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        }

        if (payload.TryGetProperty("scope", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            return arr.EnumerateArray().Select(e => e.GetString()!).ToArray();
        }

        return Array.Empty<string>();
    }

    private static Dictionary<string, string> HttpUtilityParse(string query)
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
