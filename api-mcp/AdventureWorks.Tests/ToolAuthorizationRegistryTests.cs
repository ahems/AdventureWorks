using AdventureWorks.Auth;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Verifies the complete tool→scope policy map: every MCP tool is classified, every
/// required scope is a known business scope, and ownership tools declare an owner argument.
/// </summary>
public class ToolAuthorizationRegistryTests
{
    // The authoritative count of MCP tools discovered by reflection over the built assembly:
    // AdventureWorksMcpTools(19) + BankMcpTools(9) + CustomerGeneratorMcpTools(2)
    // + SimulatorMcpTools(1) + ManufacturingMcpTools(20) + SupplyChainMcpTools(11) = 62.
    private const int ExpectedToolCount = 62;

    [Fact]
    public void Registry_contains_all_62_tools()
    {
        Assert.Equal(ExpectedToolCount, ToolAuthorizationRegistry.All.Count);
    }

    [Fact]
    public void Every_tool_requires_a_known_scope()
    {
        foreach (var policy in ToolAuthorizationRegistry.All)
        {
            Assert.True(OAuthScopes.IsKnown(policy.RequiredScope),
                $"Tool '{policy.Tool}' requires unknown scope '{policy.RequiredScope}'.");
        }
    }

    [Fact]
    public void Tool_names_are_unique_and_snake_case()
    {
        var names = ToolAuthorizationRegistry.ToolNames.ToList();
        Assert.Equal(names.Count, names.Distinct(StringComparer.Ordinal).Count());

        foreach (var name in names)
        {
            Assert.Matches("^[a-z0-9]+(_[a-z0-9]+)*$", name);
        }
    }

    [Fact]
    public void Ownership_tools_declare_an_owner_argument()
    {
        foreach (var policy in ToolAuthorizationRegistry.All.Where(p => p.Mode == ToolAccessMode.SelfOrInternal))
        {
            Assert.False(string.IsNullOrWhiteSpace(policy.OwnerArgument),
                $"SelfOrInternal tool '{policy.Tool}' must declare an OwnerArgument.");
        }
    }

    [Fact]
    public void Non_ownership_tools_do_not_declare_an_owner_argument()
    {
        foreach (var policy in ToolAuthorizationRegistry.All.Where(p => p.Mode != ToolAccessMode.SelfOrInternal))
        {
            Assert.True(policy.OwnerArgument is null,
                $"Tool '{policy.Tool}' with mode {policy.Mode} should not declare an OwnerArgument.");
        }
    }

    [Theory]
    [InlineData("search_products", OAuthScopes.ProductsRead, ToolAccessMode.Public)]
    [InlineData("get_customer_orders", OAuthScopes.OrdersRead, ToolAccessMode.SelfOrInternal)]
    [InlineData("search_customers", OAuthScopes.CustomersRead, ToolAccessMode.InternalOnly)]
    [InlineData("get_business_stats", OAuthScopes.SalesRead, ToolAccessMode.InternalOnly)]
    [InlineData("get_manufacturing_status", OAuthScopes.ManufacturingRead, ToolAccessMode.InternalOnly)]
    [InlineData("begin_manufacturing_run", OAuthScopes.ManufacturingWrite, ToolAccessMode.InternalOnly)]
    [InlineData("reset_all_simulators", OAuthScopes.McpAdmin, ToolAccessMode.InternalOnly)]
    public void Known_tools_have_expected_policy(string tool, string scope, ToolAccessMode mode)
    {
        var policy = ToolAuthorizationRegistry.Find(tool);
        Assert.NotNull(policy);
        Assert.Equal(scope, policy!.RequiredScope);
        Assert.Equal(mode, policy.Mode);
    }

    [Fact]
    public void Unknown_tool_has_no_policy()
    {
        Assert.Null(ToolAuthorizationRegistry.Find("this_tool_does_not_exist"));
    }
}
