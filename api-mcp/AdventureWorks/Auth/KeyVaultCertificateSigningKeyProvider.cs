using System.Security.Cryptography.X509Certificates;
using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

namespace AdventureWorks.Auth;

/// <summary>
/// Reads the RSA signing certificate (PFX) from Azure Key Vault using a dedicated
/// managed identity granted only <c>Key Vault Secrets User</c> on the vault.
/// The private key never leaves Key Vault except into this in-memory certificate at
/// runtime; it is never written to disk, app settings, images or outputs.
///
/// Bounded retries tolerate RBAC role-assignment propagation delay after <c>azd up</c>.
/// </summary>
public sealed class KeyVaultCertificateSigningKeyProvider : ISigningKeyProvider
{
    private readonly AuthorizationServerOptions _options;
    private readonly ILogger<KeyVaultCertificateSigningKeyProvider> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private SigningMaterial? _cached;

    public KeyVaultCertificateSigningKeyProvider(
        AuthorizationServerOptions options,
        ILogger<KeyVaultCertificateSigningKeyProvider> logger)
    {
        _options = options;
        _logger = logger;
    }

    public async Task<SigningMaterial> GetAsync(CancellationToken ct = default)
    {
        if (_cached is not null)
        {
            return _cached;
        }

        await _gate.WaitAsync(ct);
        try
        {
            if (_cached is not null)
            {
                return _cached;
            }

            _cached = await LoadWithRetryAsync(ct);
            return _cached;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<SigningMaterial> LoadWithRetryAsync(CancellationToken ct)
    {
        var vaultUri = new Uri(_options.KeyVaultUri!);
        TokenCredential credential = string.IsNullOrWhiteSpace(_options.KeyVaultManagedIdentityClientId)
            ? new DefaultAzureCredential()
            : new ManagedIdentityCredential(_options.KeyVaultManagedIdentityClientId);

        // A certificate's private key (PFX) is retrievable via the Secrets endpoint using
        // the same name as the certificate. This requires only "Key Vault Secrets User".
        var secretClient = new SecretClient(vaultUri, credential);

        const int maxAttempts = 8;
        var delay = TimeSpan.FromSeconds(2);
        Exception? last = null;

        for (int attempt = 1; attempt <= maxAttempts; attempt++)
        {
            try
            {
                KeyVaultSecret secret = await secretClient.GetSecretAsync(_options.SigningCertificateName, cancellationToken: ct);
                var pfxBytes = Convert.FromBase64String(secret.Value);

                var certificate = X509CertificateLoader.LoadPkcs12(
                    pfxBytes,
                    password: null,
                    keyStorageFlags: X509KeyStorageFlags.EphemeralKeySet | X509KeyStorageFlags.Exportable);

                if (!certificate.HasPrivateKey)
                {
                    throw new InvalidOperationException(
                        $"Key Vault certificate '{_options.SigningCertificateName}' has no private key.");
                }

                var keyId = certificate.Thumbprint;
                _logger.LogInformation(
                    "Loaded MCP signing certificate '{Name}' from Key Vault (kid {Kid}, attempt {Attempt}).",
                    _options.SigningCertificateName, keyId, attempt);

                return new SigningMaterial
                {
                    Certificate = certificate,
                    IsEphemeral = false,
                    KeyId = keyId,
                    Source = "keyvault",
                };
            }
            catch (Exception ex) when (ex is RequestFailedException or AuthenticationFailedException or FormatException)
            {
                last = ex;
                _logger.LogWarning(
                    "Attempt {Attempt}/{Max} to load signing certificate from Key Vault failed: {Message}. Retrying in {Delay}s (RBAC propagation).",
                    attempt, maxAttempts, ex.Message, delay.TotalSeconds);

                if (attempt < maxAttempts)
                {
                    await Task.Delay(delay, ct);
                    delay = TimeSpan.FromSeconds(Math.Min(delay.TotalSeconds * 2, 30));
                }
            }
        }

        throw new InvalidOperationException(
            $"Unable to load signing certificate '{_options.SigningCertificateName}' from Key Vault '{_options.KeyVaultUri}' " +
            "after multiple attempts. Verify the vault exists, the certificate was created (see the azd postprovision hook), " +
            "and this app's managed identity has the 'Key Vault Secrets User' role on the vault.", last);
    }
}
