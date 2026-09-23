using AdventureWorks.Auth;
using Xunit;

namespace AdventureWorks.Tests;

/// <summary>
/// Verifies PBKDF2 password verification is compatible with the app's PasswordService
/// scheme (SHA256, 100k iterations, 96-byte key, 6-byte salt) and is resistant to
/// malformed input. No plaintext is ever logged.
/// </summary>
public class PasswordHasherTests
{
    [Fact]
    public void Hash_then_verify_round_trips()
    {
        var salt = PasswordHasher.GenerateSalt();
        var hash = PasswordHasher.Hash("Demo!Pass123", salt);

        Assert.True(PasswordHasher.Verify("Demo!Pass123", hash, salt));
    }

    [Fact]
    public void Verify_rejects_wrong_password()
    {
        var salt = PasswordHasher.GenerateSalt();
        var hash = PasswordHasher.Hash("correct-horse", salt);

        Assert.False(PasswordHasher.Verify("battery-staple", hash, salt));
    }

    [Fact]
    public void Verify_rejects_empty_input()
    {
        var salt = PasswordHasher.GenerateSalt();
        var hash = PasswordHasher.Hash("something", salt);

        Assert.False(PasswordHasher.Verify("", hash, salt));
        Assert.False(PasswordHasher.Verify("something", "", salt));
        Assert.False(PasswordHasher.Verify("something", hash, ""));
    }

    [Fact]
    public void Verify_rejects_malformed_base64_without_throwing()
    {
        Assert.False(PasswordHasher.Verify("something", "not-base64!!!", "also-not!!"));
    }

    [Fact]
    public void Generated_salt_is_six_bytes()
    {
        var salt = PasswordHasher.GenerateSalt();
        Assert.Equal(6, Convert.FromBase64String(salt).Length);
    }

    [Fact]
    public void Hash_is_96_bytes()
    {
        var salt = PasswordHasher.GenerateSalt();
        var hash = PasswordHasher.Hash("anything", salt);
        Assert.Equal(96, Convert.FromBase64String(hash).Length);
    }

    [Fact]
    public void Same_password_different_salts_produce_different_hashes()
    {
        var h1 = PasswordHasher.Hash("same", PasswordHasher.GenerateSalt());
        var h2 = PasswordHasher.Hash("same", PasswordHasher.GenerateSalt());
        Assert.NotEqual(h1, h2);
    }
}
