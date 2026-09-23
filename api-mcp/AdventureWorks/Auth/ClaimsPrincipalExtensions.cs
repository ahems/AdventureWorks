using System.Security.Claims;
using OpenIddict.Abstractions;

namespace AdventureWorks.Auth;

/// <summary>Custom (non-standard) claim types issued in AdventureWorks MCP access tokens.</summary>
public static class AwClaims
{
    /// <summary>User category (consumer / employee / manufacturing).</summary>
    public const string Category = "category";

    /// <summary>Application/client context the token was issued to.</summary>
    public const string Application = "app";
}

/// <summary>Helpers to read the AdventureWorks identity from a validated token principal.</summary>
public static class ClaimsPrincipalExtensions
{
    public static string? GetSubjectId(this ClaimsPrincipal principal) =>
        principal.GetClaim(OpenIddictConstants.Claims.Subject)
        ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);

    public static string GetCategory(this ClaimsPrincipal principal) =>
        principal.GetClaim(AwClaims.Category) ?? UserCategories.Anonymous;

    public static string? GetApplication(this ClaimsPrincipal principal) =>
        principal.GetClaim(AwClaims.Application)
        ?? principal.GetClaim(OpenIddictConstants.Claims.ClientId);

    public static string? GetDisplayName(this ClaimsPrincipal principal) =>
        principal.GetClaim(OpenIddictConstants.Claims.Name);

    /// <summary>Returns the set of granted scopes from the validated token.</summary>
    public static IReadOnlySet<string> GetScopeSet(this ClaimsPrincipal principal)
    {
        // OpenIddict exposes scopes both as a space-delimited "scope" claim and via GetScopes().
        var scopes = new HashSet<string>(StringComparer.Ordinal);

        foreach (var s in principal.GetScopes())
        {
            scopes.Add(s);
        }

        if (scopes.Count == 0)
        {
            var raw = principal.GetClaim(OpenIddictConstants.Claims.Scope);
            if (!string.IsNullOrWhiteSpace(raw))
            {
                foreach (var s in raw.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    scopes.Add(s);
                }
            }
        }

        return scopes;
    }
}
