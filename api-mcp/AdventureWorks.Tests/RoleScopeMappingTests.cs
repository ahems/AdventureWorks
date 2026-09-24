using AdventureWorks.Auth;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Verifies the deterministic role→scope design: each seeded role grants exactly the
/// intended business scopes, categories are correct, and cross-category escalation is
/// impossible (manufacturing excludes customer/admin; consumers exclude internal scopes).
/// </summary>
public class RoleScopeMappingTests
{
    [Fact]
    public void Every_role_grants_mcp_access()
    {
        foreach (var (role, scopes) in ApplicationRoles.DefaultRoleScopes)
        {
            Assert.Contains(OAuthScopes.McpAccess, scopes);
        }
    }

    [Fact]
    public void Every_granted_scope_is_known()
    {
        foreach (var (role, scopes) in ApplicationRoles.DefaultRoleScopes)
        {
            foreach (var scope in scopes)
            {
                Assert.True(OAuthScopes.IsKnown(scope), $"Role '{role}' grants unknown scope '{scope}'.");
            }
        }
    }

    [Fact]
    public void Consumer_has_catalog_own_orders_and_own_profile()
    {
        var scopes = ApplicationRoles.DefaultRoleScopes[ApplicationRoles.Consumer];
        Assert.Equal(
            new[]
            {
                OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.OrdersRead, OAuthScopes.OrdersWrite,
                OAuthScopes.CustomersRead, OAuthScopes.CustomersWrite,
            }.OrderBy(s => s),
            scopes.OrderBy(s => s));
    }

    [Fact]
    public void Consumer_never_has_internal_only_scopes()
    {
        // customers.read/write are SHARED scopes (own-profile for consumers, any for internal),
        // ownership-gated at the resource server — exactly like orders.read. The truly
        // internal-only scopes below must never be granted to a consumer.
        var scopes = ApplicationRoles.DefaultRoleScopes[ApplicationRoles.Consumer];
        Assert.DoesNotContain(OAuthScopes.SalesRead, scopes);
        Assert.DoesNotContain(OAuthScopes.InventoryRead, scopes);
        Assert.DoesNotContain(OAuthScopes.ManufacturingRead, scopes);
        Assert.DoesNotContain(OAuthScopes.ManufacturingWrite, scopes);
        Assert.DoesNotContain(OAuthScopes.AdminRead, scopes);
        Assert.DoesNotContain(OAuthScopes.AdminWrite, scopes);
        Assert.DoesNotContain(OAuthScopes.McpAdmin, scopes);
    }

    [Fact]
    public void Manufacturing_engineer_excludes_customer_sales_orders_and_admin()
    {
        var scopes = ApplicationRoles.DefaultRoleScopes[ApplicationRoles.ManufacturingEngineer];

        Assert.Contains(OAuthScopes.ManufacturingRead, scopes);
        Assert.Contains(OAuthScopes.ManufacturingWrite, scopes);
        Assert.Contains(OAuthScopes.InventoryRead, scopes);
        Assert.Contains(OAuthScopes.ProductsRead, scopes);

        Assert.DoesNotContain(OAuthScopes.CustomersRead, scopes);
        Assert.DoesNotContain(OAuthScopes.SalesRead, scopes);
        Assert.DoesNotContain(OAuthScopes.OrdersRead, scopes);
        Assert.DoesNotContain(OAuthScopes.OrdersWrite, scopes);
        Assert.DoesNotContain(OAuthScopes.AdminRead, scopes);
        Assert.DoesNotContain(OAuthScopes.AdminWrite, scopes);
        Assert.DoesNotContain(OAuthScopes.McpAdmin, scopes);
    }

    [Fact]
    public void Only_executive_has_mcp_admin()
    {
        foreach (var (role, scopes) in ApplicationRoles.DefaultRoleScopes)
        {
            if (role == ApplicationRoles.ExecutiveAdmin)
            {
                Assert.Contains(OAuthScopes.McpAdmin, scopes);
            }
            else
            {
                Assert.DoesNotContain(OAuthScopes.McpAdmin, scopes);
            }
        }
    }

    [Theory]
    [InlineData(ApplicationRoles.Consumer, UserCategories.Consumer)]
    [InlineData(ApplicationRoles.ManufacturingEngineer, UserCategories.Manufacturing)]
    [InlineData(ApplicationRoles.SalesAdmin, UserCategories.Employee)]
    [InlineData(ApplicationRoles.MarketingAdmin, UserCategories.Employee)]
    [InlineData(ApplicationRoles.InventoryAdmin, UserCategories.Employee)]
    [InlineData(ApplicationRoles.OperationsAdmin, UserCategories.Employee)]
    [InlineData(ApplicationRoles.ExecutiveAdmin, UserCategories.Employee)]
    public void Role_maps_to_expected_category(string role, string expectedCategory)
    {
        Assert.Equal(expectedCategory, ApplicationRoles.CategoryFor(role));
    }

    [Fact]
    public void No_role_except_consumer_maps_to_consumer_category()
    {
        foreach (var role in ApplicationRoles.DefaultRoleScopes.Keys.Where(r => r != ApplicationRoles.Consumer))
        {
            Assert.NotEqual(UserCategories.Consumer, ApplicationRoles.CategoryFor(role));
        }
    }
}
