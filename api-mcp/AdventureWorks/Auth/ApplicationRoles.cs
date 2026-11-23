namespace AdventureWorks.Auth;

/// <summary>
/// User categories derived from the AdventureWorks database. A category is a broad
/// population; a <see cref="ApplicationRoles">role</see> is the finer-grained,
/// source-controlled mapping that resolves to OAuth scopes.
/// </summary>
public static class UserCategories
{
    /// <summary>External e-shop consumer (individual customer: Person.PersonType = 'IN').</summary>
    public const string Consumer = "consumer";

    /// <summary>Internal employee administering e-shop / business data (Person.PersonType = 'EM').</summary>
    public const string Employee = "employee";

    /// <summary>Internal manufacturing engineer / warehouse operator (employee in a Manufacturing/Inventory department).</summary>
    public const string Manufacturing = "manufacturing";

    /// <summary>Unauthenticated / anonymous browser. Never issued an MCP access token.</summary>
    public const string Anonymous = "anonymous";

    /// <summary>
    /// Trusted backend workload (e.g. the api-functions managed identity invoking Foundry agents)
    /// that obtained an MCP token via the managed-identity assertion grant. Treated as internal.
    /// </summary>
    public const string Service = "service";
}

/// <summary>
/// Source-controlled application roles, scopes and current-department role mapping.
/// Employee permissions are never selected by user name.
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

    private static readonly IReadOnlyDictionary<int, string> DepartmentRoles = new Dictionary<int, string>
    {
        [3] = SalesAdmin,
        [4] = MarketingAdmin,
        [5] = InventoryAdmin,
        [15] = InventoryAdmin,
        [7] = ManufacturingEngineer,
        [8] = ManufacturingEngineer,
        [16] = ExecutiveAdmin,
    };

    public static string RoleForDepartment(int? departmentId) =>
        departmentId is int id && DepartmentRoles.TryGetValue(id, out var role)
            ? role
            : OperationsAdmin;

    /// <summary>
    /// Deterministic, source-controlled role → scope grants used by the authorization server.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string[]> DefaultRoleScopes = new Dictionary<string, string[]>
    {
        [Consumer] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.RealtimeConnect, OAuthScopes.ProductsRead, OAuthScopes.OrdersRead, OAuthScopes.OrdersWrite,
            // Own-profile self-service (e.g. their addresses via the Functions API). Restricted
            // to owned rows by record-level ownership; internal-only endpoints add a category gate.
            OAuthScopes.CustomersRead, OAuthScopes.CustomersWrite,
        },
        [SalesAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.RealtimeConnect, OAuthScopes.ProductsRead, OAuthScopes.SalesRead, OAuthScopes.CustomersRead,
            OAuthScopes.CustomersWrite, OAuthScopes.OrdersRead, OAuthScopes.AdminRead,
        },
        [MarketingAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.RealtimeConnect, OAuthScopes.ProductsRead, OAuthScopes.SalesRead, OAuthScopes.CustomersRead,
            OAuthScopes.CustomersWrite, OAuthScopes.AdminRead, OAuthScopes.AdminWrite,
        },
        [InventoryAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.RealtimeConnect, OAuthScopes.ProductsRead, OAuthScopes.InventoryRead, OAuthScopes.ManufacturingRead,
            OAuthScopes.AdminRead,
        },
        [OperationsAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.RealtimeConnect, OAuthScopes.ProductsRead, OAuthScopes.SalesRead, OAuthScopes.CustomersRead,
            OAuthScopes.CustomersWrite, OAuthScopes.OrdersRead, OAuthScopes.InventoryRead, OAuthScopes.AdminRead,
        },
        [ExecutiveAdmin] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.RealtimeConnect, OAuthScopes.ProductsRead, OAuthScopes.SalesRead, OAuthScopes.CustomersRead,
            OAuthScopes.CustomersWrite, OAuthScopes.InventoryRead, OAuthScopes.ManufacturingRead, OAuthScopes.OrdersRead,
            OAuthScopes.OrdersWrite, OAuthScopes.AdminRead, OAuthScopes.AdminWrite, OAuthScopes.McpAdmin,
            OAuthScopes.MonitoringRead, OAuthScopes.MonitoringWrite,
        },
        [ManufacturingEngineer] = new[]
        {
            OAuthScopes.McpAccess, OAuthScopes.RealtimeConnect, OAuthScopes.ProductsRead, OAuthScopes.InventoryRead,
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
