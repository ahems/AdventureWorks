using System.Net;
using System.Security.Cryptography;
using AdventureWorks.Auth;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace AdventureWorks.Tests;

[Collection(OAuthServerCollection.Name)]
public sealed class ManagedIdentityAssertionValidatorTests : IDisposable
{
    private const string Tenant = "00000000-0000-0000-0000-000000000001";
    private const string Principal = "00000000-0000-0000-0000-000000000002";
    private readonly RSA _rsa = RSA.Create(2048);
    private readonly Clock _clock = new();
    private readonly Keys _http = new();
    private readonly AuthorizationServerOptions _options = new() { EntraTenantId = Tenant };
    private readonly EntraManagedIdentityAssertionValidator _validator;
    private readonly RsaSecurityKey _key;

    public ManagedIdentityAssertionValidatorTests()
    {
        _key = new(_rsa) { KeyId = "first" };
        _options.TrustedServicePrincipalIds.Add(Principal);
        _http.Document = Jwks(_key);
        _validator = new(_options, _http, NullLogger<EntraManagedIdentityAssertionValidator>.Instance, _clock);
    }

    private static string Jwks(RsaSecurityKey key)
    {
        var parameters = key.Rsa.ExportParameters(false);
        return System.Text.Json.JsonSerializer.Serialize(new
        {
            keys = new[] { new { kty = "RSA", kid = key.KeyId,
                e = Base64UrlEncoder.Encode(parameters.Exponent), n = Base64UrlEncoder.Encode(parameters.Modulus) } }
        });
    }

    private string Token(string? issuer = null, string? audience = null, string? principal = Principal,
        string lifetime = "valid", SecurityKey? key = null, bool unsigned = false)
    {
        var claims = new Dictionary<string, object>();
        if (principal is not null) claims["oid"] = principal;
        var now = DateTime.UtcNow;
        var handler = new JsonWebTokenHandler { SetDefaultTimesOnTokenCreation = lifetime != "missing-expiry" };
        return handler.CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer ?? $"https://login.microsoftonline.com/{Tenant}/v2.0",
            Audience = audience ?? ManagedIdentityGrant.TokenExchangeAudience,
            Claims = claims,
            IssuedAt = lifetime == "expired" ? now.AddHours(-2) : now,
            NotBefore = lifetime == "future" ? now.AddHours(1) : now.AddHours(-2),
            Expires = lifetime == "missing-expiry" ? null :
                lifetime == "expired" ? now.AddHours(-1) : now.AddHours(2),
            SigningCredentials = unsigned ? null : new(key ?? _key, SecurityAlgorithms.RsaSha256),
        });
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Real_signature_accepts_only_supported_issuer_and_audience_forms(bool v1, bool uri)
    {
        var token = Token(issuer: v1 ? $"https://sts.windows.net/{Tenant}/" : null,
            audience: uri ? "api://AzureADTokenExchange" : null);
        Assert.Equal(Principal, (await _validator.ValidateAsync(token, default))?.ObjectId);
        Assert.Equal($"https://login.microsoftonline.com/{Tenant}/discovery/v2.0/keys", _http.LastUri);
    }

    [Theory]
    [InlineData("issuer")]
    [InlineData("tenant")]
    [InlineData("audience")]
    [InlineData("signature")]
    [InlineData("unsigned")]
    [InlineData("expired")]
    [InlineData("future")]
    [InlineData("missing-expiry")]
    [InlineData("missing-oid")]
    [InlineData("untrusted-oid")]
    [InlineData("malformed")]
    public async Task Real_validator_rejects_cryptographic_claim_and_lifetime_negatives(string negative)
    {
        using var other = RSA.Create(2048);
        var token = negative == "malformed" ? "not-a-token" : Token(
            issuer: negative == "issuer" ? "https://issuer.example.invalid/" :
                negative == "tenant" ? "https://sts.windows.net/other-tenant/" : null,
            audience: negative == "audience" ? "https://management.azure.com/" : null,
            principal: negative == "missing-oid" ? null : negative == "untrusted-oid" ? "untrusted" : Principal,
            lifetime: negative, key: negative == "signature" ? new RsaSecurityKey(other) { KeyId = "first" } : null,
            unsigned: negative == "unsigned");
        Assert.Null(await _validator.ValidateAsync(token, default));
    }

    [Fact]
    public async Task Disabled_and_empty_grants_do_not_fetch_keys()
    {
        _options.TrustedServicePrincipalIds.Clear();
        Assert.Null(await _validator.ValidateAsync(Token(), default));
        Assert.Null(await _validator.ValidateAsync("", default));
        Assert.Equal(0, _http.Calls);
    }

    [Fact]
    public async Task Keys_are_cached_and_unknown_key_refresh_is_throttled_then_accepts_rotation()
    {
        Assert.NotNull(await _validator.ValidateAsync(Token(), default));
        using var rotated = RSA.Create(2048);
        var key = new RsaSecurityKey(rotated) { KeyId = "second" };
        _http.Document = Jwks(key);
        Assert.Null(await _validator.ValidateAsync(Token(key: key), default));
        Assert.Equal(1, _http.Calls);
        _clock.Advance(TimeSpan.FromMinutes(5));
        Assert.NotNull(await _validator.ValidateAsync(Token(key: key), default));
        Assert.Equal(2, _http.Calls);
    }

    [Fact]
    public async Task Expired_key_cache_is_not_an_unbounded_outage_fallback()
    {
        Assert.NotNull(await _validator.ValidateAsync(Token(), default));
        _clock.Advance(TimeSpan.FromHours(12));
        _http.Fail = true;
        Assert.Null(await _validator.ValidateAsync(Token(), default));
        Assert.Equal(2, _http.Calls);
    }

    [Fact]
    public async Task Unknown_key_refresh_outage_can_retain_only_still_fresh_keys()
    {
        Assert.NotNull(await _validator.ValidateAsync(Token(), default));
        _clock.Advance(TimeSpan.FromMinutes(6));
        _http.Fail = true;
        using var rotated = RSA.Create(2048);
        Assert.Null(await _validator.ValidateAsync(Token(key: new RsaSecurityKey(rotated) { KeyId = "second" }), default));
        Assert.NotNull(await _validator.ValidateAsync(Token(), default));
    }

    [Fact]
    public async Task Invalid_jwks_is_rejected_without_using_an_empty_key_set()
    {
        _http.Document = "not-json";
        Assert.Null(await _validator.ValidateAsync(Token(), default));
    }

    [Fact]
    public async Task Concurrent_first_use_fetches_keys_once()
    {
        var token = Token();
        var results = await Task.WhenAll(Enumerable.Range(0, 10)
            .Select(_ => _validator.ValidateAsync(token, default)));
        Assert.All(results, result => Assert.Equal(Principal, result?.ObjectId));
        Assert.Equal(1, _http.Calls);
    }

    [Fact]
    public async Task Caller_cancellation_is_propagated()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            _validator.ValidateAsync(Token(), cancellation.Token));
    }

    [Fact]
    public async Task Real_assertions_are_enforced_through_token_endpoint_and_issued_token_signature()
    {
        using var factory = new OAuthTestFactory();
        using var server = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            services.Replace(ServiceDescriptor.Singleton<IServiceAssertionValidator>(_validator))));
        using var client = server.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = false,
        });

        using var response = await ExchangeAsync(Token());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var document = System.Text.Json.JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.False(document.RootElement.TryGetProperty("refresh_token", out _));
        var accessToken = document.RootElement.GetProperty("access_token").GetString()!;
        using var discovery = System.Text.Json.JsonDocument.Parse(
            await client.GetStringAsync("/.well-known/openid-configuration"));
        var jwksUri = discovery.RootElement.GetProperty("jwks_uri").GetString()!;
        var keys = new JsonWebKeySet(await client.GetStringAsync(jwksUri)).GetSigningKeys();
        var validation = await new JsonWebTokenHandler().ValidateTokenAsync(accessToken, new TokenValidationParameters
        {
            RequireSignedTokens = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKeys = keys,
            ValidateIssuer = true,
            ValidIssuer = discovery.RootElement.GetProperty("issuer").GetString(),
            ValidateAudience = true,
            ValidAudience = OAuthTestFactory.ResourceIdentifier,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.Zero,
        });
        Assert.True(validation.IsValid, validation.Exception?.Message);
        var jwt = new JsonWebToken(accessToken);
        Assert.Equal("service:" + Principal, jwt.Subject);
        Assert.Equal(UserCategories.Service, jwt.GetClaim(AwClaims.Category).Value);
        Assert.Equal(AuthorizationServerOptions.ServiceClientId, jwt.GetClaim(AwClaims.Application).Value);
        Assert.False(jwt.TryGetClaim("business_entity_id", out _));
        Assert.False(jwt.TryGetClaim("customer_id", out _));
        Assert.Equal(new[] { "mcp.access", "products.read" },
            jwt.GetClaim("scope").Value.Split(' ').Order().ToArray());
        Assert.Equal(server.Services.GetRequiredService<AuthorizationServerOptions>().AccessTokenLifetime,
            jwt.ValidTo - jwt.IssuedAt);

        using var wrongKey = RSA.Create(2048);
        var invalidAssertions = new[]
        {
            "", "not-a-token", Token(unsigned: true),
            Token(issuer: "https://issuer.example.invalid/"),
            Token(issuer: "https://sts.windows.net/other-tenant/"),
            Token(audience: "https://management.azure.com/"),
            Token(key: new RsaSecurityKey(wrongKey) { KeyId = "first" }),
            Token(lifetime: "expired"), Token(lifetime: "future"), Token(lifetime: "missing-expiry"),
            Token(principal: null), Token(principal: "untrusted"),
        };
        foreach (var assertion in invalidAssertions)
        {
            using var denied = await ExchangeAsync(assertion);
            Assert.Equal(HttpStatusCode.BadRequest, denied.StatusCode);
            using var body = System.Text.Json.JsonDocument.Parse(await denied.Content.ReadAsStringAsync());
            Assert.Equal("invalid_grant", body.RootElement.GetProperty("error").GetString());
            Assert.False(body.RootElement.TryGetProperty("access_token", out _));
            Assert.False(body.RootElement.TryGetProperty("refresh_token", out _));
        }

        foreach (var resource in new[] { OAuthTestFactory.DabResourceIdentifier, OAuthTestFactory.FunctionsResourceIdentifier })
        {
            using var denied = await ExchangeAsync(Token(), resource);
            Assert.Equal(HttpStatusCode.BadRequest, denied.StatusCode);
            using var body = System.Text.Json.JsonDocument.Parse(await denied.Content.ReadAsStringAsync());
            Assert.Equal("invalid_target", body.RootElement.GetProperty("error").GetString());
            Assert.False(body.RootElement.TryGetProperty("access_token", out _));
        }
        Assert.Equal(1, _http.Calls);

        Task<HttpResponseMessage> ExchangeAsync(string assertion, string resource = OAuthTestFactory.ResourceIdentifier) =>
            client.PostAsync("/token", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = ManagedIdentityGrant.GrantType,
                ["client_id"] = AuthorizationServerOptions.ServiceClientId,
                ["assertion"] = assertion,
                ["resource"] = resource,
                ["scope"] = "mcp.access products.read",
            }));
    }

    public void Dispose() => _rsa.Dispose();

    private sealed class Clock : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan amount) => _now += amount;
    }

    private sealed class Keys : HttpMessageHandler, IHttpClientFactory
    {
        public string Document { get; set; } = "";
        public string? LastUri { get; private set; }
        public bool Fail { get; set; }
        public int Calls { get; private set; }
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            LastUri = request.RequestUri!.AbsoluteUri;
            if (Fail) throw new HttpRequestException("Controlled JWKS outage.");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Document) });
        }
    }
}
