using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AdventureWorks.Auth;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace AdventureWorks.Tests;

[Collection(OAuthServerCollection.Name)]
public sealed class InspectorOAuthTests : IClassFixture<OAuthTestFactory>
{
    private const string ClientId = "adventureworks-inspector";
    private const string Redirect = "https://inspector.example.test/oauth/callback";
    private readonly OAuthTestFactory _factory;

    public InspectorOAuthTests(OAuthTestFactory factory)
    {
        _factory = factory;
        foreach (var category in new[] { UserCategories.Employee, UserCategories.Manufacturing, UserCategories.Consumer })
        {
            var role = category switch
            {
                UserCategories.Employee => ApplicationRoles.ExecutiveAdmin,
                UserCategories.Manufacturing => ApplicationRoles.ManufacturingEngineer,
                _ => ApplicationRoles.Consumer,
            };
            _factory.Directory.Add(category + "@inspector.test", "pw", new ResolvedUser
            {
                Subject = "inspector-" + category,
                Category = category,
                Roles = new[] { role },
                Scopes = new[] { OAuthScopes.McpAccess, OAuthScopes.ProductsRead },
                DisplayName = "Inspector Test",
                BusinessEntityId = category == UserCategories.Employee ? 9101 : category == UserCategories.Manufacturing ? 9102 : 9103,
            });
        }
    }

    [Theory]
    [InlineData(UserCategories.Employee, OAuthTestFactory.ResourceIdentifier)]
    [InlineData(UserCategories.Manufacturing, OAuthTestFactory.DabResourceIdentifier)]
    public async Task Hosted_inspector_issues_only_internal_user_resource_bound_pkce_tokens(string category, string audience)
    {
        using var client = CreateClient();
        await Login(client, category);
        var verifier = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var response = await client.GetAsync(Authorize(verifier, audience));
        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(response.Headers.Location!.Query);
        Assert.True(query.ContainsKey("code"));
        var tokens = await client.PostAsync("/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code", ["client_id"] = ClientId, ["redirect_uri"] = Redirect,
            ["code"] = query["code"].ToString(), ["code_verifier"] = verifier, ["resource"] = audience,
        }));
        Assert.Equal(HttpStatusCode.OK, tokens.StatusCode);
        using var document = JsonDocument.Parse(await tokens.Content.ReadAsStringAsync());
        var token = document.RootElement.GetProperty("access_token").GetString()!;
        var segment = token.Split('.')[1].Replace('-', '+').Replace('_', '/');
        using var payload = JsonDocument.Parse(Convert.FromBase64String(segment.PadRight((segment.Length + 3) / 4 * 4, '=')));
        Assert.Equal(audience, payload.RootElement.GetProperty("aud").GetString());
        Assert.Equal(ClientId, payload.RootElement.GetProperty("app").GetString());
        Assert.Equal(category, payload.RootElement.GetProperty("category").GetString());
        Assert.Equal("inspector-" + category, payload.RootElement.GetProperty("sub").GetString());
        Assert.False(document.RootElement.TryGetProperty("refresh_token", out _));
    }

    [Fact]
    public async Task Consumer_cannot_authorize_the_hosted_inspector()
    {
        using var client = CreateClient();
        await Login(client, UserCategories.Consumer);
        var response = await client.GetAsync(Authorize(new string('a', 64), OAuthTestFactory.ResourceIdentifier));
        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
        Assert.StartsWith(Redirect, response.Headers.Location!.AbsoluteUri);
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(response.Headers.Location.Query);
        Assert.Equal("access_denied", query["error"].ToString());
        Assert.False(query.ContainsKey("code"));
    }

    [Fact]
    public async Task Hosted_client_does_not_inherit_the_third_party_inspector_redirects()
    {
        using var client = CreateClient();
        await Login(client, UserCategories.Employee);
        var query = Authorize(new string('a', 64), OAuthTestFactory.ResourceIdentifier)
            .Replace(Uri.EscapeDataString(Redirect), Uri.EscapeDataString("http://localhost:6274/oauth/callback"));
        var response = await client.GetAsync(query);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(response.Headers.Location);
    }

    private HttpClient CreateClient() => _factory.CreateClient(new WebApplicationFactoryClientOptions
    {
        AllowAutoRedirect = false,
        HandleCookies = true,
    });

    private static async Task Login(HttpClient client, string category)
    {
        var response = await client.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["username"] = category + "@inspector.test", ["password"] = "pw", ["returnUrl"] = "/",
        }));
        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
    }

    private static string Authorize(string verifier, string audience)
    {
        var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return "/authorize?" + new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = ClientId, ["redirect_uri"] = Redirect, ["response_type"] = "code",
            ["scope"] = "mcp.access products.read", ["state"] = "inspector-state",
            ["code_challenge"] = challenge, ["code_challenge_method"] = "S256", ["resource"] = audience,
        }).ReadAsStringAsync().GetAwaiter().GetResult();
    }
}
