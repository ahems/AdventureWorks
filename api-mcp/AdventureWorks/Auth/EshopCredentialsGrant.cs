namespace AdventureWorks.Auth;

/// <summary>
/// First-party e-shop credential exchange. The SPA submits the AdventureWorks
/// credentials once and receives a resource-bound token without a browser redirect.
/// </summary>
public static class EshopCredentialsGrant
{
    public const string GrantType = "urn:adventureworks:params:oauth:grant-type:eshop-credentials";
    public const string ClientId = "adventureworks-eshop";
}
