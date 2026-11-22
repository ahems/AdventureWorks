using System.Security.Cryptography;
using System.Text;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;

namespace AddressFunctions.Services;

public sealed record PasswordResetCandidate(int BusinessEntityID, string FirstName, string Email);

/// <summary>
/// Persistence for storefront password-reset tokens (Person.PasswordResetToken). Only token
/// hashes are stored, and Person.Password changes only when a reset completes.
/// </summary>
public interface IPasswordResetStore
{
    /// <summary>Finds a storefront consumer (PersonType 'IN') with an existing login by email.</summary>
    Task<PasswordResetCandidate?> FindConsumerByEmailAsync(string email);

    /// <summary>Replaces any unused token for the person with a new one.</summary>
    Task IssueTokenAsync(int businessEntityId, byte[] tokenHash, TimeSpan lifetime);

    Task<bool> IsTokenActiveAsync(int businessEntityId, byte[] tokenHash);

    /// <summary>
    /// Marks the token used and writes the new password in one transaction. Returns false
    /// when the token is not active or the login row is missing.
    /// </summary>
    Task<bool> CompleteResetAsync(int businessEntityId, byte[] tokenHash, string passwordHash, string passwordSalt);
}

public interface IPasswordResetNotifier
{
    Task<bool> SendAsync(string email, string firstName, string resetUrl);
}

public enum PasswordResetOutcome
{
    Completed,
    InvalidToken,
}

/// <summary>Result of a staff-initiated reset; only the authenticated admin route reports it.</summary>
public enum AdminPasswordResetResult
{
    Sent,
    /// <summary>The address does not identify exactly one storefront consumer login for this customer.</summary>
    NotEligible,
    EmailNotSent,
    NotConfigured,
}

public sealed class PasswordResetService
{
    public static readonly TimeSpan TokenLifetime = TimeSpan.FromHours(1);
    private const int TokenBytes = 32;
    private const int MaxTokenLength = 128;

    private readonly IPasswordResetStore _store;
    private readonly IPasswordResetNotifier _notifier;
    private readonly string? _appUrl;
    private readonly ILogger<PasswordResetService> _logger;

    public PasswordResetService(
        IPasswordResetStore store,
        IPasswordResetNotifier notifier,
        string? appUrl,
        ILogger<PasswordResetService> logger)
    {
        _store = store;
        _notifier = notifier;
        _appUrl = appUrl;
        _logger = logger;
    }

    /// <summary>
    /// Issues a token and emails the link when the address belongs to a storefront consumer.
    /// The caller always returns the same generic response, whatever happens here.
    /// </summary>
    public async Task RequestResetAsync(string email) => await IssueAsync(email, expectedBusinessEntityId: null);

    /// <summary>
    /// Staff-initiated reset for a specific customer. The email must resolve to that customer's
    /// storefront login; unlike the anonymous route, the outcome is reported to the caller.
    /// </summary>
    public Task<AdminPasswordResetResult> RequestResetForCustomerAsync(int businessEntityId, string email) =>
        businessEntityId <= 0 || string.IsNullOrWhiteSpace(email)
            ? Task.FromResult(AdminPasswordResetResult.NotEligible)
            : IssueAsync(email, businessEntityId);

    private async Task<AdminPasswordResetResult> IssueAsync(string email, int? expectedBusinessEntityId)
    {
        var baseUrl = NormalizeAppUrl(_appUrl);
        if (baseUrl == null)
        {
            _logger.LogError("APP_URL is not configured as an absolute http(s) URL; password reset email not sent.");
            return AdminPasswordResetResult.NotConfigured;
        }

        var candidate = await _store.FindConsumerByEmailAsync(email.Trim());
        if (candidate == null
            || (expectedBusinessEntityId.HasValue && candidate.BusinessEntityID != expectedBusinessEntityId.Value))
        {
            _logger.LogInformation("Password reset requested for an address with no storefront consumer login.");
            return AdminPasswordResetResult.NotEligible;
        }

        var token = GenerateToken();
        await _store.IssueTokenAsync(candidate.BusinessEntityID, HashToken(token), TokenLifetime);

        var resetUrl = BuildResetUrl(baseUrl, token, candidate.BusinessEntityID);
        var sent = await _notifier.SendAsync(candidate.Email, candidate.FirstName, resetUrl);
        _logger.LogInformation(
            "Password reset token issued for BusinessEntityID {BusinessEntityId}; email sent: {Sent}",
            candidate.BusinessEntityID, sent);
        return sent ? AdminPasswordResetResult.Sent : AdminPasswordResetResult.EmailNotSent;
    }

    public Task<bool> ValidateAsync(int businessEntityId, string token)
    {
        if (!IsWellFormed(businessEntityId, token))
        {
            return Task.FromResult(false);
        }
        return _store.IsTokenActiveAsync(businessEntityId, HashToken(token));
    }

    public async Task<PasswordResetOutcome> CompleteAsync(int businessEntityId, string token, string newPassword)
    {
        if (!IsWellFormed(businessEntityId, token))
        {
            return PasswordResetOutcome.InvalidToken;
        }

        var (hash, salt) = PasswordService.CreatePasswordHash(newPassword);
        var completed = await _store.CompleteResetAsync(businessEntityId, HashToken(token), hash, salt);
        return completed ? PasswordResetOutcome.Completed : PasswordResetOutcome.InvalidToken;
    }

    public static string GenerateToken() =>
        Base64UrlEncode(RandomNumberGenerator.GetBytes(TokenBytes));

    public static byte[] HashToken(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));

    /// <summary>Returns the trusted storefront origin (no trailing slash), or null when unusable.</summary>
    public static string? NormalizeAppUrl(string? appUrl)
    {
        if (string.IsNullOrWhiteSpace(appUrl)
            || !Uri.TryCreate(appUrl.Trim(), UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return null;
        }
        return uri.GetLeftPart(UriPartial.Authority);
    }

    public static string BuildResetUrl(string baseUrl, string token, int businessEntityId) =>
        $"{baseUrl}/reset-password?token={Uri.EscapeDataString(token)}&id={businessEntityId}";

    private static bool IsWellFormed(int businessEntityId, string? token) =>
        businessEntityId > 0 && !string.IsNullOrWhiteSpace(token) && token.Length <= MaxTokenLength;

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public sealed class SqlPasswordResetStore : IPasswordResetStore
{
    private readonly string _connectionString;

    public SqlPasswordResetStore(string connectionString)
    {
        _connectionString = connectionString;
    }

    public async Task<PasswordResetCandidate?> FindConsumerByEmailAsync(string email)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        // Only individual storefront customers with a login row; ambiguous addresses get no token.
        var matches = (await connection.QueryAsync<PasswordResetCandidate>(@"
            SELECT TOP (2) p.BusinessEntityID, p.FirstName, ea.EmailAddress AS Email
            FROM Person.EmailAddress ea
            INNER JOIN Person.Person p ON p.BusinessEntityID = ea.BusinessEntityID
            INNER JOIN Person.Password pw ON pw.BusinessEntityID = p.BusinessEntityID
            WHERE ea.EmailAddress = @Email AND p.PersonType = 'IN'",
            new { Email = email })).ToList();
        return matches.Count == 1 ? matches[0] : null;
    }

    public async Task IssueTokenAsync(int businessEntityId, byte[] tokenHash, TimeSpan lifetime)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync();
        await connection.ExecuteAsync(@"
            DELETE FROM Person.PasswordResetToken
            WHERE BusinessEntityID = @BusinessEntityId AND UsedUtc IS NULL;

            DECLARE @now datetime2 = SYSUTCDATETIME();
            INSERT INTO Person.PasswordResetToken (BusinessEntityID, TokenHash, CreatedUtc, ExpiresUtc)
            VALUES (@BusinessEntityId, @TokenHash, @now, DATEADD(second, @LifetimeSeconds, @now));",
            new
            {
                BusinessEntityId = businessEntityId,
                TokenHash = tokenHash,
                LifetimeSeconds = (int)lifetime.TotalSeconds,
            },
            transaction);
        await transaction.CommitAsync();
    }

    public async Task<bool> IsTokenActiveAsync(int businessEntityId, byte[] tokenHash)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return await connection.ExecuteScalarAsync<int>(@"
            SELECT COUNT(1) FROM Person.PasswordResetToken
            WHERE BusinessEntityID = @BusinessEntityId AND TokenHash = @TokenHash
              AND UsedUtc IS NULL AND ExpiresUtc > SYSUTCDATETIME()",
            new { BusinessEntityId = businessEntityId, TokenHash = tokenHash }) > 0;
    }

    public async Task<bool> CompleteResetAsync(
        int businessEntityId, byte[] tokenHash, string passwordHash, string passwordSalt)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync();

        var claimed = await connection.ExecuteAsync(@"
            UPDATE Person.PasswordResetToken
            SET UsedUtc = SYSUTCDATETIME()
            WHERE BusinessEntityID = @BusinessEntityId AND TokenHash = @TokenHash
              AND UsedUtc IS NULL AND ExpiresUtc > SYSUTCDATETIME()",
            new { BusinessEntityId = businessEntityId, TokenHash = tokenHash }, transaction);
        if (claimed != 1)
        {
            await transaction.RollbackAsync();
            return false;
        }

        var updated = await connection.ExecuteAsync(@"
            UPDATE Person.Password
            SET PasswordHash = @Hash, PasswordSalt = @Salt, ModifiedDate = GETDATE()
            WHERE BusinessEntityID = @BusinessEntityId",
            new { BusinessEntityId = businessEntityId, Hash = passwordHash, Salt = passwordSalt }, transaction);
        if (updated != 1)
        {
            await transaction.RollbackAsync();
            return false;
        }

        await transaction.CommitAsync();
        return true;
    }
}
