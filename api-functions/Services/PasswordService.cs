using Microsoft.Data.SqlClient;
using AddressFunctions.Models;
using Dapper;
using System.Security.Cryptography;
using System.Text;

namespace AddressFunctions.Services;

/// <summary>
/// Service for managing password hashing and verification using PBKDF2
/// </summary>
public class PasswordService
{
    private readonly string _connectionString;
    private const int SaltSize = 6; // 6 bytes -> 8 chars base64 (fits varchar(10))
    private const int HashSize = 96; // 96 bytes to fit in varchar(128) when base64 encoded
    private const int Iterations = 100000; // OWASP recommended minimum

    public PasswordService(string connectionString)
    {
        _connectionString = connectionString;
    }

    /// <summary>
    /// Creates a SQL connection with Azure AD authentication
    /// </summary>
    private async Task<SqlConnection> CreateConnectionAsync()
    {
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>
    /// Generates a cryptographically secure random salt
    /// </summary>
    private string GenerateSalt()
    {
        byte[] saltBytes = new byte[SaltSize];
        using (var rng = RandomNumberGenerator.Create())
        {
            rng.GetBytes(saltBytes);
        }
        return Convert.ToBase64String(saltBytes);
    }

    /// <summary>
    /// Hashes a password using PBKDF2 with the provided salt
    /// </summary>
    private string HashPassword(string password, string salt)
    {
        byte[] saltBytes = Convert.FromBase64String(salt);

        using (var pbkdf2 = new Rfc2898DeriveBytes(
            password,
            saltBytes,
            Iterations,
            HashAlgorithmName.SHA256))
        {
            byte[] hash = pbkdf2.GetBytes(HashSize);
            return Convert.ToBase64String(hash);
        }
    }

    /// <summary>
    /// Verifies a password against a stored hash and salt
    /// </summary>
    public bool VerifyPassword(string password, string storedHash, string storedSalt)
    {
        try
        {
            string computedHash = HashPassword(password, storedSalt);

            // Use timing-safe comparison to prevent timing attacks
            return CryptographicOperations.FixedTimeEquals(
                Convert.FromBase64String(computedHash),
                Convert.FromBase64String(storedHash)
            );
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Stores or updates a password for a business entity
    /// </summary>
    public async Task<bool> StorePasswordAsync(int businessEntityId, string password)
    {
        using var connection = await CreateConnectionAsync();

        string salt = GenerateSalt();
        string hash = HashPassword(password, salt);

        // Check if password already exists
        var existingSql = @"
            SELECT COUNT(1) 
            FROM [Person].[Password] 
            WHERE BusinessEntityID = @BusinessEntityId";

        var exists = await connection.ExecuteScalarAsync<int>(existingSql, new { BusinessEntityId = businessEntityId }) > 0;

        if (exists)
        {
            // Update existing password
            var updateSql = @"
                UPDATE [Person].[Password]
                SET PasswordHash = @Hash,
                    PasswordSalt = @Salt,
                    ModifiedDate = GETDATE()
                WHERE BusinessEntityID = @BusinessEntityId";

            var rowsAffected = await connection.ExecuteAsync(updateSql, new
            {
                BusinessEntityId = businessEntityId,
                Hash = hash,
                Salt = salt
            });

            return rowsAffected > 0;
        }
        else
        {
            // Insert new password
            var insertSql = @"
                INSERT INTO [Person].[Password] 
                    (BusinessEntityID, PasswordHash, PasswordSalt, rowguid, ModifiedDate)
                VALUES 
                    (@BusinessEntityId, @Hash, @Salt, NEWID(), GETDATE())";

            var rowsAffected = await connection.ExecuteAsync(insertSql, new
            {
                BusinessEntityId = businessEntityId,
                Hash = hash,
                Salt = salt
            });

            return rowsAffected > 0;
        }
    }

    /// <summary>
    /// Retrieves a password record for a business entity
    /// </summary>
    public async Task<Password?> GetPasswordAsync(int businessEntityId)
    {
        using var connection = await CreateConnectionAsync();

        var sql = @"
            SELECT 
                BusinessEntityID,
                PasswordHash,
                PasswordSalt,
                rowguid,
                ModifiedDate
            FROM [Person].[Password]
            WHERE BusinessEntityID = @BusinessEntityId";

        return await connection.QuerySingleOrDefaultAsync<Password>(sql, new { BusinessEntityId = businessEntityId });
    }

    /// <summary>
    /// Verifies a password for a business entity
    /// </summary>
    public async Task<bool> VerifyPasswordAsync(int businessEntityId, string password)
    {
        var passwordRecord = await GetPasswordAsync(businessEntityId);

        if (passwordRecord == null)
        {
            return false;
        }

        return VerifyPassword(password, passwordRecord.PasswordHash, passwordRecord.PasswordSalt);
    }
}
