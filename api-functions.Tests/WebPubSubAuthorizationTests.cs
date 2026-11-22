using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.Services;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class WebPubSubAuthorizationTests
{
    private static FunctionUser User(string category, params string[] scopes) => new()
    {
        Category = category,
        IsAuthenticated = true,
        Scopes = scopes.ToHashSet(StringComparer.Ordinal),
    };

    [Fact]
    public void Realtime_groups_require_an_authenticated_realtime_scope()
    {
        Assert.Empty(WebPubSubService.GetAuthorizedGroups(FunctionUser.Anonymous));
        Assert.Empty(WebPubSubService.GetAuthorizedGroups(User(UserCategories.Consumer, FunctionScopes.OrdersRead)));
    }

    [Fact]
    public void Workload_service_identity_cannot_mint_a_browser_group_capability()
    {
        var service = User(UserCategories.Service,
            FunctionScopes.RealtimeConnect,
            FunctionScopes.OrdersRead,
            FunctionScopes.AdminRead);

        Assert.Empty(WebPubSubService.GetAuthorizedGroups(service));
    }

    [Fact]
    public void Consumer_receives_only_the_order_invalidation_group_even_with_internal_scopes()
    {
        var user = User(UserCategories.Consumer,
            FunctionScopes.RealtimeConnect,
            FunctionScopes.OrdersRead,
            FunctionScopes.AdminRead,
            FunctionScopes.ManufacturingRead,
            FunctionScopes.InventoryRead);

        Assert.Equal(["orders"], WebPubSubService.GetAuthorizedGroups(user));
    }

    [Fact]
    public void Internal_groups_require_both_a_matching_scope_and_internal_category()
    {
        var salesAdmin = User(UserCategories.Employee,
            FunctionScopes.RealtimeConnect,
            FunctionScopes.OrdersRead,
            FunctionScopes.SalesRead,
            FunctionScopes.AdminRead);

        var groups = WebPubSubService.GetAuthorizedGroups(salesAdmin);

        Assert.Contains("orders", groups);
        Assert.Contains("finance", groups);
        Assert.Contains("reviews", groups);
        Assert.Contains("promotions", groups);
        Assert.Contains("utilities", groups);
        Assert.DoesNotContain("warehouse", groups);
        Assert.DoesNotContain("manufacturing-ops", groups);
    }

    [Fact]
    public void Manufacturing_scopes_do_not_grant_order_or_admin_groups()
    {
        var manufacturing = User(UserCategories.Manufacturing,
            FunctionScopes.RealtimeConnect,
            FunctionScopes.ManufacturingRead,
            FunctionScopes.InventoryRead);

        var groups = WebPubSubService.GetAuthorizedGroups(manufacturing);

        Assert.Contains("manufacturing-agent", groups);
        Assert.Contains("manufacturing-ops", groups);
        Assert.Contains("warehouse", groups);
        Assert.Contains("supply-chain", groups);
        Assert.Contains("shopping-simulator", groups);
        Assert.Contains("finance", groups);
        Assert.Contains("orders", groups);
        Assert.DoesNotContain("reviews", groups);
    }

    [Theory]
    [InlineData(FunctionScopes.InventoryRead)]
    [InlineData(FunctionScopes.ManufacturingRead)]
    public void Warehouse_group_follows_inventory_views_and_warehouse_route_scopes(string scope)
    {
        Assert.Contains("warehouse", WebPubSubService.GetAuthorizedGroups(
            User(UserCategories.Manufacturing, FunctionScopes.RealtimeConnect, scope)));
        Assert.Contains("warehouse", WebPubSubService.GetAuthorizedGroups(
            User(UserCategories.Employee, FunctionScopes.RealtimeConnect, scope)));
        Assert.DoesNotContain("warehouse", WebPubSubService.GetAuthorizedGroups(
            User(UserCategories.Consumer, FunctionScopes.RealtimeConnect, scope)));
    }

    [Theory]
    [InlineData("orders", "orders-changed")]
    [InlineData("finance", "finance-changed")]
    public void Shared_group_payloads_are_reduced_to_nonidentifying_invalidations(string group, string expectedEvent)
    {
        var payload = WebPubSubService.SanitizePayloadForGroup(
            group,
            new
            {
                @event = "order-status-changed",
                salesOrderId = 123,
                customerId = 456,
                newStatus = 7,
                amount = 100.50,
                referenceId = "private-reference",
            });

        using var json = JsonDocument.Parse(JsonSerializer.Serialize(payload));
        Assert.Single(json.RootElement.EnumerateObject());
        Assert.Equal(expectedEvent, json.RootElement.GetProperty("event").GetString());
    }
}
