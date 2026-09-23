using AdventureWorks.Auth;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Exercises the pure server-side authorization evaluator: scope enforcement, internal-only
/// gating, consumer record-level ownership, ownership injection, cross-role isolation and
/// the orders.write enforcement primitive.
/// </summary>
public class ToolAuthorizationEvaluatorTests
{
    private readonly ToolAuthorizationEvaluator _eval = new();

    private static CallerContext Caller(string category, IEnumerable<string> scopes, int? customerId = null) => new()
    {
        Subject = "00000000-0000-0000-0000-000000000001",
        Category = category,
        Scopes = new HashSet<string>(scopes, StringComparer.Ordinal),
        CustomerId = customerId,
        Application = "adventureworks-eshop",
    };

    private static CallerContext Consumer(int? customerId = 100) =>
        Caller(UserCategories.Consumer, ApplicationRoles.DefaultRoleScopes[ApplicationRoles.Consumer], customerId);

    private static CallerContext SalesAdmin() =>
        Caller(UserCategories.Employee, ApplicationRoles.DefaultRoleScopes[ApplicationRoles.SalesAdmin]);

    private static CallerContext Manufacturing() =>
        Caller(UserCategories.Manufacturing, ApplicationRoles.DefaultRoleScopes[ApplicationRoles.ManufacturingEngineer]);

    private static CallerContext Executive() =>
        Caller(UserCategories.Employee, ApplicationRoles.DefaultRoleScopes[ApplicationRoles.ExecutiveAdmin]);

    // ---- baseline connectivity ----

    [Fact]
    public void Missing_mcp_access_is_denied()
    {
        var caller = Caller(UserCategories.Consumer, new[] { OAuthScopes.ProductsRead });
        var d = _eval.Evaluate(caller, "search_products", null, false);
        Assert.False(d.Allowed);
        Assert.Equal(AuthorizationOutcome.DenyMcpAccess, d.Outcome);
    }

    [Fact]
    public void Unclassified_tool_fails_closed()
    {
        var d = _eval.Evaluate(Executive(), "nonexistent_tool", null, false);
        Assert.False(d.Allowed);
        Assert.Equal(AuthorizationOutcome.DenyUnclassified, d.Outcome);
    }

    // ---- consumer: public + own records ----

    [Fact]
    public void Consumer_can_call_public_product_tool()
    {
        var d = _eval.Evaluate(Consumer(), "search_products", null, false);
        Assert.True(d.Allowed);
    }

    [Fact]
    public void Consumer_can_read_their_own_orders()
    {
        var d = _eval.Evaluate(Consumer(customerId: 100), "get_customer_orders", 100, true);
        Assert.True(d.Allowed);
    }

    [Fact]
    public void Consumer_cannot_read_another_customers_orders()
    {
        var d = _eval.Evaluate(Consumer(customerId: 100), "get_customer_orders", 999, true);
        Assert.False(d.Allowed);
        Assert.Equal(AuthorizationOutcome.DenyOwnership, d.Outcome);
    }

    [Fact]
    public void Consumer_owner_argument_is_injected_when_omitted()
    {
        var d = _eval.Evaluate(Consumer(customerId: 100), "get_customer_orders", null, false);
        Assert.True(d.Allowed);
        Assert.Equal(100, d.InjectCustomerId);
    }

    [Fact]
    public void Consumer_without_customer_profile_is_denied_ownership_tool()
    {
        var d = _eval.Evaluate(Consumer(customerId: null), "get_customer_orders", null, false);
        Assert.False(d.Allowed);
        Assert.Equal(AuthorizationOutcome.DenyNoCustomer, d.Outcome);
    }

    // ---- consumer: denied internal tools (scope + defense-in-depth) ----

    [Fact]
    public void Consumer_cannot_search_customers()
    {
        var d = _eval.Evaluate(Consumer(), "search_customers", null, false);
        Assert.False(d.Allowed);
        // Consumer lacks customers.read entirely -> scope denial.
        Assert.Equal(AuthorizationOutcome.DenyScope, d.Outcome);
    }

    [Fact]
    public void Consumer_cannot_call_business_stats()
    {
        var d = _eval.Evaluate(Consumer(), "get_business_stats", null, false);
        Assert.False(d.Allowed);
    }

    [Fact]
    public void Internal_only_tool_denies_consumer_even_with_scope()
    {
        // Defense in depth: a consumer that somehow carried customers.read is still blocked.
        var caller = Caller(UserCategories.Consumer,
            new[] { OAuthScopes.McpAccess, OAuthScopes.CustomersRead });
        var d = _eval.Evaluate(caller, "search_customers", null, false);
        Assert.False(d.Allowed);
        Assert.Equal(AuthorizationOutcome.DenyInternalOnly, d.Outcome);
    }

    // ---- admin (seeded role) ----

    [Fact]
    public void Sales_admin_can_search_customers()
    {
        var d = _eval.Evaluate(SalesAdmin(), "search_customers", null, false);
        Assert.True(d.Allowed);
    }

    [Fact]
    public void Sales_admin_can_read_any_customer_orders_without_ownership()
    {
        var d = _eval.Evaluate(SalesAdmin(), "get_customer_orders", 999, true);
        Assert.True(d.Allowed);
        Assert.Null(d.InjectCustomerId);
    }

    // ---- manufacturing isolation ----

    [Fact]
    public void Manufacturing_can_read_manufacturing_status()
    {
        var d = _eval.Evaluate(Manufacturing(), "get_manufacturing_status", null, false);
        Assert.True(d.Allowed);
    }

    [Fact]
    public void Manufacturing_can_write_manufacturing_run()
    {
        var d = _eval.Evaluate(Manufacturing(), "begin_manufacturing_run", null, false);
        Assert.True(d.Allowed);
    }

    [Theory]
    [InlineData("search_customers")]
    [InlineData("get_business_stats")]
    [InlineData("get_customer_orders")]
    [InlineData("get_top_customers")]
    [InlineData("bank_deposit")]
    public void Manufacturing_cannot_touch_customer_sales_or_admin(string tool)
    {
        var d = _eval.Evaluate(Manufacturing(), tool, null, false);
        Assert.False(d.Allowed);
    }

    // ---- executive breadth ----

    [Fact]
    public void Executive_has_mcp_admin_and_can_reset_simulators()
    {
        var d = _eval.Evaluate(Executive(), "reset_all_simulators", null, false);
        Assert.True(d.Allowed);
    }

    // ---- orders.write enforcement primitive ----
    // No MCP tool currently mutates orders (order writes go via REST/DAB), so the scope is
    // enforced directly against a representative policy to prove the primitive works.

    [Fact]
    public void OrdersWrite_scope_is_required_for_orders_write_policy()
    {
        var policy = new ToolPolicy("mutate_order", OAuthScopes.OrdersWrite, ToolAccessMode.SelfOrInternal, "customerId");

        var withoutWrite = Caller(UserCategories.Consumer, new[] { OAuthScopes.McpAccess, OAuthScopes.OrdersRead }, 100);
        Assert.False(_eval.Evaluate(withoutWrite, policy, 100, true).Allowed);

        var withWrite = Caller(UserCategories.Consumer,
            new[] { OAuthScopes.McpAccess, OAuthScopes.OrdersWrite }, 100);
        Assert.True(_eval.Evaluate(withWrite, policy, 100, true).Allowed);
    }

    [Fact]
    public void Consumer_has_orders_write_but_still_bound_by_ownership()
    {
        var policy = new ToolPolicy("mutate_order", OAuthScopes.OrdersWrite, ToolAccessMode.SelfOrInternal, "customerId");
        var consumer = Consumer(customerId: 100);
        Assert.Contains(OAuthScopes.OrdersWrite, consumer.Scopes);

        var other = _eval.Evaluate(consumer, policy, 999, true);
        Assert.False(other.Allowed);
        Assert.Equal(AuthorizationOutcome.DenyOwnership, other.Outcome);
    }
}
