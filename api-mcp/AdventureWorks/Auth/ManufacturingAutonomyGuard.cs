using System.Globalization;
using System.Text.Json;

namespace AdventureWorks.Auth;

/// <summary>Checks the persisted autonomy setting before a service executes an agent action.</summary>
public sealed class ManufacturingAutonomyGuard(HttpClient http, ILogger<ManufacturingAutonomyGuard> logger)
{
    internal static bool IsAction(string? tool) =>
        tool is "begin_manufacturing_run" or "place_supply_order";

    internal static bool RequiresCheck(string category, string tool) =>
        category == UserCategories.Service && IsAction(tool);

    public async Task<bool> IsFullyAutonomousAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await http.GetAsync("api/manufacturing/agent-config", cancellationToken);
            response.EnsureSuccessStatusCode();
            await using var body = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var document = await JsonDocument.ParseAsync(body, cancellationToken: cancellationToken);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("mode", out var modeElement) ||
                modeElement.ValueKind != JsonValueKind.Number ||
                !modeElement.TryGetInt32(out var mode) ||
                !root.TryGetProperty("modeLabel", out var label) ||
                label.ValueKind != JsonValueKind.String ||
                !root.TryGetProperty("isAgentActive", out var active) ||
                active.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                !root.TryGetProperty("autoShutoffAt", out var shutoff))
                throw new JsonException("Manufacturing autonomy configuration is incomplete.");

            var expectedLabel = mode switch
            {
                0 => "Off",
                1 => "ReadOnly",
                2 => "ProposePending",
                3 => "FullyAutonomous",
                _ => null,
            };
            if (expectedLabel is null || label.GetString() != expectedLabel ||
                active.GetBoolean() != (mode != 0))
                throw new JsonException("Manufacturing autonomy configuration is inconsistent.");

            DateTimeOffset? expiresAt = null;
            if (shutoff.ValueKind != JsonValueKind.Null)
            {
                if (shutoff.ValueKind != JsonValueKind.String ||
                    !DateTimeOffset.TryParseExact(shutoff.GetString(), "O", CultureInfo.InvariantCulture,
                        DateTimeStyles.None, out var parsed))
                    throw new JsonException("Manufacturing autonomy expiry is invalid.");
                expiresAt = parsed;
            }

            return mode == 3 && (!expiresAt.HasValue || expiresAt > DateTimeOffset.UtcNow);
        }
        catch (Exception error) when (error is HttpRequestException or JsonException or IOException ||
                                      error is TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(error, "Unable to verify manufacturing autonomy configuration; denying service action.");
            return false;
        }
    }
}
