using System.Security.Claims;
using ApiFunctions.Auth;
using Xunit;

namespace ApiFunctions.Tests;

/// <summary>
/// Unit tests for <see cref="FunctionUser.FromPrincipal"/>: projecting a validated access-token
/// principal into the resource server's user model (scopes, roles, owner ids, category) that the
/// middleware and the Tier-C ownership checks rely on.
/// </summary>
public class FunctionUserTests
{
    private static ClaimsPrincipal Principal(params Claim[] claims) =>
        new(new ClaimsIdentity(claims, authenticationType: "Bearer"));

    [Fact]
    public void Parses_space_delimited_scope_claim()
    {
        var user = FunctionUser.FromPrincipal(Principal(
            new Claim("scope", "customers.read customers.write orders.read")));

        Assert.True(user.HasScope("customers.read"));
        Assert.True(user.HasScope("customers.write"));
        Assert.True(user.HasScope("orders.read"));
        Assert.False(user.HasScope("admin.write"));
        Assert.Equal(3, user.Scopes.Count);
    }

    [Fact]
    public void Parses_multiple_per_value_scope_claims()
    {
        // Some handlers emit one claim per scope rather than a single space-delimited value.
        var user = FunctionUser.FromPrincipal(Principal(
            new Claim("scope", "customers.read"),
            new Claim("scope", "orders.read")));

        Assert.True(user.HasScope("customers.read"));
        Assert.True(user.HasScope("orders.read"));
        Assert.Equal(2, user.Scopes.Count);
    }

    [Fact]
    public void Parses_roles_from_json_array_claim()
    {
        var user = FunctionUser.FromPrincipal(Principal(
            new Claim("roles", "[\"eshop.customer\",\"eshop.support\"]")));

        Assert.Contains("eshop.customer", user.Roles);
        Assert.Contains("eshop.support", user.Roles);
        Assert.Equal(2, user.Roles.Count);
    }

    [Fact]
    public void Parses_roles_from_per_element_claims_and_deduplicates()
    {
        var user = FunctionUser.FromPrincipal(Principal(
            new Claim("roles", "eshop.customer"),
            new Claim("role", "eshop.customer"),
            new Claim("role", "eshop.support")));

        Assert.Equal(2, user.Roles.Count);
        Assert.Contains("eshop.customer", user.Roles);
        Assert.Contains("eshop.support", user.Roles);
    }

    [Fact]
    public void Projects_subject_category_name_and_owner_ids()
    {
        var user = FunctionUser.FromPrincipal(Principal(
            new Claim("sub", "eshop:30002"),
            new Claim("category", "consumer"),
            new Claim("name", "Alice Consumer"),
            new Claim("customer_id", "30002"),
            new Claim("business_entity_id", "2003")));

        Assert.Equal("eshop:30002", user.SubjectId);
        Assert.Equal("consumer", user.Category);
        Assert.Equal("Alice Consumer", user.DisplayName);
        Assert.Equal(30002, user.CustomerId);
        Assert.Equal(2003, user.BusinessEntityId);
        Assert.True(user.IsAuthenticated);
    }

    [Fact]
    public void Consumer_category_is_flagged_as_consumer_not_internal()
    {
        var user = FunctionUser.FromPrincipal(Principal(new Claim("category", "consumer")));

        Assert.True(user.IsConsumer);
        Assert.False(user.IsInternal);
    }

    [Theory]
    [InlineData("employee")]
    [InlineData("manufacturing")]
    [InlineData("admin")]
    public void Non_consumer_categories_are_flagged_internal(string category)
    {
        var user = FunctionUser.FromPrincipal(Principal(new Claim("category", category)));

        Assert.False(user.IsConsumer);
        Assert.True(user.IsInternal);
    }

    [Fact]
    public void Falls_back_to_name_identifier_for_subject()
    {
        var user = FunctionUser.FromPrincipal(Principal(
            new Claim(ClaimTypes.NameIdentifier, "fallback-subject")));

        Assert.Equal("fallback-subject", user.SubjectId);
    }

    [Fact]
    public void Non_numeric_owner_ids_are_ignored()
    {
        var user = FunctionUser.FromPrincipal(Principal(
            new Claim("customer_id", "not-a-number")));

        Assert.Null(user.CustomerId);
    }

    [Fact]
    public void Anonymous_user_is_unauthenticated_with_no_scopes()
    {
        var anon = FunctionUser.Anonymous;

        Assert.False(anon.IsAuthenticated);
        Assert.False(anon.IsConsumer);
        Assert.False(anon.IsInternal);
        Assert.Empty(anon.Scopes);
        Assert.Empty(anon.Roles);
    }
}
