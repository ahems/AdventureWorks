using System.Reflection;
using ApiFunctions.Auth;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Xunit;

namespace ApiFunctions.Tests;

/// <summary>
/// Reflection-driven coverage for <see cref="FunctionAuthorizationRegistry"/>. These tests are the
/// guard rail that keeps the generated policy registry in lock-step with the actual HTTP surface of
/// api-functions: if someone adds a new <c>[Function]</c> + <c>[HttpTrigger]</c> without classifying
/// it (tier / scope / mode / ownership) in <c>ROUTE_SCOPE_MATRIX.md</c> + the registry, the coverage
/// test fails closed.
/// </summary>
public class FunctionAuthorizationRegistryTests
{
    /// <summary>
    /// Every method in the api-functions assembly that carries a <c>[Function]</c> attribute and an
    /// <c>[HttpTrigger]</c> parameter — i.e. the real, reflected HTTP route surface. Non-HTTP triggers
    /// (timer, queue, durable orchestration/activity) are intentionally excluded; they are never
    /// internet-reachable and so are out of scope for the resource server.
    /// </summary>
    private static IReadOnlyList<string> ReflectedHttpFunctionNames()
    {
        var assembly = typeof(FunctionAuthorizationRegistry).Assembly;
        var names = new List<string>();

        foreach (var type in assembly.GetTypes())
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic
                | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

            foreach (var method in type.GetMethods(flags))
            {
                var function = method.GetCustomAttribute<FunctionAttribute>();
                if (function is null)
                {
                    continue;
                }

                var isHttp = method.GetParameters()
                    .Any(p => p.GetCustomAttribute<HttpTriggerAttribute>() is not null);
                if (isHttp)
                {
                    names.Add(function.Name);
                }
            }
        }

        return names;
    }

    [Fact]
    public void Reflection_discovers_a_meaningful_number_of_http_functions()
    {
        // Sanity check that the reflection scan actually found the HTTP surface (guards against a
        // silent change that makes the scan return nothing and the coverage test vacuously pass).
        Assert.True(ReflectedHttpFunctionNames().Count >= 100,
            $"Expected the reflected HTTP surface to be large; found {ReflectedHttpFunctionNames().Count}.");
    }

    [Fact]
    public void Every_http_function_is_classified()
    {
        var unclassified = FunctionAuthorizationRegistry.UnclassifiedHttpFunctions(ReflectedHttpFunctionNames());

        Assert.True(unclassified.Count == 0,
            "Every HTTP-triggered [Function] must be classified in FunctionAuthorizationRegistry " +
            "(and docs/features/functions-oauth/ROUTE_SCOPE_MATRIX.md). Unclassified: " +
            string.Join(", ", unclassified));
    }

    [Fact]
    public void Registry_has_no_stale_entries()
    {
        var reflected = ReflectedHttpFunctionNames().ToHashSet(StringComparer.Ordinal);
        var stale = FunctionAuthorizationRegistry.All
            .Select(p => p.FunctionName)
            .Where(name => !reflected.Contains(name))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        Assert.True(stale.Count == 0,
            "Registry entries must correspond to a real [Function]+[HttpTrigger]. Stale entries " +
            "(rename or remove): " + string.Join(", ", stale));
    }

    [Fact]
    public void Function_names_are_unique_in_the_registry()
    {
        var duplicates = FunctionAuthorizationRegistry.All
            .GroupBy(p => p.FunctionName, StringComparer.Ordinal)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .ToList();

        Assert.True(duplicates.Count == 0, "Duplicate registry keys: " + string.Join(", ", duplicates));
    }

    [Fact]
    public void Anonymous_tiers_require_no_scope_and_protected_tiers_require_one()
    {
        foreach (var policy in FunctionAuthorizationRegistry.All)
        {
            if (policy.Tier is AccessTier.Public or AccessTier.ProxiedAnonymous)
            {
                Assert.True(policy.IsAnonymous, $"{policy.FunctionName} should be anonymous.");
                Assert.Null(policy.RequiredScope);
                Assert.Equal(AccessMode.Anonymous, policy.Mode);
            }
            else
            {
                Assert.False(policy.IsAnonymous, $"{policy.FunctionName} should not be anonymous.");
                Assert.False(string.IsNullOrWhiteSpace(policy.RequiredScope),
                    $"{policy.FunctionName} (tier {policy.Tier}) must require a scope.");
                Assert.NotEqual(AccessMode.Anonymous, policy.Mode);
            }
        }
    }

    [Fact]
    public void Consumer_ownership_routes_declare_an_ownership_key()
    {
        foreach (var policy in FunctionAuthorizationRegistry.All.Where(p => p.Mode == AccessMode.SelfOrInternal))
        {
            Assert.Equal(AccessTier.Consumer, policy.Tier);
            Assert.False(string.IsNullOrWhiteSpace(policy.OwnershipKey),
                $"{policy.FunctionName} is SelfOrInternal and must declare an OwnershipKey.");
        }
    }

    [Theory]
    // Tier P — anonymous (incl. all pre-auth password endpoints, which must never require a token).
    [InlineData("HealthCheck", AccessTier.Public, null, AccessMode.Anonymous)]
    [InlineData("RequestPasswordReset", AccessTier.Public, null, AccessMode.Anonymous)]
    [InlineData("ResetPassword", AccessTier.Public, null, AccessMode.Anonymous)]
    [InlineData("SetPassword", AccessTier.Public, null, AccessMode.Anonymous)]
    [InlineData("VerifyPassword", AccessTier.Public, null, AccessMode.Anonymous)]
    // Tier C — consumer self-service with record-level ownership.
    [InlineData("GetAddressById", AccessTier.Consumer, FunctionScopes.CustomersRead, AccessMode.SelfOrInternal)]
    [InlineData("CreateAddress", AccessTier.Consumer, FunctionScopes.CustomersWrite, AccessMode.SelfOrInternal)]
    // Tier I — internal-only.
    [InlineData("AIJobQueue_Status", AccessTier.Internal, FunctionScopes.AdminRead, AccessMode.InternalOnly)]
    // Tier M — proxied, left anonymous in v1 (documented descope).
    [InlineData("BankDeposit", AccessTier.ProxiedAnonymous, null, AccessMode.Anonymous)]
    public void Known_routes_are_classified_as_expected(
        string functionName, AccessTier tier, string? scope, AccessMode mode)
    {
        var policy = FunctionAuthorizationRegistry.Find(functionName);

        Assert.NotNull(policy);
        Assert.Equal(tier, policy!.Tier);
        Assert.Equal(scope, policy.RequiredScope);
        Assert.Equal(mode, policy.Mode);
    }

    [Fact]
    public void Unknown_function_name_is_not_classified()
    {
        Assert.Null(FunctionAuthorizationRegistry.Find("ThisFunctionDoesNotExist"));
    }
}
