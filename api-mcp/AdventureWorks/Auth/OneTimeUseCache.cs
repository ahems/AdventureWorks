using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace AdventureWorks.Auth;

/// <summary>
/// Tracks redeemed authorization codes so each code can be exchanged at most once.
/// OpenIddict token storage is disabled (self-contained tokens survive api-mcp scale-to-zero
/// restarts), which also disables OpenIddict's built-in code redemption tracking; this cache
/// restores single-use semantics for the code's short lifetime. Only SHA-256 hashes are kept.
/// </summary>
public sealed class OneTimeUseCache
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> _entries = new(StringComparer.Ordinal);
    private DateTimeOffset _lastPurge = DateTimeOffset.UtcNow;

    /// <summary>Returns <c>true</c> the first time a value is seen; <c>false</c> on replay.</summary>
    public bool TryConsume(string value, TimeSpan retention)
    {
        var now = DateTimeOffset.UtcNow;
        PurgeExpired(now);

        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
        return _entries.TryAdd(key, now + retention);
    }

    private void PurgeExpired(DateTimeOffset now)
    {
        if (now - _lastPurge < TimeSpan.FromMinutes(1))
        {
            return;
        }

        _lastPurge = now;
        foreach (var (key, expiry) in _entries)
        {
            if (expiry <= now)
            {
                _entries.TryRemove(key, out _);
            }
        }
    }
}
