using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.IdentityModel.Tokens;

namespace AdventureWorks.Auth;

/// <summary>
/// Signing/encryption material for the authorization server. In production this wraps an
/// RSA certificate whose private key lives only in Azure Key Vault; in development it is
/// an ephemeral in-memory RSA key. Only the public key is ever exposed via JWKS.
/// </summary>
public sealed class SigningMaterial
{
    public X509Certificate2? Certificate { get; init; }
    public RsaSecurityKey? RsaKey { get; init; }
    public bool IsEphemeral { get; init; }
    public required string KeyId { get; init; }
    public required string Source { get; init; }
}

/// <summary>Provides the authorization server's signing material.</summary>
public interface ISigningKeyProvider
{
    Task<SigningMaterial> GetAsync(CancellationToken ct = default);
}

/// <summary>
/// Development / test signing key: an ephemeral RSA-2048 key generated per process.
/// Never used when Key Vault signing is configured. Acceptable for local single-instance
/// use because tokens are short-lived and there is a single replica.
/// </summary>
public sealed class DevelopmentSigningKeyProvider : ISigningKeyProvider
{
    private readonly Lazy<SigningMaterial> _material = new(() =>
    {
        var rsa = RSA.Create(2048);
        var key = new RsaSecurityKey(rsa) { KeyId = "dev-" + Guid.NewGuid().ToString("N")[..8] };
        return new SigningMaterial
        {
            RsaKey = key,
            IsEphemeral = true,
            KeyId = key.KeyId!,
            Source = "development-ephemeral",
        };
    });

    public Task<SigningMaterial> GetAsync(CancellationToken ct = default) => Task.FromResult(_material.Value);
}
