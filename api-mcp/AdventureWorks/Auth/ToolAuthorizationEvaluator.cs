namespace AdventureWorks.Auth;

/// <summary>The validated caller identity used for tool authorization decisions.</summary>
public sealed class CallerContext
{
    public required string Subject { get; init; }
    public required string Category { get; init; }
    public required IReadOnlySet<string> Scopes { get; init; }
    public int? CustomerId { get; init; }
    public string? Application { get; init; }

    public bool IsConsumer => Category == UserCategories.Consumer;
    public bool HasScope(string scope) => Scopes.Contains(scope);
}

/// <summary>Outcome category for structured logging (never contains tokens or PII).</summary>
public enum AuthorizationOutcome
{
    Allow,
    DenyUnclassified,
    DenyMcpAccess,
    DenyScope,
    DenyInternalOnly,
    DenyOwnership,
    DenyNoCustomer,
}

/// <summary>Result of a tool authorization evaluation.</summary>
/// <param name="Allowed">Whether the call is permitted.</param>
/// <param name="Outcome">Structured decision category.</param>
/// <param name="RequiredScope">The scope the tool required.</param>
/// <param name="InjectCustomerId">
/// When set, the ownership argument should be set to this value before invoking the tool
/// (used to scope a consumer's optional owner argument to their own records).
/// </param>
public sealed record AuthorizationDecision(
    bool Allowed,
    AuthorizationOutcome Outcome,
    string RequiredScope,
    int? InjectCustomerId = null)
{
    public string SafeMessage => Outcome switch
    {
        AuthorizationOutcome.Allow => "authorized",
        AuthorizationOutcome.DenyUnclassified => "This tool is not available.",
        AuthorizationOutcome.DenyMcpAccess => "Authentication with the 'mcp.access' scope is required.",
        AuthorizationOutcome.DenyScope => $"This operation requires the '{RequiredScope}' scope, which your account does not have.",
        AuthorizationOutcome.DenyInternalOnly => "This operation is restricted to internal users.",
        AuthorizationOutcome.DenyOwnership => "You can only access your own records.",
        AuthorizationOutcome.DenyNoCustomer => "No customer profile is associated with your account.",
        _ => "Not authorized.",
    };
}

/// <summary>
/// Pure, server-side authorization evaluator. Combines scope checks with record-level
/// ownership for consumer self-access. Contains no ASP.NET or JSON dependencies so it is
/// fully unit-testable.
/// </summary>
public sealed class ToolAuthorizationEvaluator
{
    /// <summary>Evaluates by tool name (looks up the policy).</summary>
    public AuthorizationDecision Evaluate(CallerContext caller, string toolName, int? ownerArgValue, bool ownerArgPresent)
    {
        var policy = ToolAuthorizationRegistry.Find(toolName);
        if (policy is null)
        {
            // Fail closed: an unclassified tool is never callable.
            return new AuthorizationDecision(false, AuthorizationOutcome.DenyUnclassified, "(none)");
        }

        return Evaluate(caller, policy, ownerArgValue, ownerArgPresent);
    }

    /// <summary>Evaluates against an explicit policy.</summary>
    public AuthorizationDecision Evaluate(CallerContext caller, ToolPolicy policy, int? ownerArgValue, bool ownerArgPresent)
    {
        // Baseline connectivity scope.
        if (!caller.HasScope(OAuthScopes.McpAccess))
        {
            return new AuthorizationDecision(false, AuthorizationOutcome.DenyMcpAccess, policy.RequiredScope);
        }

        // Required business scope.
        if (!caller.HasScope(policy.RequiredScope))
        {
            return new AuthorizationDecision(false, AuthorizationOutcome.DenyScope, policy.RequiredScope);
        }

        switch (policy.Mode)
        {
            case ToolAccessMode.Public:
                return new AuthorizationDecision(true, AuthorizationOutcome.Allow, policy.RequiredScope);

            case ToolAccessMode.InternalOnly:
                // Defense in depth: consumers can never call internal-only tools even if a
                // token somehow carried the scope.
                return caller.IsConsumer
                    ? new AuthorizationDecision(false, AuthorizationOutcome.DenyInternalOnly, policy.RequiredScope)
                    : new AuthorizationDecision(true, AuthorizationOutcome.Allow, policy.RequiredScope);

            case ToolAccessMode.SelfOrInternal:
                if (!caller.IsConsumer)
                {
                    // Internal roles holding the scope are unrestricted.
                    return new AuthorizationDecision(true, AuthorizationOutcome.Allow, policy.RequiredScope);
                }

                // Consumer: enforce ownership against their resolved CustomerID (server-side).
                if (caller.CustomerId is null)
                {
                    return new AuthorizationDecision(false, AuthorizationOutcome.DenyNoCustomer, policy.RequiredScope);
                }

                if (!ownerArgPresent || ownerArgValue is null)
                {
                    // Owner argument omitted: scope it to the caller's own records.
                    return new AuthorizationDecision(true, AuthorizationOutcome.Allow, policy.RequiredScope, caller.CustomerId);
                }

                return ownerArgValue.Value == caller.CustomerId.Value
                    ? new AuthorizationDecision(true, AuthorizationOutcome.Allow, policy.RequiredScope)
                    : new AuthorizationDecision(false, AuthorizationOutcome.DenyOwnership, policy.RequiredScope);

            default:
                return new AuthorizationDecision(false, AuthorizationOutcome.DenyUnclassified, policy.RequiredScope);
        }
    }
}
