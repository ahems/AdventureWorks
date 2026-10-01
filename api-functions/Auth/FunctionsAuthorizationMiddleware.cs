using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Azure.Functions.Worker.Middleware;
using Microsoft.Extensions.Logging;

namespace ApiFunctions.Auth;

/// <summary>
/// Resource-server authorization for every HTTP-triggered Azure Function. Looks up the per-function
/// <see cref="FunctionPolicy"/> (keyed by the <c>[Function]</c> name), validates the bearer token
/// against the api-mcp authorization server, and enforces scope / category. Record-level ownership
/// (Tier C) is finalized inside the function using the server-resolved owner id stashed on the
/// <see cref="FunctionContext"/>.
///
/// <para>
/// Enforcement is governed by <see cref="FunctionsOAuthOptions.Mode"/>:
/// <list type="bullet">
/// <item><c>Disabled</c> (default) — pure passthrough; behavior is identical to pre-OAuth.</item>
/// <item><c>Audit</c> — validate-if-present and log the decision, but never block.</item>
/// <item><c>Enforced</c> — protected routes require a valid, in-audience, correctly-scoped token.</item>
/// </list>
/// Anonymous tiers (Public and the v1-descoped MCP-proxied set) are always allowed. Unknown
/// functions fail closed under enforcement.
/// </para>
/// </summary>
public sealed class FunctionsAuthorizationMiddleware : IFunctionsWorkerMiddleware
{
    private const string ProtectedResourceMetadataPath = "/.well-known/oauth-protected-resource";

    private readonly FunctionsOAuthOptions _options;
    private readonly FunctionsAccessTokenValidator _validator;
    private readonly ILogger<FunctionsAuthorizationMiddleware> _logger;

    public FunctionsAuthorizationMiddleware(
        FunctionsOAuthOptions options,
        FunctionsAccessTokenValidator validator,
        ILogger<FunctionsAuthorizationMiddleware> logger)
    {
        _options = options;
        _validator = validator;
        _logger = logger;
    }

    public async Task Invoke(FunctionContext context, FunctionExecutionDelegate next)
    {
        // Non-HTTP triggers (timer, queue, durable orchestration/activity) are never web-exposed.
        var request = await context.GetHttpRequestDataAsync();
        if (request is null)
        {
            await next(context);
            return;
        }

        // Disabled mode is a pure passthrough — identical to pre-OAuth behavior.
        if (_options.Mode == OAuthEnforcementMode.Disabled)
        {
            await next(context);
            return;
        }

        var functionName = context.FunctionDefinition.Name;
        var policy = FunctionAuthorizationRegistry.Find(functionName);

        // Unknown function: fail closed under enforcement, warn-and-allow under audit.
        if (policy is null)
        {
            if (_options.Mode == OAuthEnforcementMode.Enforced)
            {
                _logger.LogWarning("Denying unclassified HTTP function {Function} (fail-closed).", functionName);
                await WriteProblemAsync(context, request, HttpStatusCode.Forbidden, "unclassified_function",
                    "This endpoint has no authorization policy and is denied by default.");
                return;
            }

            _logger.LogWarning("Unclassified HTTP function {Function} allowed (audit mode).", functionName);
            await next(context);
            return;
        }

        // Anonymous tiers (Public + v1-descoped ProxiedAnonymous) require no token.
        if (policy.IsAnonymous)
        {
            await next(context);
            return;
        }

        // Protected route: extract and validate the bearer token.
        var token = ExtractBearerToken(request);
        if (string.IsNullOrEmpty(token))
        {
            if (_options.Mode == OAuthEnforcementMode.Enforced)
            {
                await WriteUnauthorizedAsync(context, request, "missing_token", "A bearer access token is required.");
                return;
            }

            _logger.LogInformation("Audit: {Function} called without a token (allowed).", functionName);
            await next(context);
            return;
        }

        var validation = await _validator.ValidateAsync(token, context.CancellationToken);
        if (!validation.Succeeded)
        {
            if (_options.Mode == OAuthEnforcementMode.Enforced)
            {
                await WriteUnauthorizedAsync(context, request, "invalid_token", "The access token is invalid.");
                return;
            }

            _logger.LogInformation("Audit: {Function} token rejected ({Reason}) but allowed.", functionName, validation.Error);
            await next(context);
            return;
        }

        var user = FunctionUser.FromPrincipal(validation.Principal!);

        // Scope check.
        if (!string.IsNullOrEmpty(policy.RequiredScope) && !user.HasScope(policy.RequiredScope))
        {
            if (_options.Mode == OAuthEnforcementMode.Enforced)
            {
                await WriteForbiddenAsync(context, request, "insufficient_scope",
                    $"The token is missing the required scope '{policy.RequiredScope}'.", policy.RequiredScope);
                return;
            }

            _logger.LogInformation("Audit: {Function} missing scope {Scope} (allowed).", functionName, policy.RequiredScope);
        }

        // Category check — internal-only routes reject consumer tokens.
        if (policy.Mode == AccessMode.InternalOnly && user.IsConsumer)
        {
            if (_options.Mode == OAuthEnforcementMode.Enforced)
            {
                await WriteForbiddenAsync(context, request, "forbidden_category",
                    "This endpoint is restricted to internal users.", policy.RequiredScope);
                return;
            }

            _logger.LogInformation("Audit: {Function} called by consumer on internal route (allowed).", functionName);
        }

        // Stash the resolved identity so function bodies can read it (and enforce Tier C ownership
        // via the server-resolved owner id — never a client-supplied value).
        context.Items[FunctionUser.ContextKey] = user;

        await next(context);
    }

    private static string? ExtractBearerToken(HttpRequestData request)
    {
        if (!request.Headers.TryGetValues("Authorization", out var values))
        {
            return null;
        }

        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value) &&
                value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            {
                return value["Bearer ".Length..].Trim();
            }
        }

        return null;
    }

    private Task WriteUnauthorizedAsync(FunctionContext context, HttpRequestData request, string error, string description)
    {
        var challenge = BuildChallenge(error, description);
        return WriteProblemAsync(context, request, HttpStatusCode.Unauthorized, error, description, challenge);
    }

    private Task WriteForbiddenAsync(FunctionContext context, HttpRequestData request, string error, string description, string? scope)
    {
        var challenge = BuildChallenge(error, description, scope);
        return WriteProblemAsync(context, request, HttpStatusCode.Forbidden, error, description, challenge);
    }

    private string BuildChallenge(string error, string description, string? scope = null)
    {
        const string scheme = "Bearer";
        var parts = new List<string> { scheme + " realm=\"adventureworks-functions\"" };
        if (!string.IsNullOrEmpty(_options.Issuer))
        {
            parts.Add($"resource_metadata=\"{_options.Issuer}{ProtectedResourceMetadataPath}\"");
        }

        parts.Add($"error=\"{error}\"");
        parts.Add($"error_description=\"{description}\"");
        if (!string.IsNullOrEmpty(scope))
        {
            parts.Add($"scope=\"{scope}\"");
        }

        return string.Join(", ", parts);
    }

    private static async Task WriteProblemAsync(
        FunctionContext context,
        HttpRequestData request,
        HttpStatusCode status,
        string error,
        string description,
        string? wwwAuthenticate = null)
    {
        var response = request.CreateResponse(status);
        if (!string.IsNullOrEmpty(wwwAuthenticate))
        {
            response.Headers.Add("WWW-Authenticate", wwwAuthenticate);
        }

        response.Headers.Add("Content-Type", "application/json; charset=utf-8");
        var json = JsonSerializer.Serialize(new { error, error_description = description });
        await response.WriteStringAsync(json);
        context.GetInvocationResult().Value = response;
    }
}
