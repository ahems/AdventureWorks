using System.Diagnostics;
using System.Text.Json;
using Microsoft.ApplicationInsights;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace AdventureWorks.Auth;

/// <summary>
/// Server-side MCP tool authorization: for every <c>tools/call</c> it re-evaluates the
/// validated token's scopes and (for consumers) record ownership against the caller's
/// server-resolved CustomerID. Denials short-circuit with a safe error result; ownership
/// arguments are injected so consumers are always scoped to their own data.
///
/// Structured decisions are logged (subject, category, app, tool, required scope, outcome,
/// correlation id) with no tokens, secrets or customer PII.
/// </summary>
public static class McpToolAuthorizationFilter
{
    private const string CustomerIdItemKey = "aw.caller.customerId";
    private const string CustomerIdResolvedItemKey = "aw.caller.customerId.resolved";

    /// <summary>
    /// Evaluates authorization for the current tool call. Returns null to allow (after any
    /// ownership injection), or a non-null error <see cref="CallToolResult"/> to deny.
    /// </summary>
    public static async ValueTask<CallToolResult?> AuthorizeAsync(
        RequestContext<CallToolRequestParams> context,
        CancellationToken ct)
    {
        var services = context.Services!;
        var loggerFactory = services.GetRequiredService<ILoggerFactory>();
        var logger = loggerFactory.CreateLogger("AdventureWorks.Auth.McpToolAuthorization");
        var evaluator = services.GetRequiredService<ToolAuthorizationEvaluator>();
        var telemetry = services.GetService<TelemetryClient>();

        var toolName = context.Params?.Name ?? "(unknown)";
        var correlationId = Activity.Current?.Id ?? Guid.NewGuid().ToString("N");

        var user = context.User;
        if (user?.Identity?.IsAuthenticated != true)
        {
            LogAndTrack(logger, telemetry, "(anonymous)", UserCategories.Anonymous, null, toolName, "(none)",
                AuthorizationOutcome.DenyMcpAccess, correlationId);
            return Error("Authentication is required to use this tool.");
        }

        var subject = user.GetSubjectId() ?? "(unknown)";
        var category = user.GetCategory();
        var application = user.GetApplication();
        var scopes = user.GetScopeSet();

        int? customerId = null;
        if (category == UserCategories.Consumer)
        {
            customerId = await ResolveCustomerIdAsync(context, services, subject, ct);
        }

        var caller = new CallerContext
        {
            Subject = subject,
            Category = category,
            Scopes = scopes,
            CustomerId = customerId,
            Application = application,
        };

        var policy = ToolAuthorizationRegistry.Find(toolName);
        var (ownerValue, ownerPresent) = ExtractOwnerArgument(context.Params?.Arguments, policy?.OwnerArgument);

        var decision = evaluator.Evaluate(caller, toolName, ownerValue, ownerPresent);

        LogAndTrack(logger, telemetry, subject, category, application, toolName,
            decision.RequiredScope, decision.Outcome, correlationId);

        if (!decision.Allowed)
        {
            return Error(decision.SafeMessage);
        }

        // Ownership injection: scope a consumer's owner argument to their own CustomerID.
        if (decision.InjectCustomerId is int injected && policy?.OwnerArgument is { } ownerArg)
        {
            var args = context.Params!.Arguments as IDictionary<string, JsonElement>;
            if (args is null)
            {
                args = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                context.Params!.Arguments = args;
            }

            args[ownerArg] = JsonSerializer.SerializeToElement(injected);
        }

        return null;
    }

    private static async Task<int?> ResolveCustomerIdAsync(
        RequestContext<CallToolRequestParams> context,
        IServiceProvider services,
        string subject,
        CancellationToken ct)
    {
        // Cache within the request to avoid duplicate lookups.
        if (context.Items.TryGetValue(CustomerIdResolvedItemKey, out _))
        {
            return context.Items.TryGetValue(CustomerIdItemKey, out var cached) ? cached as int? : null;
        }

        int? customerId = null;
        try
        {
            var directory = services.GetService<IUserDirectory>();
            if (directory is not null)
            {
                var resolved = await directory.ResolveBySubjectAsync(subject, ct);
                customerId = resolved?.CustomerId;
            }
        }
        catch (Exception ex)
        {
            services.GetRequiredService<ILoggerFactory>()
                .CreateLogger("AdventureWorks.Auth.McpToolAuthorization")
                .LogWarning(ex, "Failed to resolve caller CustomerID for ownership check; denying ownership-scoped access.");
        }

        context.Items[CustomerIdItemKey] = customerId;
        context.Items[CustomerIdResolvedItemKey] = true;
        return customerId;
    }

    private static (int? value, bool present) ExtractOwnerArgument(
        IDictionary<string, JsonElement>? arguments,
        string? ownerArgument)
    {
        if (ownerArgument is null || arguments is null || !arguments.TryGetValue(ownerArgument, out var element))
        {
            return (null, false);
        }

        switch (element.ValueKind)
        {
            case JsonValueKind.Number when element.TryGetInt32(out var n):
                return (n, true);
            case JsonValueKind.String when int.TryParse(element.GetString(), out var s):
                return (s, true);
            case JsonValueKind.Null:
                return (null, false);
            default:
                // Present but unpar. Treat as present with no usable value (forces deny for consumers).
                return (null, true);
        }
    }

    private static CallToolResult Error(string message) => new()
    {
        IsError = true,
        Content = new List<ContentBlock> { new TextContentBlock { Text = message } },
    };

    private static void LogAndTrack(
        ILogger logger,
        TelemetryClient? telemetry,
        string subject,
        string category,
        string? application,
        string tool,
        string requiredScope,
        AuthorizationOutcome outcome,
        string correlationId)
    {
        var allowed = outcome == AuthorizationOutcome.Allow;
        logger.Log(allowed ? LogLevel.Information : LogLevel.Warning,
            "MCP authorization {Result}: tool={Tool} subject={Subject} category={Category} app={App} requiredScope={RequiredScope} outcome={Outcome} correlationId={CorrelationId}",
            allowed ? "ALLOW" : "DENY", tool, subject, category, application ?? "(none)", requiredScope, outcome, correlationId);

        telemetry?.TrackEvent("McpToolAuthorization", new Dictionary<string, string>
        {
            ["tool"] = tool,
            ["subject"] = subject,
            ["category"] = category,
            ["app"] = application ?? "(none)",
            ["requiredScope"] = requiredScope,
            ["outcome"] = outcome.ToString(),
            ["allowed"] = allowed ? "true" : "false",
            ["correlationId"] = correlationId,
        });
    }
}
