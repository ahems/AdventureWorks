namespace AdventureWorks.Auth;

/// <summary>
/// Canonical business-domain OAuth scopes exposed by the AdventureWorks MCP
/// authorization server. These are advertised in authorization-server metadata,
/// registered with OpenIddict, granted to roles, and required by MCP tools.
///
/// Scopes are intentionally coarse business domains (not per-tool). Ownership /
/// record-level checks are layered on top of scopes for consumer self-access
/// (see <see cref="ToolAccessMode"/> and the ownership filter).
/// </summary>
public static class OAuthScopes
{
    /// <summary>Baseline scope required for any authenticated MCP connectivity.</summary>
    public const string McpAccess = "mcp.access";

    /// <summary>Public product catalog: search, details, recommendations, reviews, promotions.</summary>
    public const string ProductsRead = "products.read";

    /// <summary>Internal sales summaries, analytics and financial reporting.</summary>
    public const string SalesRead = "sales.read";

    /// <summary>Internal customer lookup / enumeration. Consumer self-access is handled by ownership, not this scope.</summary>
    public const string CustomersRead = "customers.read";

    /// <summary>Internal inventory levels and availability detail.</summary>
    public const string InventoryRead = "inventory.read";

    /// <summary>Order history / status. Consumers are restricted to their own orders via ownership.</summary>
    public const string OrdersRead = "orders.read";

    /// <summary>Permitted order changes under current business rules.</summary>
    public const string OrdersWrite = "orders.write";

    /// <summary>Manufacturing plans, work orders, feasibility, simulations and production data (read).</summary>
    public const string ManufacturingRead = "manufacturing.read";

    /// <summary>Manufacturing / supply-chain mutations: runs, supply orders, configuration.</summary>
    public const string ManufacturingWrite = "manufacturing.write";

    /// <summary>Internal administration (read): promotion candidates and admin dashboards.</summary>
    public const string AdminRead = "admin.read";

    /// <summary>Internal administration (write): data generation, bank operations.</summary>
    public const string AdminWrite = "admin.write";

    /// <summary>Security-sensitive / broad MCP administration (e.g. simulator reset).</summary>
    public const string McpAdmin = "mcp.admin";

    /// <summary>Human-readable descriptions surfaced in metadata and the inspection UI.</summary>
    public static readonly IReadOnlyDictionary<string, string> Descriptions = new Dictionary<string, string>
    {
        [McpAccess] = "Connect to the AdventureWorks MCP server",
        [ProductsRead] = "Browse the public product catalog, recommendations and reviews",
        [SalesRead] = "Read internal sales analytics and financial summaries",
        [CustomersRead] = "Look up internal customer records",
        [InventoryRead] = "Read internal inventory levels and availability",
        [OrdersRead] = "Read order history and status",
        [OrdersWrite] = "Make permitted changes to orders",
        [ManufacturingRead] = "Read manufacturing and supply-chain data",
        [ManufacturingWrite] = "Run manufacturing operations and place supply orders",
        [AdminRead] = "Read internal administration data",
        [AdminWrite] = "Perform internal administration actions",
        [McpAdmin] = "Administer the MCP server (sensitive operations)",
    };

    /// <summary>All scopes in advertisement order.</summary>
    public static readonly IReadOnlyList<string> All = new[]
    {
        McpAccess,
        ProductsRead,
        SalesRead,
        CustomersRead,
        InventoryRead,
        OrdersRead,
        OrdersWrite,
        ManufacturingRead,
        ManufacturingWrite,
        AdminRead,
        AdminWrite,
        McpAdmin,
    };

    public static bool IsKnown(string scope) => Descriptions.ContainsKey(scope);
}
