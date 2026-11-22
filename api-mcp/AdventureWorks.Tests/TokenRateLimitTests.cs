using System.Net;
using AdventureWorks.Auth;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// The strict /token budget applies only to the password-bearing e-shop credentials grant;
/// managed-identity (and refresh/code) grants use a separate, higher budget. xUnit class
/// fixtures are per class, so this host's limiter state does not affect other test classes.
/// </summary>
[Collection(OAuthServerCollection.Name)]
public class TokenRateLimitTests : IClassFixture<OAuthTestFactory>
{
    private readonly OAuthTestFactory _factory;

    public TokenRateLimitTests(OAuthTestFactory factory) => _factory = factory;

    [Fact]
    public async Task Credentials_grant_is_throttled_without_blocking_service_grants()
    {
        var client = _factory.CreateClient();

        for (var i = 0; i < McpAuthorizationExtensions.CredentialsGrantPermitsPerMinute; i++)
        {
            var allowed = await PostCredentialsAsync(client);
            Assert.NotEqual(HttpStatusCode.TooManyRequests, allowed);
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, await PostCredentialsAsync(client));

        // Same client address, credentials budget exhausted: workload grants still succeed,
        // including beyond the credentials limit.
        for (var i = 0; i < McpAuthorizationExtensions.CredentialsGrantPermitsPerMinute + 5; i++)
        {
            var response = await client.PostAsync("/token", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = ManagedIdentityGrant.GrantType,
                ["client_id"] = AuthorizationServerOptions.ServiceClientId,
                ["assertion"] = OAuthTestFactory.ValidServiceAssertion,
                ["resource"] = OAuthTestFactory.ResourceIdentifier,
                ["scope"] = "products.read",
            }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
    }

    private static async Task<HttpStatusCode> PostCredentialsAsync(HttpClient client)
    {
        var response = await client.PostAsync("/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = EshopCredentialsGrant.GrantType,
            ["client_id"] = "adventureworks-eshop",
            ["username"] = "nobody@example.invalid",
            ["password"] = "wrong",
            ["resource"] = OAuthTestFactory.DabResourceIdentifier,
            ["scope"] = "customers.read",
        }));
        return response.StatusCode;
    }
}
