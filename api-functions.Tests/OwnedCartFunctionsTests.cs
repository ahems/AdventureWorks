using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using ApiFunctions.Auth;
using api_functions.Functions;
using api_functions.Services;
using Azure.Core.Serialization;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using Xunit;
using HttpRequestData = Microsoft.Azure.Functions.Worker.Http.HttpRequestData;

namespace ApiFunctions.Tests;

public sealed class OwnedCartFunctionsTests : IDisposable
{
    private const string Issuer = "https://issuer.example.test/";
    private readonly RSA _rsa = RSA.Create(2048);
    private readonly RsaSecurityKey _key;
    private readonly CartStore _store = new();
    private readonly OwnedCartFunctions _functions;

    public OwnedCartFunctionsTests()
    {
        _key = new(_rsa) { KeyId = "cart-test" };
        var metadata = new OpenIdConnectConfiguration { Issuer = Issuer };
        metadata.SigningKeys.Add(_key);
        var validator = new FunctionsAccessTokenValidator(new FunctionsOAuthOptions
        {
            Issuer = Issuer, Audience = Issuer + "functions", MetadataAddress = Issuer + "metadata",
            Mode = OAuthEnforcementMode.Enforced, ClockSkew = TimeSpan.Zero,
        }, NullLogger<FunctionsAccessTokenValidator>.Instance,
            new StaticConfigurationManager<OpenIdConnectConfiguration>(metadata));
        _functions = new(_store, validator, NullLogger<OwnedCartFunctions>.Instance);
    }

    private string Token(string category = "consumer", string scope = "orders.read orders.write",
        int? owner = 7, string audience = Issuer + "functions")
    {
        var claims = new Dictionary<string, object> { ["sub"] = "cart-owner", ["category"] = category, ["scope"] = scope };
        if (owner.HasValue) claims["business_entity_id"] = owner.Value;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = Issuer, Audience = audience, Claims = claims,
            NotBefore = DateTime.UtcNow.AddMinutes(-1), Expires = DateTime.UtcNow.AddMinutes(5),
            SigningCredentials = new(_key, SecurityAlgorithms.RsaSha256),
        });
    }

    [Theory]
    [InlineData("GET")]
    [InlineData("POST")]
    [InlineData("DELETE")]
    public async Task Missing_credentials_stop_before_cart_storage(string method)
    {
        var response = await _functions.Items(new Request(method));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(0, _store.Calls);
        Assert.Contains("no-store", response.Headers.GetValues("Cache-Control"));
    }

    [Theory]
    [InlineData("Bearer ")]
    [InlineData("Bearer malformed")]
    [InlineData("Basic ignored")]
    public async Task Invalid_bearer_never_downgrades_to_guest(string authorization)
    {
        var request = new Request("POST");
        request.Headers.Add("Authorization", authorization);
        request.Headers.Add(OwnedCartFunctions.GuestHeader, new string('A', 64));
        var response = await _functions.Items(request);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(0, _store.Calls);
    }

    [Theory]
    [InlineData("employee", "orders.read orders.write", 7, 403)]
    [InlineData("manufacturing", "orders.read orders.write", 7, 403)]
    [InlineData("service", "orders.read orders.write", 7, 403)]
    [InlineData("consumer", "orders.read", 7, 403)]
    [InlineData("consumer", "orders.write", null, 403)]
    [InlineData("consumer", "orders.write", 0, 403)]
    public async Task Signed_tokens_require_consumer_owner_and_action_scope(
        string category, string scope, int? owner, int status)
    {
        var request = new Request("POST");
        request.Headers.Add("Authorization", "Bearer " + Token(category, scope, owner));
        var response = await _functions.Items(request);
        Assert.Equal((HttpStatusCode)status, response.StatusCode);
        Assert.Equal(0, _store.Calls);
    }

    [Fact]
    public async Task Wrong_audience_with_valid_guest_proof_is_still_denied()
    {
        var request = new Request("GET");
        request.Headers.Add("Authorization", "Bearer " + Token(audience: Issuer + "mcp"));
        request.Headers.Add(OwnedCartFunctions.GuestHeader, new string('A', 64));
        Assert.Equal(HttpStatusCode.Unauthorized, (await _functions.Items(request)).StatusCode);
        Assert.Equal(0, _store.Calls);
    }

    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Valid_consumer_resolves_owner_from_signed_claim_not_query(int owner)
    {
        var request = new Request("GET", "https://functions.example.test/api/cart/items?cartId=99");
        request.Headers.Add("Authorization", "Bearer " + Token(owner: owner));
        Assert.Equal(HttpStatusCode.OK, (await _functions.Items(request)).StatusCode);
        Assert.Equal(owner, _store.Actor!.BusinessEntityId);
        Assert.Null(_store.Actor.GuestHash);
        Assert.Equal("99", _store.Actor.ExpectedCartId);
        // This fake records the trusted boundary; it does not prove SQL ownership enforcement.
    }

    [Fact]
    public async Task Guest_proof_is_hashed_before_storage_boundary()
    {
        var request = new Request("GET");
        request.Headers.Add(OwnedCartFunctions.GuestHeader, new string('A', 64));
        Assert.Equal(HttpStatusCode.OK, (await _functions.Items(request)).StatusCode);
        Assert.Null(_store.Actor!.BusinessEntityId);
        Assert.Equal(SHA256.HashData(Convert.FromHexString(new string('A', 64))), _store.Actor.GuestHash);
    }

    [Fact]
    public async Task Ambiguous_credentials_are_rejected()
    {
        var request = new Request("GET");
        request.Headers.Add(OwnedCartFunctions.GuestHeader, new[] { new string('A', 64), new string('B', 64) });
        Assert.Equal(HttpStatusCode.Unauthorized, (await _functions.Items(request)).StatusCode);
        Assert.Equal(0, _store.Calls);
    }

    [Theory]
    [InlineData(false, "consumer", "orders.write", 7)]
    [InlineData(true, "employee", "orders.write", 7)]
    [InlineData(true, "consumer", "orders.read", 7)]
    [InlineData(true, "consumer", "orders.write", null)]
    public async Task Merge_denials_never_reach_storage(bool authenticated, string category, string scope, int? owner)
    {
        var request = new Request("POST");
        request.FunctionContext.Items[FunctionUser.ContextKey] = new FunctionUser
        {
            IsAuthenticated = authenticated, Category = category, BusinessEntityId = owner,
            Scopes = new HashSet<string> { scope },
        };
        request.Headers.Add(OwnedCartFunctions.GuestHeader, new string('A', 64));
        Assert.Equal(HttpStatusCode.Forbidden, (await _functions.Merge(request, request.FunctionContext)).StatusCode);
        Assert.Equal(0, _store.Calls);
    }

    [Fact]
    public async Task Merge_rejects_account_switch_mismatch_before_storage()
    {
        var request = new Request("POST", "https://functions.example.test/api/cart/merge?cartId=99");
        request.FunctionContext.Items[FunctionUser.ContextKey] = new FunctionUser
        {
            IsAuthenticated = true, Category = "consumer", BusinessEntityId = 7,
            Scopes = new HashSet<string> { FunctionScopes.OrdersWrite },
        };
        request.Headers.Add(OwnedCartFunctions.GuestHeader, new string('A', 64));
        Assert.Equal(HttpStatusCode.Forbidden, (await _functions.Merge(request, request.FunctionContext)).StatusCode);
        Assert.Equal(0, _store.Calls);
    }

    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Merge_binds_both_signed_owners_and_hashed_guest_proof(int owner)
    {
        var request = new Request("POST", $"https://functions.example.test/api/cart/merge?cartId={owner}");
        request.FunctionContext.Items[FunctionUser.ContextKey] = new FunctionUser
        {
            IsAuthenticated = true, Category = "consumer", BusinessEntityId = owner,
            Scopes = new HashSet<string> { FunctionScopes.OrdersWrite },
        };
        request.Headers.Add(OwnedCartFunctions.GuestHeader, new string('A', 64));
        request.Headers.Add("X-MS-CLIENT-PRINCIPAL-ID", "99");
        Assert.Equal(HttpStatusCode.OK, (await _functions.Merge(request, request.FunctionContext)).StatusCode);
        Assert.Equal(1, _store.Calls);
        Assert.Equal(owner, _store.Actor!.BusinessEntityId);
        Assert.Equal(SHA256.HashData(Convert.FromHexString(new string('A', 64))), _store.Actor.GuestHash);
    }

    [Theory]
    [InlineData("")]
    [InlineData("A")]
    [InlineData("not-a-session")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG")]
    public void Malformed_guest_proofs_fail_closed(string proof) =>
        Assert.Throws<CartAccessException>(() => CartActor.HashToken(proof));

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(32768)]
    public async Task Invalid_quantities_are_rejected_without_database_access(int quantity)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SQL_CONNECTION_STRING"] = "Server=unreachable.invalid" }).Build();
        var service = new OwnedCartService(configuration, TimeProvider.System);
        await Assert.ThrowsAsync<CartAccessException>(() => service.AddAsync(new(7, null), 1, quantity, default));
        await Assert.ThrowsAsync<CartAccessException>(() => service.UpdateAsync(new(7, null), 1, quantity, default));
    }

    public void Dispose() => _rsa.Dispose();

    private sealed class CartStore : IOwnedCartService
    {
        public int Calls { get; private set; }
        public CartActor? Actor { get; private set; }
        public Task<IReadOnlyList<OwnedCartItem>> ReadAsync(CartActor actor, CancellationToken cancellationToken)
        {
            Calls++;
            Actor = actor;
            return Task.FromResult<IReadOnlyList<OwnedCartItem>>([]);
        }
        public Task<GuestCartSession> CreateSessionAsync(CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<OwnedCartItem> AddAsync(CartActor actor, int productId, int quantity, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<OwnedCartItem> UpdateAsync(CartActor actor, int itemId, int quantity, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task DeleteAsync(CartActor actor, int? itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task RetireAsync(byte[] hash, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task MergeAsync(int businessEntityId, byte[] hash, CancellationToken cancellationToken)
        {
            Calls++;
            Actor = new(businessEntityId, hash);
            return Task.CompletedTask;
        }
        public Task CleanupAsync(CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private sealed class Context : FunctionContext
    {
        public override string InvocationId => "cart-test";
        public override string FunctionId => "cart-test";
        public override TraceContext TraceContext => throw new NotSupportedException();
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; } = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions { Serializer = new JsonObjectSerializer() }))
            .BuildServiceProvider();
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
    }

    private sealed class Request(string method, string url = "https://functions.example.test/api/cart/items")
        : HttpRequestData(new Context())
    {
        public override Stream Body { get; } = new MemoryStream(Encoding.UTF8.GetBytes("{}"));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new(url);
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => method;
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
