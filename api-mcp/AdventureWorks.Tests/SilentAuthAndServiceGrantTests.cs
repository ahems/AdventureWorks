using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AdventureWorks.Auth;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Covers the "sign in once, then silent" behaviour for first-party apps (no consent page,
/// offline_access refresh tokens) and the managed-identity service grant used by the
/// backend AI agents.
/// </summary>
[Collection(OAuthServerCollection.Name)]
public class SilentAuthAndServiceGrantTests : IClassFixture<OAuthTestFactory>
{
    private const string Client = "adventureworks-eshop";
    private const string Redirect = "http://localhost:5173/oauth/callback";
    private const string Subject = "33333333-3333-3333-3333-333333333333";

    private readonly OAuthTestFactory _factory;

    public SilentAuthAndServiceGrantTests(OAuthTestFactory factory)
    {
        _factory = factory;
        _factory.Directory.Add("silent@demo.test", "pw-silent", new ResolvedUser
        {
            Subject = Subject,
            Category = UserCategories.Employee,
            Roles = new[] { ApplicationRoles.SalesAdmin },
            Scopes = new[] { OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.OrdersRead },
            DisplayName = "Silent Admin",
            BusinessEntityId = 3001,
        });
    }

    private HttpClient CreateClient() => _factory.CreateClient(new WebApplicationFactoryClientOptions
    {
        AllowAutoRedirect = false,
        HandleCookies = true,
    });

    [Fact]
    public async Task Trusted_first_party_client_gets_code_without_consent_page()
    {
        var client = CreateClient();
        await LoginAsync(client);

        var response = await client.GetAsync(AuthorizeQuery(Challenge(CreateVerifier()), "mcp.access products.read", OAuthTestFactory.DabResourceIdentifier, "auto"));

        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
        var q = Parse(response.Headers.Location!.Query);
        Assert.False(string.IsNullOrEmpty(q.GetValueOrDefault("code")));
        Assert.Equal("auto", q.GetValueOrDefault("state"));
    }

    [Fact]
    public async Task Refresh_token_issues_new_access_token_for_same_resource()
    {
        var client = CreateClient();
        await LoginAsync(client);
        var verifier = CreateVerifier();

        var authorize = await client.GetAsync(AuthorizeQuery(Challenge(verifier), "mcp.access products.read offline_access", OAuthTestFactory.DabResourceIdentifier, "r1"));
        Assert.Equal(HttpStatusCode.Found, authorize.StatusCode);
        var code = Parse(authorize.Headers.Location!.Query)["code"];

        var first = await PostAsync(client, new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["client_id"] = Client,
            ["redirect_uri"] = Redirect,
            ["code_verifier"] = verifier,
        });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var refreshToken = first.RootElement.GetProperty("refresh_token").GetString();
        Assert.False(string.IsNullOrEmpty(refreshToken));

        var refreshed = await PostAsync(client, new()
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refreshToken!,
            ["client_id"] = Client,
        });
        Assert.Equal(HttpStatusCode.OK, refreshed.StatusCode);

        var payload = DecodeJwtPayload(refreshed.RootElement.GetProperty("access_token").GetString()!);
        Assert.Equal(OAuthTestFactory.DabResourceIdentifier, Audience(payload));
        Assert.Equal(Subject, payload.GetProperty("sub").GetString());
        Assert.Equal(Client, payload.GetProperty("app").GetString());
        Assert.True(refreshed.RootElement.TryGetProperty("refresh_token", out _));
    }

    [Fact]
    public async Task Refresh_token_can_switch_between_allowed_resources()
    {
        var client = CreateClient();
        var refreshToken = await GetDabRefreshTokenAsync(client);

        var mcp = await PostAsync(client, new()
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refreshToken,
            ["client_id"] = Client,
            ["resource"] = OAuthTestFactory.ResourceIdentifier,
        });
        Assert.Equal(HttpStatusCode.OK, mcp.StatusCode);
        var mcpPayload = DecodeJwtPayload(mcp.RootElement.GetProperty("access_token").GetString()!);
        Assert.Equal(OAuthTestFactory.ResourceIdentifier, Audience(mcpPayload));
        Assert.Equal(Subject, mcpPayload.GetProperty("sub").GetString());
        Assert.Contains("mcp.access", mcp.RootElement.GetProperty("scope").GetString()!.Split(' '));

        var dab = await PostAsync(client, new()
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = mcp.RootElement.GetProperty("refresh_token").GetString()!,
            ["client_id"] = Client,
            ["resource"] = OAuthTestFactory.DabResourceIdentifier,
        });
        Assert.Equal(HttpStatusCode.OK, dab.StatusCode);
        Assert.Equal(OAuthTestFactory.DabResourceIdentifier,
            Audience(DecodeJwtPayload(dab.RootElement.GetProperty("access_token").GetString()!)));
    }

    [Fact]
    public async Task Refresh_token_for_unknown_resource_is_rejected()
    {
        var client = CreateClient();
        var refreshToken = await GetDabRefreshTokenAsync(client);

        var response = await PostAsync(client, new()
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refreshToken,
            ["client_id"] = Client,
            ["resource"] = "https://evil.example.com/api",
        });
        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
    }

    private async Task<string> GetDabRefreshTokenAsync(HttpClient client)
    {
        await LoginAsync(client);
        var verifier = CreateVerifier();
        var authorize = await client.GetAsync(AuthorizeQuery(Challenge(verifier), "mcp.access products.read offline_access", OAuthTestFactory.DabResourceIdentifier, "rs"));
        Assert.Equal(HttpStatusCode.Found, authorize.StatusCode);
        var token = await PostAsync(client, new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = Parse(authorize.Headers.Location!.Query)["code"],
            ["client_id"] = Client,
            ["redirect_uri"] = Redirect,
            ["code_verifier"] = verifier,
        });
        Assert.Equal(HttpStatusCode.OK, token.StatusCode);
        return token.RootElement.GetProperty("refresh_token").GetString()!;
    }

    [Fact]
    public async Task Service_grant_with_valid_assertion_issues_mcp_service_token()
    {
        var client = CreateClient();
        var response = await PostAsync(client, new()
        {
            ["grant_type"] = ManagedIdentityGrant.GrantType,
            ["client_id"] = AuthorizationServerOptions.ServiceClientId,
            ["assertion"] = OAuthTestFactory.ValidServiceAssertion,
            ["resource"] = OAuthTestFactory.ResourceIdentifier,
            ["scope"] = "mcp.access products.read customers.write",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var payload = DecodeJwtPayload(response.RootElement.GetProperty("access_token").GetString()!);
        Assert.Equal(OAuthTestFactory.ResourceIdentifier, Audience(payload));
        Assert.Equal("service:" + OAuthTestFactory.TrustedServicePrincipalId, payload.GetProperty("sub").GetString());
        Assert.Equal(UserCategories.Service, payload.GetProperty("category").GetString());
        Assert.False(response.RootElement.TryGetProperty("refresh_token", out _));
    }

    [Fact]
    public async Task Service_grant_with_invalid_assertion_is_rejected()
    {
        var client = CreateClient();
        var response = await PostAsync(client, new()
        {
            ["grant_type"] = ManagedIdentityGrant.GrantType,
            ["client_id"] = AuthorizationServerOptions.ServiceClientId,
            ["assertion"] = "forged",
            ["resource"] = OAuthTestFactory.ResourceIdentifier,
        });

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Service_grant_for_non_mcp_resource_is_rejected()
    {
        var client = CreateClient();
        var response = await PostAsync(client, new()
        {
            ["grant_type"] = ManagedIdentityGrant.GrantType,
            ["client_id"] = AuthorizationServerOptions.ServiceClientId,
            ["assertion"] = OAuthTestFactory.ValidServiceAssertion,
            ["resource"] = OAuthTestFactory.DabResourceIdentifier,
        });

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Service_grant_is_refused_for_user_facing_clients()
    {
        var client = CreateClient();
        var response = await PostAsync(client, new()
        {
            ["grant_type"] = ManagedIdentityGrant.GrantType,
            ["client_id"] = Client,
            ["assertion"] = OAuthTestFactory.ValidServiceAssertion,
            ["resource"] = OAuthTestFactory.ResourceIdentifier,
        });

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
    }

    // ---------------------------------------------------------------- helpers

    private static async Task LoginAsync(HttpClient client)
    {
        var response = await client.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["username"] = "silent@demo.test",
            ["password"] = "pw-silent",
            ["returnUrl"] = "/",
        }));
        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
    }

    private static string AuthorizeQuery(string challenge, string scope, string resource, string state) =>
        $"/authorize?client_id={Client}&redirect_uri={Uri.EscapeDataString(Redirect)}" +
        $"&response_type=code&scope={Uri.EscapeDataString(scope)}&state={state}" +
        $"&code_challenge={challenge}&code_challenge_method=S256&resource={Uri.EscapeDataString(resource)}";

    private sealed class TokenResponse
    {
        public HttpStatusCode StatusCode { get; init; }
        public JsonElement RootElement { get; init; }
    }

    private static async Task<TokenResponse> PostAsync(HttpClient client, Dictionary<string, string> form)
    {
        var response = await client.PostAsync("/token", new FormUrlEncodedContent(form));
        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        return new TokenResponse { StatusCode = response.StatusCode, RootElement = doc.RootElement.Clone() };
    }

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

    private static Dictionary<string, string> Parse(string query) =>
        query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2))
            .ToDictionary(kv => Uri.UnescapeDataString(kv[0]), kv => kv.Length > 1 ? Uri.UnescapeDataString(kv[1]) : string.Empty);
}
