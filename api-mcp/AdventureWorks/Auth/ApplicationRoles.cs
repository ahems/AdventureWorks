namespace AdventureWorks.Auth;

/// <summary>
/// User categories derived from the AdventureWorks database. A category is a broad
/// population; a <see cref="ApplicationRoles">role</see> is the finer-grained,
/// seed-data-driven mapping that resolves to OAuth scopes.
/// </summary>
public static class UserCategories
{
    /// <summary>External e-shop consumer (Person.PersonType = 'IN' with a Sales.Customer row).</summary>
    public const string Consumer = "consumer";

    /// <summary>Internal employee administering e-shop / business data (Person.PersonType = 'EM').</summary>
    public const string Employee = "employee";

    /// <summary>Internal manufacturing engineer / warehouse operator (employee in a Manufacturing/Inventory department).</summary>
    public const string Manufacturing = "manufacturing";

    /// <summary>Unauthenticated / anonymous browser. Never issued an MCP access token.</summary>
    public const string Anonymous = "anonymous";
}

/// <summary>
/// Application roles. Roles are stored in the <c>Auth.ApplicationRole</c> table and
/// mapped to scopes in <c>Auth.RoleScope</c>; employees are mapped to a role via
/// <c>Auth.DepartmentRole</c> (by current department, never by user name).
///
/// The constants here are the deterministic seed values and are used as safe
/// fallbacks when the database has not yet been extended.
/// </summary>
public static class ApplicationRoles
{
    /// <summary>External consumer: catalog + own orders.</summary>
    public const string Consumer = "consumer";

    /// <summary>Sales department employee.</summary>
    public const string SalesAdmin = "sales-admin";

    /// <summary>Marketing department employee (promotions, data generation).</summary>
    public const string MarketingAdmin = "marketing-admin";

    /// <summary>Inventory / purchasing / shipping employee.</summary>
    public const string InventoryAdmin = "inventory-admin";

    /// <summary>General internal administration (default employee role).</summary>
    public const string OperationsAdmin = "operations-admin";

    /// <summary>Executive: broad administration including sensitive MCP admin.</summary>
    public const string ExecutiveAdmin = "executive-admin";

    /// <summary>Manufacturing engineer / production controller / warehouse operator.</summary>
    public const string ManufacturingEngineer = "manufacturing-engineer";

    /// <summary>
    /// Deterministic role → scope grants. Mirrors the <c>Auth.RoleScope</c> seed data
    /// and is used as an in-process fallback and for tests. The database is the source
    /// of truth at runtime.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string[]> DefaultRoleScopes = new Dictionary<string, string[]>
    {
        [Consumer] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.OrdersRead, OAuthScopes.OrdersWrite,
        },
        [SalesAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.SalesRead, OAuthScopes.CustomersRead,
            OAuthScopes.OrdersRead, OAuthScopes.AdminRead,
        },
        [MarketingAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.SalesRead, OAuthScopes.CustomersRead,
            OAuthScopes.AdminRead, OAuthScopes.AdminWrite,
        },
        [InventoryAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.InventoryRead, OAuthScopes.ManufacturingRead,
            OAuthScopes.AdminRead,
        },
        [OperationsAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.SalesRead, OAuthScopes.CustomersRead,
            OAuthScopes.OrdersRead, OAuthScopes.InventoryRead, OAuthScopes.AdminRead,
        },
        [ExecutiveAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.SalesRead, OAuthScopes.CustomersRead,
            OAuthScopes.InventoryRead, OAuthScopes.ManufacturingRead, OAuthScopes.OrdersRead, OAuthScopes.OrdersWrite,
            OAuthScopes.AdminRead, OAuthScopes.AdminWrite, OAuthScopes.McpAdmin,
        },
        [ManufacturingEngineer] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.ProductsRead, OAuthScopes.InventoryRead,
            OAuthScopes.ManufacturingRead, OAuthScopes.ManufacturingWrite,
        },
    };

    /// <summary>Category that a role belongs to.</summary>
    public static string CategoryFor(string role) => role switch
    {
        Consumer => UserCategories.Consumer,
        ManufacturingEngineer => UserCategories.Manufacturing,
        _ => UserCategories.Employee,
    };
}
