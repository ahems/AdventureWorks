using System.Net;
using System.Security.Cryptography;
using System.Text;
using AdventureWorks.Auth;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Each first-party portal only issues tokens to the user category it serves: e-shop → consumers,
/// admin → employees, manufacturing → manufacturing staff. Denials are redirected back to the
/// client with <c>error=access_denied</c>, as are bad credentials submitted from a client login.
/// </summary>
[Collection(OAuthServerCollection.Name)]
public class PortalCategoryGatingTests : IClassFixture<OAuthTestFactory>
{
    private const string AdminClient = "adventureworks-admin";
    private const string AdminRedirect = "http://localhost:5174/oauth/callback";
    private const string MfgClient = "adventureworks-manufacturing";
    private const string MfgRedirect = "http://localhost:5175/oauth/callback";
    private const string EshopClient = "adventureworks-eshop";
    private const string EshopRedirect = "http://localhost:5173/oauth/callback";

    private readonly OAuthTestFactory _factory;

    public PortalCategoryGatingTests(OAuthTestFactory factory)
    {
        _factory = factory;
        _factory.Directory.Add("gate-admin@demo.test", "pw", new ResolvedUser
        {
            Subject = "77777777-0000-0000-0000-000000000001",
            Category = UserCategories.Employee,
            Roles = new[] { ApplicationRoles.ExecutiveAdmin },
            Scopes = new[] { OAuthScopes.McpAccess, OAuthScopes.ProductsRead },
            DisplayName = "Gate Admin",
            BusinessEntityId = 7001,
        });
        _factory.Directory.Add("gate-mfg@demo.test", "pw", new ResolvedUser
        {
            Subject = "77777777-0000-0000-0000-000000000002",
            Category = UserCategories.Manufacturing,
            Roles = new[] { ApplicationRoles.ManufacturingEngineer },
            Scopes = new[] { OAuthScopes.McpAccess, OAuthScopes.ProductsRead },
            DisplayName = "Gate Engineer",
            BusinessEntityId = 7002,
        });
        _factory.Directory.Add("gate-consumer@demo.test", "pw", new ResolvedUser
        {
            Subject = "77777777-0000-0000-0000-000000000003",
            Category = UserCategories.Consumer,
            Roles = new[] { ApplicationRoles.Consumer },
            Scopes = new[] { OAuthScopes.McpAccess, OAuthScopes.ProductsRead },
            DisplayName = "Gate Consumer",
            BusinessEntityId = 7003,
            CustomerId = 7004,
        });
    }

    [Theory]
    [InlineData("gate-admin@demo.test", AdminClient, AdminRedirect)]
    [InlineData("gate-mfg@demo.test", MfgClient, MfgRedirect)]
    [InlineData("gate-consumer@demo.test", EshopClient, EshopRedirect)]
    public async Task Matching_category_gets_authorization_code(string user, string clientId, string redirect)
    {
        var client = CreateClient();
        await LoginAsync(client, user, "pw");

        var response = await client.GetAsync(AuthorizeQuery(clientId, redirect, "ok"));

        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
        var q = Parse(response.Headers.Location!.Query);
        Assert.False(string.IsNullOrEmpty(q.GetValueOrDefault("code")));
    }

    [Theory]
    [InlineData("gate-mfg@demo.test", AdminClient, AdminRedirect)]
    [InlineData("gate-consumer@demo.test", AdminClient, AdminRedirect)]
    [InlineData("gate-admin@demo.test", MfgClient, MfgRedirect)]
    [InlineData("gate-consumer@demo.test", MfgClient, MfgRedirect)]
    [InlineData("gate-admin@demo.test", EshopClient, EshopRedirect)]
    public async Task Wrong_category_is_redirected_back_with_access_denied(string user, string clientId, string redirect)
    {
        var client = CreateClient();
        await LoginAsync(client, user, "pw");

        var response = await client.GetAsync(AuthorizeQuery(clientId, redirect, "deny"));

        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
        var location = response.Headers.Location!;
        Assert.StartsWith(redirect, location.GetLeftPart(UriPartial.Path));
        var q = Parse(location.Query);
        Assert.Equal("access_denied", q.GetValueOrDefault("error"));
        Assert.Equal("deny", q.GetValueOrDefault("state"));
        Assert.False(q.ContainsKey("code"));
    }

    [Fact]
    public async Task Bad_credentials_from_client_login_redirect_to_client_with_error()
    {
        var client = CreateClient();
        var returnUrl = AuthorizeQuery(AdminClient, AdminRedirect, "badpw");

        var response = await client.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["username"] = "gate-admin@demo.test",
            ["password"] = "wrong",
            ["returnUrl"] = returnUrl,
        }));

        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
        var location = response.Headers.Location!;
        Assert.StartsWith(AdminRedirect, location.GetLeftPart(UriPartial.Path));
        var q = Parse(location.Query);
        Assert.Equal("access_denied", q.GetValueOrDefault("error"));
        Assert.Equal("badpw", q.GetValueOrDefault("state"));
    }

    private HttpClient CreateClient() => _factory.CreateClient(new WebApplicationFactoryClientOptions
    {
        AllowAutoRedirect = false,
        HandleCookies = true,
    });

    private static async Task LoginAsync(HttpClient client, string username, string password)
    {
        var response = await client.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["username"] = username,
            ["password"] = password,
            ["returnUrl"] = "/",
        }));
        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
    }

    private static string AuthorizeQuery(string clientId, string redirect, string state)
    {
        var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(Verifier)))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return $"/authorize?client_id={clientId}&redirect_uri={Uri.EscapeDataString(redirect)}" +
               $"&response_type=code&scope={Uri.EscapeDataString("mcp.access products.read")}&state={state}" +
               $"&code_challenge={challenge}&code_challenge_method=S256" +
               $"&resource={Uri.EscapeDataString(OAuthTestFactory.DabResourceIdentifier)}";
    }

    private static readonly string Verifier = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static Dictionary<string, string> Parse(string query) =>
        query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2))
            .ToDictionary(p => Uri.UnescapeDataString(p[0]), p => p.Length > 1 ? Uri.UnescapeDataString(p[1].Replace('+', ' ')) : string.Empty);
}
