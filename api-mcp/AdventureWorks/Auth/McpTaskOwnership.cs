using System.Security.Claims;
using ModelContextProtocol;

namespace AdventureWorks.Auth;

public sealed record McpTaskOwner(string Subject, string Application, string Category, string Tool, string RequiredScope);

public sealed class McpTaskOwnership(AuthorizationServerOptions options)
{
    private sealed record Binding(CallerContext Caller, string? Tool, ILogger Logger);
    private readonly AsyncLocal<Binding?> _current = new();

    public IDisposable Bind(ClaimsPrincipal? user, string? tool, ILogger logger)
    {
        var previous = _current.Value;
        _current.Value = new(new CallerContext
        {
            Subject = user?.GetSubjectId() ?? "",
            Category = user?.GetCategory() ?? UserCategories.Anonymous,
            Application = user?.GetApplication(),
            Scopes = user?.GetScopeSet() ?? new HashSet<string>(StringComparer.Ordinal),
        }, tool, logger);
        return new BindingScope(() => _current.Value = previous);
    }

    public McpTaskOwner AuthorizeCreation()
    {
        var binding = RequireCaller();
        var policy = ToolAuthorizationRegistry.Find(binding.Tool ?? "");
        if (policy is null || !binding.Caller.HasScope(policy.RequiredScope) ||
            policy.Mode == ToolAccessMode.InternalOnly && binding.Caller.IsConsumer ||
            !IsServiceToolAllowed(binding, policy.Tool))
            throw Denied(binding, "create");
        return new(binding.Caller.Subject, binding.Caller.Application!, binding.Caller.Category,
            policy.Tool, policy.RequiredScope);
    }

    public void AuthorizeAccess(McpTaskOwner? owner)
    {
        var binding = RequireCaller();
        var policy = ToolAuthorizationRegistry.Find(owner?.Tool ?? "");
        if (owner is null || string.IsNullOrWhiteSpace(owner.RequiredScope) ||
            policy is null || policy.RequiredScope != owner.RequiredScope ||
            policy.Mode == ToolAccessMode.InternalOnly && binding.Caller.IsConsumer ||
            owner.Subject != binding.Caller.Subject || owner.Application != binding.Caller.Application ||
            owner.Category != binding.Caller.Category ||
            !binding.Caller.HasScope(owner.RequiredScope) ||
            !IsServiceToolAllowed(binding, policy.Tool))
            throw Denied(binding, "access");
    }

    private bool IsServiceToolAllowed(Binding binding, string tool) =>
        binding.Caller.Category != UserCategories.Service ||
        binding.Caller.Application == AuthorizationServerOptions.ServiceClientId &&
        ServicePrincipalPolicy.CanCall(options, binding.Caller.Subject, tool);

    private Binding RequireCaller()
    {
        var binding = _current.Value;
        if (binding is null)
            throw new McpProtocolException("Task is not available.", McpErrorCode.InvalidParams);
        if (!binding.Caller.IsKnownCategory || string.IsNullOrWhiteSpace(binding.Caller.Subject) ||
            string.IsNullOrWhiteSpace(binding.Caller.Application) ||
            !binding.Caller.HasScope(OAuthScopes.McpAccess))
            throw Denied(binding, "identity");
        return binding;
    }

    private static McpProtocolException Denied(Binding binding, string operation)
    {
        binding.Logger.LogWarning(
            "MCP task authorization DENY: operation={Operation} subject={Subject} app={Application}",
            operation, binding.Caller.Subject, binding.Caller.Application);
        return new("Task is not available.", McpErrorCode.InvalidParams);
    }

    private sealed class BindingScope(Action restore) : IDisposable
    {
        private Action? _restore = restore;
        public void Dispose() => Interlocked.Exchange(ref _restore, null)?.Invoke();
    }
}
