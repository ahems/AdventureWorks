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
    public async Task SendToGroupAsync(string group, object payload)
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
