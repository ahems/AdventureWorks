using System.Globalization;
using System.Net;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore;
using Microsoft.AspNetCore.Authentication;
using OpenIddict.Abstractions;
using OpenIddict.Server.AspNetCore;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace AdventureWorks.Auth;

/// <summary>
/// Minimal-API handlers for the self-contained authorization server: protected-resource
/// metadata, the AdventureWorks login page (verifying against Person.Password), the
/// authorization endpoint (login + consent/inspection + OpenIddict sign-in), the token
/// endpoint (OpenIddict handles PKCE/replay/expiry), and logout.
///
/// OpenIddict enforces client/redirect validation, PKCE, code replay/expiry and issues the
/// signed, resource-bound JWT. These handlers only integrate the existing AdventureWorks
/// user and render the consent/inspection experience.
/// </summary>
public static class AuthorizationEndpoints
{
    public static void Map(WebApplication app, AuthorizationServerOptions options)
    {
        app.MapGet("/.well-known/oauth-protected-resource",
            (HttpContext ctx) => ProtectedResourceMetadata(ctx, options)).AllowAnonymous();

        app.MapGet("/login", LoginPage).AllowAnonymous();
        app.MapPost("/login", LoginSubmit).AllowAnonymous();

        app.MapMethods("/authorize", new[] { "GET", "POST" },
            (HttpContext ctx, IUserDirectory directory) => AuthorizeAsync(ctx, directory, options));

        // Cast single-parameter handlers to a concrete Func so minimal APIs treat them as
        // route handlers (writing the IResult) instead of binding them as a RequestDelegate
        // and discarding the returned result (ASP0016).
        app.MapPost("/token", (Func<HttpContext, Task<IResult>>)ExchangeAsync);

        app.MapGet("/logout", (Func<HttpContext, Task<IResult>>)LogoutAsync).AllowAnonymous();
    }

    // ---------------------------------------------------------------- metadata

    private static IResult ProtectedResourceMetadata(HttpContext ctx, AuthorizationServerOptions options)
    {
        var baseUrl = BaseUrl(ctx, options);
        return Results.Json(new Dictionary<string, object?>
        {
            ["resource"] = options.GetResourceIdentifier(),
            ["authorization_servers"] = new[] { baseUrl },
            ["scopes_supported"] = OAuthScopes.All,
            ["bearer_methods_supported"] = new[] { "header" },
            ["resource_name"] = "AdventureWorks MCP",
            ["resource_documentation"] = baseUrl + "/docs/mcp-oauth",
        });
    }

    // ------------------------------------------------------------------- login

    private static IResult LoginPage(HttpContext ctx)
    {
        var returnUrl = SanitizeReturnUrl(ctx.Request.Query["returnUrl"].ToString());
        var hint = ctx.Request.Query["login_hint"].ToString();
        var hasError = !string.IsNullOrEmpty(ctx.Request.Query["error"].ToString());
        return Results.Content(RenderLogin(returnUrl, hint, hasError), "text/html");
    }

    private static async Task<IResult> LoginSubmit(HttpContext ctx, IUserDirectory directory)
    {
        var form = await ctx.Request.ReadFormAsync();
        var username = form["username"].ToString();
        var password = form["password"].ToString();
        var returnUrl = SanitizeReturnUrl(form["returnUrl"].ToString());

        var user = await directory.AuthenticateAsync(username, password, ctx.RequestAborted);
        if (user is null)
        {
            var retry = "/login?error=1&returnUrl=" + Uri.EscapeDataString(returnUrl)
                + "&login_hint=" + Uri.EscapeDataString(username);
            return Results.Redirect(retry);
        }

        var identity = new ClaimsIdentity(McpAuthorizationExtensions.LoginScheme);
        identity.AddClaim(new Claim("beid", user.BusinessEntityId.ToString()));
        identity.AddClaim(new Claim(ClaimTypes.NameIdentifier, user.Subject));
        identity.AddClaim(new Claim("name", user.DisplayName));
        await ctx.SignInAsync(McpAuthorizationExtensions.LoginScheme, new ClaimsPrincipal(identity));

        return Results.Redirect(returnUrl);
    }

    private static async Task<IResult> LogoutAsync(HttpContext ctx)
    {
        await ctx.SignOutAsync(McpAuthorizationExtensions.LoginScheme);
        var returnUrl = SanitizeReturnUrl(ctx.Request.Query["returnUrl"].ToString(), "/login");
        return Results.Redirect(returnUrl);
    }

    // --------------------------------------------------------------- authorize

    private static async Task<IResult> AuthorizeAsync(HttpContext ctx, IUserDirectory directory, AuthorizationServerOptions options)
    {
        var request = ctx.GetOpenIddictServerRequest()
            ?? throw new InvalidOperationException("The OpenIddict authorization request cannot be retrieved.");

        // Enforce PKCE with S256 (reject missing PKCE and 'plain').
        if (string.IsNullOrEmpty(request.CodeChallenge) ||
            !string.Equals(request.CodeChallengeMethod, CodeChallengeMethods.Sha256, StringComparison.Ordinal))
        {
            return Forbid("Authorization Code with PKCE (S256) is required.", Errors.InvalidRequest);
        }

        // Require an authenticated AdventureWorks session (existing login / user selection).
        var auth = await ctx.AuthenticateAsync(McpAuthorizationExtensions.LoginScheme);
        if (auth.Principal?.Identity?.IsAuthenticated != true)
        {
            var returnUrl = ctx.Request.PathBase + ctx.Request.Path + ctx.Request.QueryString;
            var loginUrl = "/login?returnUrl=" + Uri.EscapeDataString(returnUrl);
            if (!string.IsNullOrEmpty(request.LoginHint))
            {
                loginUrl += "&login_hint=" + Uri.EscapeDataString(request.LoginHint);
            }

            return Results.Redirect(loginUrl);
        }

        if (!int.TryParse(auth.Principal.FindFirst("beid")?.Value, out var beid))
        {
            await ctx.SignOutAsync(McpAuthorizationExtensions.LoginScheme);
            return Results.Redirect("/login");
        }

        var user = await directory.ResolveByBusinessEntityIdAsync(beid, ctx.RequestAborted);
        if (user is null)
        {
            return Forbid("The signed-in AdventureWorks user could not be resolved.", Errors.AccessDenied);
        }

        var requested = request.GetScopes();
        var granted = requested.Where(s => user.Scopes.Contains(s)).ToList();

        // First-party AdventureWorks apps: the user already signed in to the app with the same
        // AdventureWorks credentials, so consent is implicit (the grant is still restricted to
        // the user's role-derived scopes). Third-party clients always get the consent page.
        var isTrustedClient = !string.IsNullOrEmpty(request.ClientId)
            && options.TrustedFirstPartyClientIds.Contains(request.ClientId);

        if (HttpMethods.IsGet(ctx.Request.Method))
        {
            if (!isTrustedClient || granted.Count == 0)
            {
                return Results.Content(RenderConsent(ctx, request, user, granted, requested), "text/html");
            }
        }
        else
        {
            var form = await ctx.Request.ReadFormAsync();
            if (!string.Equals(form["decision"].ToString(), "allow", StringComparison.OrdinalIgnoreCase))
            {
                return Forbid("The authorization request was denied.", Errors.AccessDenied);
            }
        }

        if (granted.Count == 0)
        {
            return Forbid("Your AdventureWorks account has none of the requested scopes.", Errors.AccessDenied);
        }

        // offline_access (refresh token) is only honoured for trusted first-party clients.
        if (isTrustedClient && requested.Contains(Scopes.OfflineAccess))
        {
            granted.Add(Scopes.OfflineAccess);
        }

        // Bind the token to a single allowed resource (RFC 8707). A request may target the
        // MCP resource, the DAB resource or the Functions resource; an unknown or multi-valued
        // target is rejected. OpenIddict 6.x does not expose an InvalidTarget error constant;
        // use the RFC 8707 value.
        if (!TryResolveRequestedResource(request, options, out var resource, out var includeOwnerClaims))
        {
            return Forbid("The requested resource is not an allowed target.", "invalid_target");
        }

        var identity = BuildAccessIdentity(user, request, includeOwnerClaims);
        var principal = new ClaimsPrincipal(identity);
        principal.SetScopes(granted);
        principal.SetResources(resource);

        return Results.SignIn(principal, new AuthenticationProperties(), OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
    }

    // ------------------------------------------------------------------- token

    private static async Task<IResult> ExchangeAsync(HttpContext ctx)
    {
        var request = ctx.GetOpenIddictServerRequest()
            ?? throw new InvalidOperationException("The OpenIddict token request cannot be retrieved.");

        if (request.IsRefreshTokenGrantType())
        {
            return await RefreshAsync(ctx);
        }

        if (string.Equals(request.GrantType, ManagedIdentityGrant.GrantType, StringComparison.Ordinal))
        {
            return await ServiceTokenAsync(ctx, request);
        }

        if (!request.IsAuthorizationCodeGrantType())
        {
            return Forbid("Unsupported grant type.", Errors.UnsupportedGrantType);
        }

        // OpenIddict has already validated the code, PKCE verifier and expiry.
        var auth = await ctx.AuthenticateAsync(OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
        if (auth.Principal is null)
        {
            return Forbid("The authorization code is no longer valid.", Errors.InvalidGrant);
        }

        // Token storage is disabled (self-contained tokens), so enforce single use here.
        var replayCache = ctx.RequestServices.GetRequiredService<OneTimeUseCache>();
        if (string.IsNullOrEmpty(request.Code) || !replayCache.TryConsume(request.Code, TimeSpan.FromMinutes(10)))
        {
            return Forbid("The authorization code has already been redeemed.", Errors.InvalidGrant);
        }

        return Results.SignIn(auth.Principal, new AuthenticationProperties(), OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
    }

    /// <summary>
    /// Refresh-token grant: re-resolves the user (so role/scope changes and deactivation take
    /// effect) and issues a fresh access token bound to the same single resource.
    /// </summary>
    private static async Task<IResult> RefreshAsync(HttpContext ctx)
    {
        // OpenIddict has already validated the refresh token's signature, encryption and expiry.
        var auth = await ctx.AuthenticateAsync(OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
        var previous = auth.Principal;
        var subject = previous?.GetClaim(Claims.Subject);
        if (previous is null || string.IsNullOrEmpty(subject))
        {
            return Forbid("The refresh token is no longer valid.", Errors.InvalidGrant);
        }

        var directory = ctx.RequestServices.GetRequiredService<IUserDirectory>();
        var options = ctx.RequestServices.GetRequiredService<AuthorizationServerOptions>();
        var user = await directory.ResolveBySubjectAsync(subject, ctx.RequestAborted);
        if (user is null)
        {
            return Forbid("The AdventureWorks user is no longer active.", Errors.InvalidGrant);
        }

        var clientId = previous.GetClaim(AwClaims.Application) ?? previous.GetPresenters().FirstOrDefault() ?? string.Empty;

        string resource;
        bool includeOwnerClaims;
        var request = ctx.GetOpenIddictServerRequest();
        if (request?.Resources is { Length: > 0 })
        {
            // RFC 8707 §2.2: a trusted first-party client may use its refresh token to obtain a
            // token for another allowed resource (e.g. the admin's DAB session minting a per-user
            // MCP token for agent chat). Scopes stay limited to the original grant.
            if (!options.TrustedFirstPartyClientIds.Contains(clientId)
                || !TryResolveRequestedResource(request, options, out resource, out includeOwnerClaims))
            {
                return Forbid("The requested resource is not an allowed target.", "invalid_target");
            }
        }
        else
        {
            resource = previous.GetResources().FirstOrDefault() ?? options.GetResourceIdentifier();
            includeOwnerClaims = !string.Equals(resource, options.GetResourceIdentifier(), StringComparison.Ordinal);
        }

        var previousScopes = previous.GetScopes();
        var granted = previousScopes.Where(s => user.Scopes.Contains(s)).ToList();
        if (granted.Count == 0)
        {
            return Forbid("Your AdventureWorks account no longer has any of the granted scopes.", Errors.InvalidGrant);
        }

        if (previousScopes.Contains(Scopes.OfflineAccess))
        {
            granted.Add(Scopes.OfflineAccess);
        }

        var identity = BuildAccessIdentity(user, clientId, includeOwnerClaims);
        var principal = new ClaimsPrincipal(identity);
        principal.SetScopes(granted);
        principal.SetResources(resource);

        return Results.SignIn(principal, new AuthenticationProperties(), OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
    }

    /// <summary>
    /// Managed-identity assertion grant: a trusted backend workload (api-functions) presents its
    /// Entra managed-identity token (audience api://AzureADTokenExchange) and receives a
    /// short-lived MCP-resource service token for Foundry agent tool calls.
    /// </summary>
    private static async Task<IResult> ServiceTokenAsync(HttpContext ctx, OpenIddictRequest request)
    {
        var options = ctx.RequestServices.GetRequiredService<AuthorizationServerOptions>();
        if (!options.ServiceGrantEnabled)
        {
            return Forbid("The managed-identity grant is not enabled.", Errors.UnauthorizedClient);
        }

        if (!string.Equals(request.ClientId, AuthorizationServerOptions.ServiceClientId, StringComparison.Ordinal))
        {
            return Forbid("This client may not use the managed-identity grant.", Errors.UnauthorizedClient);
        }

        var assertion = request.Assertion ?? (string?)request["assertion"];
        var validator = ctx.RequestServices.GetRequiredService<IServiceAssertionValidator>();
        var validated = string.IsNullOrWhiteSpace(assertion)
            ? null
            : await validator.ValidateAsync(assertion, ctx.RequestAborted);
        if (validated is null)
        {
            return Forbid("The managed-identity assertion is invalid or not trusted.", Errors.InvalidGrant);
        }

        // Service tokens are MCP-resource only.
        var mcp = options.GetResourceIdentifier();
        var requestedResources = (request.Resources ?? Array.Empty<string>())
            .Where(r => !string.IsNullOrWhiteSpace(r))
            .Select(r => r!.TrimEnd('/'))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (requestedResources.Any(r => !string.Equals(r, mcp, StringComparison.Ordinal)))
        {
            return Forbid("Service tokens may only target the MCP resource.", "invalid_target");
        }

        var requestedScopes = request.GetScopes();
        var scopes = requestedScopes.IsEmpty
            ? OAuthScopes.All.ToList()
            : requestedScopes.Where(s => OAuthScopes.All.Contains(s)).ToList();
        if (!scopes.Contains(OAuthScopes.McpAccess))
        {
            scopes.Add(OAuthScopes.McpAccess);
        }

        var identity = new ClaimsIdentity(
            authenticationType: "OpenIddict",
            nameType: Claims.Name,
            roleType: Claims.Role);
        identity.SetClaim(Claims.Subject, "service:" + validated.ObjectId);
        identity.SetClaim(Claims.Name, "AdventureWorks AI Agents");
        identity.SetClaim(AwClaims.Category, UserCategories.Service);
        identity.SetClaim(AwClaims.Application, AuthorizationServerOptions.ServiceClientId);
        identity.SetDestinations(static _ => new[] { Destinations.AccessToken });

        var principal = new ClaimsPrincipal(identity);
        principal.SetScopes(scopes);
        principal.SetResources(mcp);

        return Results.SignIn(principal, new AuthenticationProperties(), OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
    }

    // ----------------------------------------------------------------- helpers

    private static ClaimsIdentity BuildAccessIdentity(ResolvedUser user, OpenIddictRequest request, bool includeOwnerClaims) =>
        BuildAccessIdentity(user, request.ClientId ?? string.Empty, includeOwnerClaims);

    private static ClaimsIdentity BuildAccessIdentity(ResolvedUser user, string clientId, bool includeOwnerClaims)
    {
        var identity = new ClaimsIdentity(
            authenticationType: "OpenIddict",
            nameType: Claims.Name,
            roleType: Claims.Role);

        identity.SetClaim(Claims.Subject, user.Subject);
        identity.SetClaim(Claims.Name, user.DisplayName);
        identity.SetClaim(AwClaims.Category, user.Category);
        identity.SetClaim(AwClaims.Application, clientId);

        foreach (var role in user.Roles)
        {
            // 'role' (singular) is retained for human inspection / back-compat; 'roles'
            // (plural array) is what Data API Builder reads to authorize the requested
            // X-MS-API-ROLE header against the caller's granted roles.
            identity.AddClaim(new Claim(Claims.Role, role));
            identity.AddClaim(new Claim(AwClaims.Roles, role));
        }

        // Record-level ownership at a resource server (DAB or the Functions API) needs
        // non-sensitive owner claims to compare against (@claims.customer_id /
        // @claims.business_entity_id). They are added ONLY to DAB- or Functions-audience
        // consumer tokens, resolved server-side from the subject — never taken from the client
        // and never placed in MCP tokens. No sensitive database identifiers (passwords, hashes,
        // PANs) are ever exposed.
        if (includeOwnerClaims && user.IsConsumer)
        {
            // CustomerID may not exist until a consumer's first purchase; emit a 0 sentinel so the
            // claim is always present (avoids missing-claim policy failures) yet matches no row,
            // since CustomerIDs are strictly positive. Ownership therefore gates read/update/delete
            // without blocking a first-time buyer's Customer/SalesOrderHeader create.
            identity.SetClaim(AwClaims.CustomerId, (user.CustomerId ?? 0).ToString(CultureInfo.InvariantCulture));

            // BusinessEntityID always exists for a resolved consumer and owns their identity,
            // address, phone and credit-card-link records.
            identity.SetClaim(AwClaims.BusinessEntityId, user.BusinessEntityId.ToString(CultureInfo.InvariantCulture));
        }

        // All claims go to the access token only (no id token is issued).
        identity.SetDestinations(static _ => new[] { Destinations.AccessToken });
        return identity;
    }

    /// <summary>
    /// Resolves the single resource the access token will be bound to from the request's
    /// RFC 8707 <c>resource</c> parameter, validated against the configured allow-list
    /// (MCP + DAB + Functions). No target defaults to the MCP resource; an unknown or
    /// multi-valued target is rejected. <paramref name="includeOwnerClaims"/> is set for the
    /// DAB and Functions resources (both perform record-level ownership) and gates the
    /// consumer owner claims; it is false for the MCP resource.
    /// </summary>
    private static bool TryResolveRequestedResource(
        OpenIddictRequest request,
        AuthorizationServerOptions options,
        out string resource,
        out bool includeOwnerClaims)
    {
        var mcp = options.GetResourceIdentifier();
        var dab = options.GetDabResourceIdentifier();
        var functions = options.GetFunctionsResourceIdentifier();

        var requested = (request.Resources ?? Array.Empty<string>())
            .Where(r => !string.IsNullOrWhiteSpace(r))
            .Select(r => r!.TrimEnd('/'))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        if (requested.Count == 0)
        {
            resource = mcp;
            includeOwnerClaims = false;
            return true;
        }

        if (requested.Count == 1)
        {
            if (string.Equals(requested[0], dab, StringComparison.Ordinal))
            {
                resource = dab;
                includeOwnerClaims = true;
                return true;
            }

            if (string.Equals(requested[0], functions, StringComparison.Ordinal))
            {
                resource = functions;
                includeOwnerClaims = true;
                return true;
            }

            if (string.Equals(requested[0], mcp, StringComparison.Ordinal))
            {
                resource = mcp;
                includeOwnerClaims = false;
                return true;
            }
        }

        resource = string.Empty;
        includeOwnerClaims = false;
        return false;
    }

    private static string BaseUrl(HttpContext ctx, AuthorizationServerOptions options) =>
        options.PublicBaseUrl?.TrimEnd('/') ?? $"{ctx.Request.Scheme}://{ctx.Request.Host}";

    private static string SanitizeReturnUrl(string? returnUrl, string fallback = "/")
    {
        // Prevent open redirects: only allow local, absolute-path URLs.
        if (string.IsNullOrEmpty(returnUrl) || !returnUrl.StartsWith('/') || returnUrl.StartsWith("//") || returnUrl.StartsWith("/\\"))
        {
            return fallback;
        }

        return returnUrl;
    }

    private static IResult Forbid(string description, string error)
    {
        var properties = new AuthenticationProperties(new Dictionary<string, string?>
        {
            [OpenIddictServerAspNetCoreConstants.Properties.Error] = error,
            [OpenIddictServerAspNetCoreConstants.Properties.ErrorDescription] = description,
        });

        return Results.Forbid(properties, new[] { OpenIddictServerAspNetCoreDefaults.AuthenticationScheme });
    }

    // ------------------------------------------------------------------- views

    private static string RenderLogin(string returnUrl, string hint, bool hasError)
    {
        Func<string?, string?> enc = WebUtility.HtmlEncode;
        var error = hasError
            ? "<p class=\"err\">Sign-in failed. Check the email and password and try again.</p>"
            : string.Empty;

        return Page("Sign in — AdventureWorks MCP", $@"
  <h1>AdventureWorks</h1>
  <p class=""sub"">Sign in with your AdventureWorks account to authorize MCP access.</p>
  {error}
  <form method=""post"" action=""/login"" autocomplete=""off"">
    <label>Email
      <input type=""email"" name=""username"" value=""{enc(hint)}"" required autofocus />
    </label>
    <label>Password
      <input type=""password"" name=""password"" required />
    </label>
    <input type=""hidden"" name=""returnUrl"" value=""{enc(returnUrl)}"" />
    <button type=""submit"">Sign in</button>
  </form>
  <p class=""note"">This is a demonstration sign-in backed by the AdventureWorks database. It is not an enterprise identity provider.</p>");
    }

    private static string RenderConsent(
        HttpContext ctx,
        OpenIddictRequest request,
        ResolvedUser user,
        IReadOnlyList<string> granted,
        IReadOnlyCollection<string> requested)
    {
        Func<string?, string?> enc = WebUtility.HtmlEncode;
        var grantedSet = new HashSet<string>(granted, StringComparer.Ordinal);

        var hidden = new StringBuilder();
        foreach (var (key, value) in ctx.Request.Query)
        {
            hidden.Append("<input type=\"hidden\" name=\"").Append(enc(key))
                  .Append("\" value=\"").Append(enc(value.ToString())).Append("\" />\n");
        }

        var scopeRows = new StringBuilder();
        foreach (var scope in requested)
        {
            var ok = grantedSet.Contains(scope);
            var desc = OAuthScopes.Descriptions.TryGetValue(scope, out var d) ? d : scope;
            scopeRows.Append("<tr class=\"").Append(ok ? "ok" : "no").Append("\"><td><code>")
                     .Append(enc(scope)).Append("</code></td><td>").Append(enc(desc))
                     .Append("</td><td>").Append(ok ? "Granted" : "Not permitted").Append("</td></tr>");
        }

        var roles = user.Roles.Count > 0 ? string.Join(", ", user.Roles) : "(none)";

        return Page("Authorize — AdventureWorks MCP", $@"
  <h1>Authorize MCP access</h1>
  <table class=""kv"">
    <tr><th>User</th><td>{enc(user.DisplayName)}</td></tr>
    <tr><th>Category</th><td>{enc(user.Category)}</td></tr>
    <tr><th>Role(s)</th><td>{enc(roles)}</td></tr>
    <tr><th>Application</th><td>{enc(request.ClientId ?? "(unknown)")}</td></tr>
    <tr><th>Resource</th><td><code>{enc(request.Resources?.FirstOrDefault() ?? "AdventureWorks MCP")}</code></td></tr>
  </table>
  <h2>Requested scopes</h2>
  <table class=""scopes"">
    <thead><tr><th>Scope</th><th>Purpose</th><th>Decision</th></tr></thead>
    <tbody>{scopeRows}</tbody>
  </table>
  <form method=""post"" action=""/authorize{enc(ctx.Request.QueryString.ToString())}"">
    {hidden}
    <div class=""actions"">
      <button type=""submit"" name=""decision"" value=""allow"">Allow</button>
      <button type=""submit"" name=""decision"" value=""deny"" class=""secondary"">Deny</button>
    </div>
  </form>
  <p class=""note"">Only scopes permitted by your seeded AdventureWorks role are granted. Record-level ownership is always enforced server-side.</p>");
    }

    private static string Page(string title, string body) => $@"<!DOCTYPE html>
<html lang=""en""><head><meta charset=""utf-8"" />
<meta name=""viewport"" content=""width=device-width, initial-scale=1"" />
<title>{WebUtility.HtmlEncode(title)}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }}
  h1 {{ margin-bottom: .25rem; }}
  .sub, .note {{ color: #666; }}
  .note {{ font-size: .85rem; margin-top: 2rem; }}
  .err {{ color: #b00020; font-weight: 600; }}
  label {{ display: block; margin: 1rem 0; font-weight: 600; }}
  input {{ display: block; width: 100%; padding: .5rem; margin-top: .25rem; box-sizing: border-box; }}
  button {{ padding: .6rem 1.2rem; font-size: 1rem; cursor: pointer; margin-right: .5rem; }}
  button.secondary {{ opacity: .7; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
  th, td {{ text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; vertical-align: top; }}
  table.kv th {{ width: 9rem; }}
  tr.no td {{ opacity: .55; }}
  code {{ font-family: ui-monospace, Menlo, Consolas, monospace; }}
  .actions {{ margin-top: 1.5rem; }}
</style></head>
<body>{body}</body></html>";
}
