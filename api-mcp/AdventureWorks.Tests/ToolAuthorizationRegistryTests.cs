using AdventureWorks.Auth;
using AdventureWorks.Services;
using System.Text.Json;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Verifies the complete tool→scope policy map: every MCP tool is classified, every
/// required scope is a known business scope, and ownership tools declare an owner argument.
/// </summary>
public class ToolAuthorizationRegistryTests
{
    // The authoritative count of MCP tools discovered by reflection over the built assembly:
    // AdventureWorksMcpTools(20) + BankMcpTools(9) + CustomerGeneratorMcpTools(2)
    // + SimulatorMcpTools(1) + ManufacturingMcpTools(20) + SupplyChainMcpTools(11) = 63.
    private const int ExpectedToolCount = 63;

    [Fact]
    public void Registry_contains_all_63_tools()
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
    [InlineData("get_product_availability", OAuthScopes.ProductsRead, ToolAccessMode.Public)]
    [InlineData("check_inventory_availability", OAuthScopes.InventoryRead, ToolAccessMode.InternalOnly)]
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

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    [InlineData(null)]
    public void Customer_availability_contains_no_inventory_details(bool? inStock)
    {
        using var result = JsonDocument.Parse(ProductService.FormatProductAvailability(42, inStock));
        var properties = result.RootElement.EnumerateObject().Select(property => property.Name).ToArray();
        Assert.Equal(["productId", "inStock"], properties);
        Assert.Equal(42, result.RootElement.GetProperty("productId").GetInt32());
        var value = result.RootElement.GetProperty("inStock");
        if (inStock is null)
            Assert.Equal(JsonValueKind.Null, value.ValueKind);
        else
            Assert.Equal(inStock.Value, value.GetBoolean());
    }

    [Fact]
    public void Unknown_tool_has_no_policy()
    {
        Assert.Null(ToolAuthorizationRegistry.Find("this_tool_does_not_exist"));
    }
}
