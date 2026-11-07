using System.Collections.Concurrent;
using System.Text.Json;
using Azure.Identity;
using Azure.Messaging.WebPubSub;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

/// <summary>
/// Sends real-time push notifications to connected browser clients via Azure Web PubSub.
/// All calls are fire-and-forget — push failures are logged but never block the mutation flow.
/// Uses a single hub ("adventureworks") with multiple groups for topic-based routing.
/// </summary>
public class WebPubSubService
{
    private static readonly JsonSerializerOptions JsonOpts =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>Allowed groups that clients may subscribe to.</summary>
    public static readonly HashSet<string> AllowedGroups = new(StringComparer.OrdinalIgnoreCase)
    {
        "manufacturing-agent",
        "manufacturing-ops",
        "warehouse",
        "supply-chain",
        "orders",
        "shopping-simulator",
        "reviews",
        "finance",
        "promotions",
        "utilities",
    };

    private readonly WebPubSubServiceClient? _client;
    private readonly ILogger<WebPubSubService> _logger;

    public WebPubSubService(string? hostName, DefaultAzureCredential credential, ILogger<WebPubSubService> logger)
    {
        _logger = logger;

        if (string.IsNullOrWhiteSpace(hostName))
        {
            _logger.LogWarning("[WebPubSub] WEB_PUBSUB_HOST_NAME is not configured — real-time push is disabled.");
            _client = null;
            return;
        }

        var endpoint = new Uri($"https://{hostName}");
        _client = new WebPubSubServiceClient(endpoint, "adventureworks", credential);
    }

    /// <summary>Whether the service is configured and able to send messages.</summary>
    public bool IsEnabled => _client != null;

    /// <summary>
    /// Sends a JSON message to all clients subscribed to the specified group.
    /// Fire-and-forget: exceptions are caught and logged, never rethrown.
    /// </summary>
    public virtual async Task SendToGroupAsync(string group, object payload)
    {
        if (_client == null) return;

        try
        {
            var json = JsonSerializer.Serialize(payload, JsonOpts);
            await _client.SendToGroupAsync(group, json, Azure.Core.ContentType.ApplicationJson);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[WebPubSub] Failed to push event to group '{Group}'. Clients will fall back to polling.", group);
        }
    }

    /// <summary>Window within which repeated invalidation events for the same key are collapsed.</summary>
    protected virtual TimeSpan CoalesceWindow => TimeSpan.FromSeconds(5);

    private sealed class CoalesceSlot
    {
        public DateTime LastSentUtc = DateTime.MinValue;
        public object? Pending;
        public bool TrailingScheduled;
    }

    private readonly ConcurrentDictionary<string, CoalesceSlot> _coalesceSlots = new();

    /// <summary>
    /// Sends a cache-invalidation event at most once per <see cref="CoalesceWindow"/> per (group, key):
    /// the first event is sent immediately and any further events in the window collapse into one
    /// trailing send carrying the latest payload. Use for high-frequency state-changed notifications
    /// (bulk warehouse/supply/bank writes) so bursts cannot exhaust the Web PubSub Free-tier quota.
    /// </summary>
    public async Task SendCoalescedAsync(string group, string key, object payload)
    {
        var slot = _coalesceSlots.GetOrAdd($"{group}\n{key}", _ => new CoalesceSlot());
        TimeSpan delay;
        lock (slot)
        {
            var now = DateTime.UtcNow;
            var elapsed = now - slot.LastSentUtc;
            if (!slot.TrailingScheduled && elapsed >= CoalesceWindow)
            {
                slot.LastSentUtc = now;
                delay = TimeSpan.Zero;
            }
            else
            {
                slot.Pending = payload;
                if (slot.TrailingScheduled) return;
                slot.TrailingScheduled = true;
                delay = CoalesceWindow - elapsed;
            }
        }

        if (delay <= TimeSpan.Zero)
        {
            await SendToGroupAsync(group, payload);
            return;
        }

        _ = Task.Run(async () =>
        {
            await Task.Delay(delay);
            object? latest;
            lock (slot)
            {
                latest = slot.Pending;
                slot.Pending = null;
                slot.TrailingScheduled = false;
                slot.LastSentUtc = DateTime.UtcNow;
            }
            if (latest != null) await SendToGroupAsync(group, latest);
        });
    }

    /// <summary>
    /// Generates a client access URL with permissions to join the specified groups.
    /// Returns null if the service is not configured.
    /// </summary>
    public async Task<Uri?> GetClientAccessUriAsync(IEnumerable<string> groups)
    {
        if (_client == null) return null;

        var validGroups = groups.Where(g => AllowedGroups.Contains(g)).ToArray();
        var uri = await _client.GetClientAccessUriAsync(
            expiresAfter: TimeSpan.FromHours(1),
            groups: validGroups);
        return uri;
    }
}
