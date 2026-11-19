namespace AdventureWorks.Auth;

/// <summary>Server-owned scope and tool boundaries for the deployed workload identities.</summary>
internal static class ServicePrincipalPolicy
{
    private sealed record Policy(IReadOnlySet<string> Scopes, IReadOnlySet<string> Tools);

    private static readonly Policy Functions = new(
        new HashSet<string>(StringComparer.Ordinal)
        {
            OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.InventoryRead,
            OAuthScopes.CustomersRead, OAuthScopes.OrdersRead, OAuthScopes.AdminWrite,
        },
        new HashSet<string>(StringComparer.Ordinal)
        {
            "search_products", "get_product_details", "get_categories_with_products",
            "get_active_promotions", "find_complementary_products", "check_inventory_availability",
            "search_customers", "get_customer_orders", "get_order_details",
            "get_personalized_recommendations", "generate_random_customer",
            "generate_random_customer_for_locale",
        });

    private static readonly Policy HostedManufacturing = new(
        new HashSet<string>(StringComparer.Ordinal)
        {
            OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.OrdersRead,
            OAuthScopes.InventoryRead, OAuthScopes.ManufacturingRead, OAuthScopes.ManufacturingWrite,
        },
        new HashSet<string>(StringComparer.Ordinal)
        {
            "get_manufacturing_status", "get_active_manufacturing_operations",
            "get_production_feasibility", "get_all_products_feasibility",
            "get_manufacturing_catalog_snapshot", "get_overstock_items",
            "get_thin_margin_products", "get_component_shortage_forecast",
            "get_reorder_recommendations", "get_supply_chain_vendors", "get_vendor_details",
            "get_supply_catalog", "get_supply_quote", "get_active_supply_orders",
            "get_supply_order_history", "get_order_details", "check_inventory_availability",
            "get_product_details", "begin_manufacturing_run", "place_supply_order",
        });

    internal static bool CanGrant(AuthorizationServerOptions options, string principal, IEnumerable<string> scopes) =>
        Find(options, principal) is { } policy && scopes.All(policy.Scopes.Contains);

    internal static bool CanCall(AuthorizationServerOptions options, string subject, string tool) =>
        subject.StartsWith("service:", StringComparison.Ordinal) &&
        Find(options, subject["service:".Length..]) is { } policy && policy.Tools.Contains(tool);

    private static Policy? Find(AuthorizationServerOptions options, string principal)
    {
        if (!Guid.TryParse(principal, out var id) || id == Guid.Empty ||
            !options.TrustedServicePrincipalIds.Contains(principal))
            return null;

        var hasFunctions = Guid.TryParse(options.FunctionsServicePrincipalId, out var functions) &&
                           functions != Guid.Empty;
        var hasHosted = Guid.TryParse(options.HostedManufacturingServicePrincipalId, out var hosted) &&
                        hosted != Guid.Empty;
        if (hasFunctions && hasHosted && functions == hosted)
            return null;
        if (hasFunctions && id == functions)
            return Functions;
        return hasHosted && id == hosted ? HostedManufacturing : null;
    }

    internal static void Validate()
    {
        foreach (var profile in new[] { Functions, HostedManufacturing })
        {
            foreach (var tool in profile.Tools)
            {
                var policy = ToolAuthorizationRegistry.Find(tool);
                if (policy is null || !profile.Scopes.Contains(policy.RequiredScope))
                    throw new InvalidOperationException($"Service tool '{tool}' lacks a matching scope policy.");
            }
        }
    }
}
