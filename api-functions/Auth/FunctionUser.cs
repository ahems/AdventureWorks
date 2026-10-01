using System.Security.Claims;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;

namespace ApiFunctions.Auth;

/// <summary>
/// The validated AdventureWorks identity for the current request, projected from the token's
/// claims. Stashed in <see cref="FunctionContext.Items"/> by
/// <see cref="FunctionsAuthorizationMiddleware"/> so function bodies can read the caller (and, for
/// consumers, their server-resolved owner ids) without re-parsing the token.
/// </summary>
public sealed class FunctionUser
{
    /// <summary>Key under which the resolved user is stored in <see cref="FunctionContext.Items"/>.</summary>
    public const string ContextKey = "aw.FunctionUser";

    /// <summary>Stable, non-sensitive subject id (<c>sub</c>).</summary>
    public string? SubjectId { get; init; }

    /// <summary>User category claim (<c>consumer</c> / an employee category / <c>anonymous</c>).</summary>
    public string? Category { get; init; }

    /// <summary>Non-sensitive display name, if present.</summary>
    public string? DisplayName { get; init; }

    /// <summary>Granted scopes parsed from the space-delimited <c>scope</c> claim.</summary>
    public IReadOnlySet<string> Scopes { get; init; } = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>Application role(s) from the <c>roles</c> claim.</summary>
    public IReadOnlyList<string> Roles { get; init; } = Array.Empty<string>();

    /// <summary>Server-resolved <c>Sales.Customer.CustomerID</c> for consumer ownership checks.</summary>
    public int? CustomerId { get; init; }

    /// <summary>Server-resolved <c>Person.BusinessEntityID</c> for consumer ownership checks.</summary>
    public int? BusinessEntityId { get; init; }

    /// <summary>True when there was no valid token (anonymous request).</summary>
    public bool IsAuthenticated { get; init; }

    /// <summary>True when the caller is an external consumer (subject to record-level ownership).</summary>
    public bool IsConsumer =>
        string.Equals(Category, UserCategories.Consumer, StringComparison.OrdinalIgnoreCase);

    /// <summary>True when the caller is an authenticated internal (non-consumer) user.</summary>
    public bool IsInternal => IsAuthenticated && !IsConsumer;

    /// <summary>Returns true when the token carries the requested scope.</summary>
    public bool HasScope(string scope) => Scopes.Contains(scope);

    /// <summary>An anonymous (no-token) identity.</summary>
    public static FunctionUser Anonymous { get; } = new()
    {
        Category = "anonymous",
        IsAuthenticated = false,
    };

    /// <summary>Projects a <see cref="FunctionUser"/> from a validated principal.</summary>
    public static FunctionUser FromPrincipal(ClaimsPrincipal principal)
    {
        return new FunctionUser
        {
            SubjectId = principal.FindFirstValue("sub") ?? principal.FindFirstValue(ClaimTypes.NameIdentifier),
            Category = principal.FindFirstValue("category"),
            DisplayName = principal.FindFirstValue("name"),
            Scopes = ParseScopes(principal),
            Roles = ParseRoles(principal),
            CustomerId = ParseInt(principal.FindFirstValue("customer_id")),
            BusinessEntityId = ParseInt(principal.FindFirstValue("business_entity_id")),
            IsAuthenticated = true,
        };
    }

    /// <summary>Reads the resolved user from the function context, or <see cref="Anonymous"/>.</summary>
    public static FunctionUser Current(FunctionContext context) =>
        context.Items.TryGetValue(ContextKey, out var value) && value is FunctionUser user ? user : Anonymous;

    private static IReadOnlySet<string> ParseScopes(ClaimsPrincipal principal)
    {
        var scopes = new HashSet<string>(StringComparer.Ordinal);

        // OpenIddict issues a single space-delimited "scope" claim; some handlers split per-value.
        foreach (var claim in principal.FindAll("scope"))
        {
            foreach (var s in claim.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                scopes.Add(s);
            }
        }

        return scopes;
    }

    private static IReadOnlyList<string> ParseRoles(ClaimsPrincipal principal)
    {
        var roles = new List<string>();

        foreach (var claim in principal.FindAll("roles").Concat(principal.FindAll("role")))
        {
            var value = claim.Value;
            if (value.StartsWith('['))
            {
                // A single claim holding a JSON array of roles.
                try
                {
                    foreach (var element in JsonSerializer.Deserialize<string[]>(value) ?? Array.Empty<string>())
                    {
                        if (!string.IsNullOrWhiteSpace(element))
                        {
                            roles.Add(element);
                        }
                    }

                    continue;
                }
                catch (JsonException)
                {
                    // fall through and treat as a plain string
                }
            }

            if (!string.IsNullOrWhiteSpace(value))
            {
                roles.Add(value);
            }
        }

        return roles.Distinct(StringComparer.Ordinal).ToList();
    }

    private static int? ParseInt(string? value) =>
        int.TryParse(value, out var parsed) ? parsed : null;
}
