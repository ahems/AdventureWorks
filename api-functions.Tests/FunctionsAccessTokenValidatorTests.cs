using System.Security.Cryptography;
using ApiFunctions.Auth;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class FunctionsAccessTokenValidatorTests : IDisposable
{
    private const string Issuer = "https://issuer.example.test/";
    private const string Audience = "https://issuer.example.test/functions";
    private readonly RSA _rsa = RSA.Create(2048);
    private readonly RsaSecurityKey _key;
    private readonly FunctionsAccessTokenValidator _validator;

    public FunctionsAccessTokenValidatorTests()
    {
        _key = new RsaSecurityKey(_rsa) { KeyId = "test-key" };
        var configuration = new OpenIdConnectConfiguration { Issuer = Issuer };
        configuration.SigningKeys.Add(_key);
        _validator = new FunctionsAccessTokenValidator(new FunctionsOAuthOptions
        {
            Issuer = Issuer, Audience = Audience, MetadataAddress = Issuer + "metadata",
            Mode = OAuthEnforcementMode.Enforced, ClockSkew = TimeSpan.Zero,
        }, NullLogger<FunctionsAccessTokenValidator>.Instance,
            new StaticConfigurationManager<OpenIdConnectConfiguration>(configuration));
    }

    private string Token(string issuer = Issuer, string audience = Audience,
        string? subject = "test-subject", string? category = "employee",
        int expiresMinutes = 5, SigningCredentials? signing = null, int notBeforeMinutes = -1)
    {
        var claims = new Dictionary<string, object> { ["scope"] = "admin.read" };
        if (subject is not null) claims["sub"] = subject;
        if (category is not null) claims["category"] = category;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer, Audience = audience, Claims = claims,
            IssuedAt = DateTime.UtcNow.AddMinutes(-10),
            NotBefore = DateTime.UtcNow.AddMinutes(notBeforeMinutes),
            Expires = DateTime.UtcNow.AddMinutes(expiresMinutes),
            SigningCredentials = signing ?? new SigningCredentials(_key, SecurityAlgorithms.RsaSha256),
        });
    }

    [Theory]
    [InlineData("consumer")]
    [InlineData("employee")]
    [InlineData("manufacturing")]
    [InlineData("service")]
    public async Task Valid_signed_subjects_are_accepted(string category)
    {
        var result = await _validator.ValidateAsync(Token(category: category), default);
        Assert.True(result.Succeeded, result.Error);
        Assert.Equal("test-subject", result.Principal!.FindFirst("sub")?.Value);
    }

    [Theory]
    [InlineData("issuer")]
    [InlineData("audience")]
    [InlineData("expired")]
    [InlineData("future")]
    [InlineData("subject")]
    [InlineData("empty-subject")]
    [InlineData("category")]
    [InlineData("unknown-category")]
    [InlineData("anonymous")]
    [InlineData("signature")]
    [InlineData("malformed")]
    [InlineData("missing")]
    public async Task Invalid_tokens_never_produce_a_principal(string defect)
    {
        using var otherRsa = RSA.Create(2048);
        var token = defect switch
        {
            "issuer" => Token(issuer: "https://foreign.example.test/"),
            "audience" => Token(audience: Issuer + "mcp"),
            "expired" => Token(expiresMinutes: -2, notBeforeMinutes: -5),
            "future" => Token(notBeforeMinutes: 2),
            "subject" => Token(subject: null),
            "empty-subject" => Token(subject: " "),
            "category" => Token(category: null),
            "unknown-category" => Token(category: "admin"),
            "anonymous" => Token(category: "anonymous"),
            "signature" => Token(signing: new SigningCredentials(new RsaSecurityKey(otherRsa),
                SecurityAlgorithms.RsaSha256)),
            "malformed" => "not-a-jwt",
            "missing" => "",
            _ => throw new ArgumentOutOfRangeException(nameof(defect)),
        };
        var result = await _validator.ValidateAsync(token, default);
        Assert.False(result.Succeeded);
        Assert.Null(result.Principal);
        Assert.False(string.IsNullOrWhiteSpace(result.Error));
    }

    [Fact]
    public async Task Alternate_chat_audience_does_not_widen_functions_audience()
    {
        Assert.True((await _validator.ValidateMcpAsync(Token(audience: Issuer + "mcp"), default)).Succeeded);
        Assert.False((await _validator.ValidateMcpAsync(Token(), default)).Succeeded);
    }

    [Fact]
    public async Task Missing_metadata_configuration_is_fail_closed()
    {
        var validator = new FunctionsAccessTokenValidator(new FunctionsOAuthOptions(),
            NullLogger<FunctionsAccessTokenValidator>.Instance);
        var result = await validator.ValidateAsync(Token(), default);
        Assert.False(result.Succeeded);
        Assert.Equal("resource_server_not_configured", result.Error);
    }

    public void Dispose() => _rsa.Dispose();
}
