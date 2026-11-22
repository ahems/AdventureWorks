using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Azure;
using Azure.Core;
using Azure.Data.Tables;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

/// <summary>Cost buckets for the anonymous storefront AI routes.</summary>
public enum AiRateLimitBucket
{
    /// <summary>Help Me Choose questions and recommendations (Foundry agent calls).</summary>
    HelpMe,
    /// <summary>Semantic search and type-ahead suggestions (embedding calls).</summary>
    Search
}

public sealed record AiRateLimitOptions
{
    public const string TableName = "aiRateLimits";

    public int HelpMePerClientLimit { get; init; } = 20;
    public int SearchPerClientLimit { get; init; } = 60;
    public TimeSpan Window { get; init; } = TimeSpan.FromMinutes(5);
    public int HelpMeDailyBudget { get; init; } = 1000;
    public int SearchDailyBudget { get; init; } = 5000;
    public string HashSalt { get; init; } = "adventureworks-ai-rate-limit";

    public int PerClientLimit(AiRateLimitBucket bucket) =>
        bucket == AiRateLimitBucket.HelpMe ? HelpMePerClientLimit : SearchPerClientLimit;

    public int DailyBudget(AiRateLimitBucket bucket) =>
        bucket == AiRateLimitBucket.HelpMe ? HelpMeDailyBudget : SearchDailyBudget;

    public static AiRateLimitOptions FromConfiguration(IConfiguration configuration)
    {
        var defaults = new AiRateLimitOptions();
        int Read(string key, int fallback) =>
            int.TryParse(configuration[key], NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) && value > 0
                ? value
                : fallback;

        var salt = configuration["AI_RATE_LIMIT_HASH_SALT"];
        return new AiRateLimitOptions
        {
            HelpMePerClientLimit = Read("AI_RATE_LIMIT_HELPME_PER_WINDOW", defaults.HelpMePerClientLimit),
            SearchPerClientLimit = Read("AI_RATE_LIMIT_SEARCH_PER_WINDOW", defaults.SearchPerClientLimit),
            Window = TimeSpan.FromSeconds(Read("AI_RATE_LIMIT_WINDOW_SECONDS", (int)defaults.Window.TotalSeconds)),
            HelpMeDailyBudget = Read("AI_RATE_LIMIT_HELPME_DAILY_BUDGET", defaults.HelpMeDailyBudget),
            SearchDailyBudget = Read("AI_RATE_LIMIT_SEARCH_DAILY_BUDGET", defaults.SearchDailyBudget),
            HashSalt = string.IsNullOrWhiteSpace(salt) ? defaults.HashSalt : salt
        };
    }
}

public sealed record AiRateLimitDecision(bool Allowed, int RetryAfterSeconds, string? Scope)
{
    public static readonly AiRateLimitDecision Allow = new(true, 0, null);
}

/// <summary>Atomic counter store used by <see cref="AiRateLimitService"/>.</summary>
public interface IAiRateLimitCounterStore
{
    /// <summary>
    /// Increments the counter unless it already reached <paramref name="limit"/>, and returns the
    /// resulting count. A value above <paramref name="limit"/> means the request must be refused.
    /// </summary>
    Task<long> IncrementAsync(string partitionKey, string rowKey, int limit, DateTimeOffset expiresAt, CancellationToken cancellationToken);
}

/// <summary>
/// Table Storage counters in the IaC-provisioned <c>aiRateLimits</c> table. Updates use ETag
/// optimistic concurrency so concurrent Flex instances never lose increments.
/// </summary>
public sealed class TableAiRateLimitCounterStore(TableClient table) : IAiRateLimitCounterStore
{
    private const int MaxAttempts = 8;

    public async Task<long> IncrementAsync(string partitionKey, string rowKey, int limit, DateTimeOffset expiresAt, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var existing = await table.GetEntityIfExistsAsync<TableEntity>(partitionKey, rowKey, cancellationToken: cancellationToken);
            if (!existing.HasValue || existing.Value is null)
            {
                try
                {
                    await table.AddEntityAsync(new TableEntity(partitionKey, rowKey)
                    {
                        ["Count"] = 1L,
                        ["ExpiresAt"] = expiresAt
                    }, cancellationToken);
                    return 1;
                }
                catch (RequestFailedException ex) when (ex.Status == 409)
                {
                    continue;
                }
            }

            var entity = existing.Value;
            var count = entity.GetInt64("Count") ?? 0;
            if (count >= limit)
                return count + 1;

            entity["Count"] = count + 1;
            try
            {
                await table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace, cancellationToken);
                return count + 1;
            }
            catch (RequestFailedException ex) when (ex.Status == 412)
            {
                await Task.Delay(Random.Shared.Next(5, 25 * (attempt + 1)), cancellationToken);
            }
        }

        throw new InvalidOperationException("AI rate-limit counter update did not converge.");
    }
}

/// <summary>
/// Cost protection for the anonymous storefront AI routes: a per-client fixed window plus a
/// global daily budget per bucket. Client addresses are stored only as salted HMAC digests.
/// If the counter table is unavailable the request is allowed and a warning is logged, so a
/// storage outage does not take the storefront AI features down in this demo.
/// </summary>
public sealed class AiRateLimitService(
    IAiRateLimitCounterStore store,
    AiRateLimitOptions options,
    TimeProvider timeProvider,
    ILogger<AiRateLimitService> logger)
{
    public AiRateLimitOptions Options => options;

    public Task<AiRateLimitDecision> CheckAsync(HttpRequestData request, AiRateLimitBucket bucket, CancellationToken cancellationToken = default) =>
        CheckAsync(ResolveClientAddress(request.Headers), bucket, cancellationToken);

    public async Task<AiRateLimitDecision> CheckAsync(string clientAddress, AiRateLimitBucket bucket, CancellationToken cancellationToken = default)
    {
        var now = timeProvider.GetUtcNow();
        var bucketName = bucket.ToString().ToLowerInvariant();
        var windowTicks = options.Window.Ticks;
        var windowStart = new DateTimeOffset(now.UtcTicks - now.UtcTicks % windowTicks, TimeSpan.Zero);
        var windowEnd = windowStart + options.Window;
        var dayEnd = new DateTimeOffset(now.UtcDateTime.Date.AddDays(1), TimeSpan.Zero);

        try
        {
            var clientCount = await store.IncrementAsync(
                $"client-{HashClient(clientAddress)}",
                $"{bucketName}-{windowStart:yyyyMMddHHmmss}",
                options.PerClientLimit(bucket),
                windowEnd,
                cancellationToken);
            if (clientCount > options.PerClientLimit(bucket))
                return new(false, SecondsUntil(now, windowEnd), "client");

            var dailyCount = await store.IncrementAsync(
                "budget",
                $"{bucketName}-{now:yyyyMMdd}",
                options.DailyBudget(bucket),
                dayEnd,
                cancellationToken);
            if (dailyCount > options.DailyBudget(bucket))
            {
                logger.LogWarning("Daily anonymous AI budget for {Bucket} is exhausted", bucketName);
                return new(false, SecondsUntil(now, dayEnd), "daily");
            }

            return AiRateLimitDecision.Allow;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(ex, "AI rate-limit store unavailable for {Bucket}; allowing request", bucketName);
            return AiRateLimitDecision.Allow;
        }
    }

    public string HashClient(string clientAddress)
    {
        var digest = HMACSHA256.HashData(Encoding.UTF8.GetBytes(options.HashSalt), Encoding.UTF8.GetBytes(clientAddress));
        return Convert.ToHexString(digest, 0, 16).ToLowerInvariant();
    }

    /// <summary>
    /// Uses the first X-Forwarded-For hop added by the Flex Consumption front end. IPv6 clients are
    /// grouped by /64 so a single host cannot rotate addresses within its own prefix.
    /// </summary>
    public static string ResolveClientAddress(HttpHeadersCollection headers)
    {
        if (!headers.TryGetValues("X-Forwarded-For", out var values))
            return "unknown";

        var first = values.SelectMany(value => value.Split(',')).Select(part => part.Trim())
            .FirstOrDefault(part => part.Length > 0);
        return NormalizeAddress(first) ?? "unknown";
    }

    public static string? NormalizeAddress(string? candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate) || candidate.Length > 64)
            return null;

        var text = candidate.Trim();
        if (text.StartsWith('['))
        {
            var close = text.IndexOf(']');
            if (close < 0) return null;
            text = text[1..close];
        }
        else if (text.Count(c => c == ':') == 1)
        {
            text = text[..text.IndexOf(':')];
        }

        if (!IPAddress.TryParse(text, out var address))
            return null;
        if (address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var bytes = address.GetAddressBytes();
            Array.Clear(bytes, 8, 8);
            address = new IPAddress(bytes);
            return address + "/64";
        }

        return address.ToString();
    }

    private static int SecondsUntil(DateTimeOffset now, DateTimeOffset until) =>
        Math.Max(1, (int)Math.Ceiling((until - now).TotalSeconds));

    public static TableClient CreateTableClient(string tableServiceUri, TokenCredential credential) =>
        new(new Uri(tableServiceUri), AiRateLimitOptions.TableName, credential, new TableClientOptions
        {
            Retry = { MaxRetries = 1, NetworkTimeout = TimeSpan.FromSeconds(5) }
        });
}
