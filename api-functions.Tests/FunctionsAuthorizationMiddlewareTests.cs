using System.Collections;
using System.Collections.Immutable;
using System.Net;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using ApiFunctions.Auth;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using Xunit;
using HttpRequestData = Microsoft.Azure.Functions.Worker.Http.HttpRequestData;

namespace ApiFunctions.Tests;

public sealed class FunctionsAuthorizationMiddlewareTests : IDisposable
{
    private const string Issuer = "https://issuer.example.test/";
    private const string Audience = Issuer + "functions";
    private readonly RSA _rsa = RSA.Create(2048);
    private readonly RsaSecurityKey _key;

    public FunctionsAuthorizationMiddlewareTests() => _key = new(_rsa) { KeyId = "middleware-test" };

    public static IEnumerable<object[]> ProtectedPolicies =>
        FunctionAuthorizationRegistry.All.Where(policy => !policy.IsAnonymous)
            .Select(policy => new object[] { policy.FunctionName });

    public static IEnumerable<object[]> PublicPolicies =>
        FunctionAuthorizationRegistry.All.Where(policy => policy.IsAnonymous)
            .Select(policy => new object[] { policy.FunctionName });

    private string Token(string scope, string category = "employee", string audience = Audience,
        string issuer = Issuer, bool expired = false, SigningCredentials? signing = null) =>
        new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer, Audience = audience,
            Claims = new Dictionary<string, object>
            {
                ["sub"] = "signed-owner", ["category"] = category, ["scope"] = scope,
                ["business_entity_id"] = 7, ["customer_id"] = 17,
            },
            IssuedAt = DateTime.UtcNow.AddMinutes(-10),
            NotBefore = DateTime.UtcNow.AddMinutes(-5),
            Expires = DateTime.UtcNow.AddMinutes(expired ? -2 : 5),
            SigningCredentials = signing ?? new(_key, SecurityAlgorithms.RsaSha256),
        });

    private async Task<(Context Context, int Calls)> Invoke(string function, string? authorization = null,
        OAuthEnforcementMode mode = OAuthEnforcementMode.Enforced, bool http = true,
        bool configured = true)
    {
        var options = new FunctionsOAuthOptions
        {
            Issuer = configured ? Issuer : null, Audience = configured ? Audience : null,
            MetadataAddress = configured ? Issuer + "metadata" : null, Mode = mode, ClockSkew = TimeSpan.Zero,
        };
        var metadata = new OpenIdConnectConfiguration { Issuer = Issuer };
        metadata.SigningKeys.Add(_key);
        var validator = new FunctionsAccessTokenValidator(options,
            NullLogger<FunctionsAccessTokenValidator>.Instance,
            new StaticConfigurationManager<OpenIdConnectConfiguration>(metadata));
        var middleware = new FunctionsAuthorizationMiddleware(options, validator,
            NullLogger<FunctionsAuthorizationMiddleware>.Instance);
        var context = new Context(function, http);
        if (authorization is not null) context.Request.Headers.Add("Authorization", authorization);
        context.Request.Headers.Add("X-MS-CLIENT-PRINCIPAL-ID", "999");
        context.Request.Headers.Add("X-MS-API-ROLE", "executive-admin");
        var calls = 0;
        await middleware.Invoke(context, _ =>
        {
            calls++;
            return Task.CompletedTask;
        });
        return (context, calls);
    }

    private static async Task AssertDenied((Context Context, int Calls) invocation,
        HttpStatusCode status, string error, bool configured = true)
    {
        using var context = invocation.Context;
        Assert.Equal(0, invocation.Calls);
        Assert.False(FunctionUser.Current(context).IsAuthenticated);
        var response = Assert.IsType<Response>(context.GetInvocationResult().Value);
        Assert.Equal(status, response.StatusCode);
        Assert.Contains("application/json", response.Headers.GetValues("Content-Type").Single());
        response.Body.Position = 0;
        using var body = await JsonDocument.ParseAsync(response.Body);
        Assert.Equal(error, body.RootElement.GetProperty("error").GetString());
        if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden && error != "unclassified_function")
        {
            var challenge = response.Headers.GetValues("WWW-Authenticate").Single();
            Assert.StartsWith("Bearer ", challenge);
            if (configured)
                Assert.Contains("resource_metadata=\"" + Issuer + ".well-known/oauth-protected-resource\"", challenge);
            else
                Assert.DoesNotContain("resource_metadata", challenge);
            Assert.Contains("error=\"" + error + "\"", challenge);
        }
    }

    [Theory]
    [MemberData(nameof(ProtectedPolicies))]
    public async Task Every_protected_policy_denies_missing_token_before_handler(string function) =>
        await AssertDenied(await Invoke(function), HttpStatusCode.Unauthorized, "missing_token");

    [Theory]
    [MemberData(nameof(ProtectedPolicies))]
    public async Task Every_protected_policy_denies_wrong_scope_before_handler(string function) =>
        await AssertDenied(await Invoke(function, "Bearer " + Token("not.a.granted.scope")),
            HttpStatusCode.Forbidden, "insufficient_scope");

    [Theory]
    [MemberData(nameof(ProtectedPolicies))]
    public async Task Every_protected_policy_accepts_matching_internal_token_and_projects_signed_owner(string function)
    {
        var policy = FunctionAuthorizationRegistry.Find(function)!;
        var invocation = await Invoke(function, "Bearer " + Token(policy.RequiredScope!));
        using var context = invocation.Context;
        Assert.Equal(1, invocation.Calls);
        Assert.Null(context.GetInvocationResult().Value);
        var user = FunctionUser.Current(context);
        Assert.True(user.IsAuthenticated);
        Assert.Equal("signed-owner", user.SubjectId);
        Assert.Equal(7, user.BusinessEntityId);
        Assert.Equal(17, user.CustomerId);
        Assert.True(user.HasScope(policy.RequiredScope!));
    }

    [Theory]
    [MemberData(nameof(ProtectedPolicies))]
    public async Task Consumer_category_follows_actual_policy_not_forged_internal_headers(string function)
    {
        var policy = FunctionAuthorizationRegistry.Find(function)!;
        var invocation = await Invoke(function, "Bearer " + Token(policy.RequiredScope!, "consumer"));
        if (policy.Mode == AccessMode.InternalOnly)
        {
            await AssertDenied(invocation, HttpStatusCode.Forbidden, "forbidden_category");
        }
        else
        {
            using var context = invocation.Context;
            Assert.Equal(1, invocation.Calls);
            Assert.True(FunctionUser.Current(context).IsConsumer);
            Assert.Equal(7, FunctionUser.Current(context).BusinessEntityId);
        }
    }

    [Theory]
    [MemberData(nameof(PublicPolicies))]
    public async Task Explicit_public_policies_remain_public_even_with_unusable_token(string function)
    {
        var invocation = await Invoke(function, "Bearer not-a-token");
        using var context = invocation.Context;
        Assert.Equal(1, invocation.Calls);
        Assert.False(FunctionUser.Current(context).IsAuthenticated);
        Assert.Null(context.GetInvocationResult().Value);
    }

    [Theory]
    [InlineData("mcp")]
    [InlineData("dab")]
    [InlineData("issuer")]
    [InlineData("expired")]
    [InlineData("signature")]
    [InlineData("category")]
    [InlineData("malformed")]
    [InlineData("unconfigured")]
    public async Task Cryptographic_and_configuration_denials_never_reach_handler(string defect)
    {
        using var otherRsa = RSA.Create(2048);
        var token = defect switch
        {
            "mcp" or "dab" => Token("admin.read", audience: Issuer + defect),
            "issuer" => Token("admin.read", issuer: "https://other.example.test/"),
            "expired" => Token("admin.read", expired: true),
            "signature" => Token("admin.read", signing: new(new RsaSecurityKey(otherRsa), SecurityAlgorithms.RsaSha256)),
            "category" => Token("admin.read", category: "unknown"),
            "malformed" => "not-a-token",
            _ => Token("admin.read"),
        };
        await AssertDenied(await Invoke("AIJobQueue_Status", "Bearer " + token, configured: defect != "unconfigured"),
            HttpStatusCode.Unauthorized, "invalid_token", configured: defect != "unconfigured");
    }

    [Fact]
    public async Task Unclassified_http_function_is_denied_even_with_valid_admin_token() =>
        await AssertDenied(await Invoke("UnclassifiedTestFunction", "Bearer " + Token("admin.read admin.write")),
            HttpStatusCode.Forbidden, "unclassified_function");

    [Theory]
    [InlineData(OAuthEnforcementMode.Disabled, true)]
    [InlineData(OAuthEnforcementMode.Audit, true)]
    [InlineData(OAuthEnforcementMode.Enforced, false)]
    public async Task Explicit_non_enforcing_modes_and_non_http_triggers_preserve_passthrough(
        OAuthEnforcementMode mode, bool http)
    {
        var invocation = await Invoke("UnclassifiedTestFunction", mode: mode, http: http);
        using var context = invocation.Context;
        Assert.Equal(1, invocation.Calls);
        Assert.Null(context.GetInvocationResult().Value);
    }

    public void Dispose() => _rsa.Dispose();

    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection().BuildServiceProvider();
        public Context(string name, bool http)
        {
            FunctionDefinition = new Definition(name);
            InstanceServices = _services;
            Request = new Request(this);
            Features.Set<IHttpRequestDataFeature>(new RequestFeature(http ? Request : null));
            ((Features)Features).AddWorkerBindings(this);
        }
        public Request Request { get; }
        public override string InvocationId => "middleware-test";
        public override string FunctionId => FunctionDefinition.Id;
        public override TraceContext TraceContext => throw new NotSupportedException();
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition { get; }
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features { get; } = new Features();
        public void Dispose() => _services.Dispose();
    }

    private sealed class Definition(string name) : FunctionDefinition
    {
        public override string Name => name;
        public override string Id => name;
        public override string EntryPoint => name;
        public override string PathToAssembly => typeof(FunctionAuthorizationRegistry).Assembly.Location;
        public override ImmutableArray<FunctionParameter> Parameters => [];
        public override IImmutableDictionary<string, BindingMetadata> InputBindings =>
            ImmutableDictionary<string, BindingMetadata>.Empty;
        public override IImmutableDictionary<string, BindingMetadata> OutputBindings =>
            ImmutableDictionary<string, BindingMetadata>.Empty;
    }

    private sealed class Features : IInvocationFeatures
    {
        private readonly Dictionary<Type, object> _values = new();
        public void AddWorkerBindings(FunctionContext context)
        {
            // The SDK exposes invocation results through an internal feature. Use its real
            // gRPC feature and message rather than duplicating response-publication behavior.
            var core = typeof(FunctionContext).Assembly;
            var grpc = Assembly.Load("Microsoft.Azure.Functions.Worker.Grpc");
            var contract = core.GetType("Microsoft.Azure.Functions.Worker.Context.Features.IFunctionBindingsFeature", true)!;
            var implementation = grpc.GetType("Microsoft.Azure.Functions.Worker.Grpc.Features.GrpcFunctionBindingsFeature", true)!;
            var message = Activator.CreateInstance(grpc.GetType("Microsoft.Azure.Functions.Worker.Grpc.Messages.InvocationRequest", true)!)!;
            var provider = Activator.CreateInstance(core.GetType("Microsoft.Azure.Functions.Worker.OutputBindings.DefaultOutputBindingsInfoProvider", true)!)!;
            _values[contract] = Activator.CreateInstance(implementation, context, message, provider)!;
        }
        public T? Get<T>() => _values.TryGetValue(typeof(T), out var value) ? (T)value : default;
        public void Set<T>(T instance) => _values[typeof(T)] = instance!;
        public IEnumerator<KeyValuePair<Type, object>> GetEnumerator() => _values.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class RequestFeature(HttpRequestData? request) : IHttpRequestDataFeature
    {
        public ValueTask<HttpRequestData?> GetHttpRequestDataAsync(FunctionContext context) => ValueTask.FromResult(request);
    }

    private sealed class Request(FunctionContext context) : HttpRequestData(context)
    {
        public override Stream Body { get; } = new MemoryStream();
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url => new("https://functions.example.test/api/resource?businessEntityId=999");
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => "POST";
        public override HttpResponseData CreateResponse() => new Response(FunctionContext);
    }

    private sealed class Response(FunctionContext context) : HttpResponseData(context)
    {
        public override HttpStatusCode StatusCode { get; set; }
        public override HttpHeadersCollection Headers { get; set; } = new();
        public override Stream Body { get; set; } = new MemoryStream();
        public override HttpCookies Cookies => throw new NotSupportedException();
    }
}
