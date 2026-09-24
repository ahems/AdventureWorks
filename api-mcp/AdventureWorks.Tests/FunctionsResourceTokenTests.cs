using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AdventureWorks.Auth;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Verifies the dedicated-Functions-resource audience strategy through the real OpenIddict
/// pipeline: honoring the RFC 8707 <c>resource</c> parameter against the allow-list
/// {mcp, dab, functions}, binding the token audience to the Functions resource, and adding
/// the non-sensitive owner claims (<c>customer_id</c> / <c>business_entity_id</c>) that the
/// Functions API record-level ownership checks read — for a consumer requesting own-profile
/// scopes (customers.read/write).
/// </summary>
[Collection(OAuthServerCollection.Name)]
public class FunctionsResourceTokenTests : IClassFixture<OAuthTestFactory>
{
    private const string Client = "adventureworks-eshop";
    private const string Redirect = "http://localhost:5173/oauth/callback";

    private readonly OAuthTestFactory _factory;

    public FunctionsResourceTokenTests(OAuthTestFactory factory)
    {
        _factory = factory;
        _factory.Directory.Add("fn-consumer@demo.test", "pw", new ResolvedUser
        {
            Subject = "33333333-3333-3333-3333-333333333333",
            Category = UserCategories.Consumer,
            Roles = new[] { ApplicationRoles.Consumer },
            Scopes = new[]
            {
                OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.OrdersRead, OAuthScopes.OrdersWrite,
                OAuthScopes.CustomersRead, OAuthScopes.CustomersWrite,
            },
            DisplayName = "Functions Consumer",
            CustomerId = 30002,
            BusinessEntityId = 2003,
        });
    }

    private HttpClient CreateClient() => _factory.CreateClient(new WebApplicationFactoryClientOptions
    {
        AllowAutoRedirect = false,
        HandleCookies = true,
    });

    [Fact]
    public async Task Functions_resource_request_binds_functions_audience_and_owner_claims()
    {
        var client = CreateClient();
        var verifier = CreateVerifier();

        await LoginAsync(client, "fn-consumer@demo.test", "pw");
        var code = await AuthorizeAsync(client, Challenge(verifier), "mcp.access customers.read customers.write", "f1",
            OAuthTestFactory.FunctionsResourceIdentifier);
        Assert.False(string.IsNullOrEmpty(code));

        var payload = DecodeJwtPayload(await ExchangeAsync(client, code!, verifier));

        // Audience is bound to the Functions resource (single audience).
        Assert.Equal(OAuthTestFactory.FunctionsResourceIdentifier, Audience(payload));

        // The granted own-profile scopes are present.
        var scope = payload.TryGetProperty("scope", out var s) ? s.GetString() ?? string.Empty : string.Empty;
        Assert.Contains("customers.read", scope);
        Assert.Contains("customers.write", scope);

        // Non-sensitive ownership claims are present for Functions-audience consumer tokens.
        Assert.True(payload.TryGetProperty("customer_id", out var cid));
        Assert.Equal("30002", cid.GetString());
        Assert.True(payload.TryGetProperty("business_entity_id", out var beid));
        Assert.Equal("2003", beid.GetString());
    }

    [Fact]
    public async Task Mcp_resource_request_omits_owner_claims_for_functions_consumer()
    {
        var client = CreateClient();
        var verifier = CreateVerifier();

        await LoginAsync(client, "fn-consumer@demo.test", "pw");
        var code = await AuthorizeAsync(client, Challenge(verifier), "mcp.access customers.read", "f2",
            OAuthTestFactory.ResourceIdentifier);

        var payload = DecodeJwtPayload(await ExchangeAsync(client, code!, verifier));

        Assert.Equal(OAuthTestFactory.ResourceIdentifier, Audience(payload));
        // Ownership ids must never leak into MCP-audience tokens.
        Assert.False(payload.TryGetProperty("customer_id", out _));
        Assert.False(payload.TryGetProperty("business_entity_id", out _));
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
