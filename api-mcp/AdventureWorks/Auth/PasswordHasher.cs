using System.Security.Cryptography;

namespace AdventureWorks.Auth;

/// <summary>
/// PBKDF2 password verification compatible with the AdventureWorks app's
/// <c>PasswordService</c> (api-functions): PBKDF2-SHA256, 100,000 iterations,
/// 96-byte derived key, base64-encoded hash and salt stored in <c>Person.Password</c>.
///
/// The authorization server verifies credentials against the SAME store the apps use.
/// It never logs or persists plaintext passwords.
/// </summary>
public static class PasswordHasher
{
    private const int Iterations = 100_000;
    private const int HashSize = 96;
    private const int SaltSize = 6;

    /// <summary>Derives a base64 hash for the given password + base64 salt.</summary>
    public static string Hash(string password, string base64Salt)
    {
        byte[] salt = Convert.FromBase64String(base64Salt);
        using var pbkdf2 = new Rfc2898DeriveBytes(password, salt, Iterations, HashAlgorithmName.SHA256);
        return Convert.ToBase64String(pbkdf2.GetBytes(HashSize));
    }

    /// <summary>Generates a new random base64 salt (matches the app's 6-byte salt).</summary>
    public static string GenerateSalt()
    {
        byte[] salt = new byte[SaltSize];
        RandomNumberGenerator.Fill(salt);
        return Convert.ToBase64String(salt);
    }

    /// <summary>Constant-time verification of a password against stored base64 hash + salt.</summary>
    public static bool Verify(string password, string storedBase64Hash, string storedBase64Salt)
    {
        if (string.IsNullOrEmpty(password) || string.IsNullOrEmpty(storedBase64Hash) || string.IsNullOrEmpty(storedBase64Salt))
        {
            return false;
        }

        try
        {
            string computed = Hash(password, storedBase64Salt);
            return CryptographicOperations.FixedTimeEquals(
                Convert.FromBase64String(computed),
                Convert.FromBase64String(storedBase64Hash));
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
