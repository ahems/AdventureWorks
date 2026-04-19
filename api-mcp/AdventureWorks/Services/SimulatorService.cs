using System.Text;
using System.Text.Json;

namespace AdventureWorks.Services;

/// <summary>
/// Proxy service for the coordinated simulator control endpoints in api-functions.
/// Provides a single reset operation that clears all three simulators in the correct order.
/// </summary>
public class SimulatorService
{
    private readonly HttpClient _http;

    public SimulatorService(HttpClient http) => _http = http;

    /// <summary>
    /// Resets all simulators: clears the manufacturing queue, resets the supply chain,
    /// then resets the bank. All three are wiped together to ensure transactional consistency.
    /// </summary>
    public async Task<string> ResetAllSimulatorsAsync()
    {
        var resp = await _http.PostAsync("api/simulators/reset", null);
        if (!resp.IsSuccessStatusCode)
            return $"Simulator reset failed ({resp.StatusCode}).";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Simulator Reset Complete");
        sb.AppendLine();

        if (root.TryGetProperty("steps", out var steps) && steps.ValueKind == JsonValueKind.Array)
        {
            foreach (var step in steps.EnumerateArray())
                sb.AppendLine($"  ✓ {step.GetString()}");
        }

        if (root.TryGetProperty("resetAtUtc", out var ts))
            sb.AppendLine();
            sb.AppendLine($"Reset completed at: {ts.GetString()}");

        return sb.ToString();
    }
}
