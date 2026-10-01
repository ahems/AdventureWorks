namespace ApiFunctions.Auth;

/// <summary>
/// Authorization tier for a Functions HTTP route, mirroring the classification in
/// <c>docs/features/functions-oauth/ROUTE_SCOPE_MATRIX.md</c>.
/// </summary>
public enum AccessTier
{
    /// <summary>Tier P — anonymous. No token required (health, discovery, pre-auth, public catalog, AI-assistant pass-through).</summary>
    Public,

    /// <summary>Tier C — consumer self-service with record-level ownership (internal roles unrestricted).</summary>
    Consumer,

    /// <summary>Tier I — internal-only. Valid token + scope + non-consumer category.</summary>
    Internal,

    /// <summary>
    /// Tier M — reachable through an api-mcp proxy tool; left anonymous in v1 because api-mcp
    /// cannot yet mint a Functions-audience token (documented descope). Still protected at the
    /// MCP layer.
    /// </summary>
    ProxiedAnonymous,
}

/// <summary>Access mode describing who may call a route once scope is satisfied.</summary>
public enum AccessMode
{
    /// <summary>No token required.</summary>
    Anonymous,

    /// <summary>Consumers restricted to their own records (server-resolved owner id); internal roles unrestricted.</summary>
    SelfOrInternal,

    /// <summary>Internal (non-consumer) categories only.</summary>
    InternalOnly,
}

/// <summary>
/// Business-domain scope names. String constants mirror
/// <c>api-mcp/AdventureWorks/Auth/OAuthScopes.cs</c> — the authorization server is the source of
/// truth; api-functions is a pure resource server that only needs the names to compare against
/// the validated token's <c>scope</c> claim.
/// </summary>
public static class FunctionScopes
{
    public const string McpAccess = "mcp.access";
    public const string ProductsRead = "products.read";
    public const string InventoryRead = "inventory.read";
    public const string OrdersRead = "orders.read";
    public const string OrdersWrite = "orders.write";
    public const string CustomersRead = "customers.read";
    public const string CustomersWrite = "customers.write";
    public const string SalesRead = "sales.read";
    public const string ManufacturingRead = "manufacturing.read";
    public const string ManufacturingWrite = "manufacturing.write";
    public const string AdminRead = "admin.read";
    public const string AdminWrite = "admin.write";
}

/// <summary>
/// AdventureWorks user categories carried in the token <c>category</c> claim. Any value other
/// than <see cref="Consumer"/> is treated as an internal (employee) category for Tier I checks.
/// </summary>
public static class UserCategories
{
    public const string Consumer = "consumer";
}

/// <summary>
/// Immutable authorization policy for a single Azure Function (keyed by the <c>[Function]</c>
/// name, which is unique per HTTP route+method). Generated from the authoritative route matrix.
/// </summary>
/// <param name="FunctionName">The <c>[Function("name")]</c> value (<c>FunctionContext.FunctionDefinition.Name</c>).</param>
/// <param name="Tier">Authorization tier.</param>
/// <param name="RequiredScope">Business-domain scope the token must carry; <c>null</c> for anonymous tiers.</param>
/// <param name="Mode">Access mode (ownership / internal-only / anonymous).</param>
/// <param name="OwnershipKey">For Tier C, the request parameter whose owner must match the caller; otherwise <c>null</c>.</param>
public sealed record FunctionPolicy(
    string FunctionName,
    AccessTier Tier,
    string? RequiredScope,
    AccessMode Mode,
    string? OwnershipKey)
{
    /// <summary>True when the route requires no access token (Tier P or the v1-descoped Tier M).</summary>
    public bool IsAnonymous => Tier is AccessTier.Public or AccessTier.ProxiedAnonymous;
}
