using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Single-shot Azure AI Foundry Agent service that analyses abandoned shopping carts
/// and returns a per-cart recovery strategy (score, urgency, email copy, discount).
///
/// Foundry features used:
///   - x-memory-user-id → scopes memory per analysis session for consistent scoring
///   - tool_choice: none → the agent reasons only over the cart data supplied in the
///                         user message; no MCP tool calls are required
///
/// Cart data is passed directly in the user message as JSON (same batch-of-10 cap
/// as the previous direct-OpenAI implementation). The agent instructions in the
/// Foundry portal define the output schema; this service parses the JSON array
/// response and maps it back to <see cref="CartRecoveryResult"/> objects.
/// </summary>
public class CartRecoveryAgentService
{
    private readonly ILogger<CartRecoveryAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public CartRecoveryAgentService(
        ILogger<CartRecoveryAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        var agentId = configuration["AI_AGENT_CART_RECOVERY_ID"];
        _agentId = agentId ?? throw new InvalidOperationException(
            "AI_AGENT_CART_RECOVERY_ID environment variable is not set");
    }

    /// <summary>
    /// Analyses the provided abandoned carts and returns one recovery strategy per cart.
    /// Carts are processed in batches of 10 to stay within context window limits.
    /// Batches that fail are returned with <see cref="CartRecoveryResult.Error"/> set so
    /// callers receive partial results rather than a hard failure.
    /// </summary>
    public async Task<List<CartRecoveryResult>> AnalyzeCartsAsync(List<CartRecoveryInput> carts)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("CartRecoveryAgent.Analyze");
        operation.Telemetry.Properties["CartCount"] = carts.Count.ToString();

        var results = new List<CartRecoveryResult>();
        const int batchSize = 10;

        for (int i = 0; i < carts.Count; i += batchSize)
        {
            var batch = carts.Skip(i).Take(batchSize).ToList();
            try
            {
                var batchResults = await AnalyzeBatchAsync(batch);
                results.AddRange(batchResults);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "CartRecoveryAgent batch failed at index {Index}", i);
                results.AddRange(batch.Select(c => new CartRecoveryResult
                {
                    CartId = c.CartId,
                    RecoveryScore = 0,
                    Urgency = "low",
                    Error = "Analysis unavailable"
                }));
            }
        }

        operation.Telemetry.Success = true;
        _telemetryClient.TrackEvent("CartRecoveryAgent.Complete", new Dictionary<string, string>
        {
            ["CartCount"] = carts.Count.ToString(),
            ["ResultCount"] = results.Count.ToString()
        });

        return results;
    }

    private async Task<List<CartRecoveryResult>> AnalyzeBatchAsync(List<CartRecoveryInput> carts)
    {
        // All dynamic cart data is passed in the user message. The agent instructions
        // in Foundry define the expected JSON output schema. No structured_inputs are
        // needed because the cart data varies per request and does not map to
        // Handlebars templates in the agent instructions.
        var cartPayload = JsonSerializer.Serialize(carts.Select(c => new
        {
            cartId      = c.CartId,
            customerName = c.CustomerName,
            totalValue  = c.TotalValue,
            daysStale   = c.DaysStale,
            totalItems  = c.TotalItems,
            products    = c.ProductNames ?? new List<string>()
        }), new JsonSerializerOptions { WriteIndented = false });

        var userMessage = $"Abandoned carts to analyse:\n\n{cartPayload}";

        // Scope Foundry memory per analysis session. Using a fixed key keeps the
        // agent's memory consistent across successive analyses in the same session.
        const string memoryUserId = "cart-recovery-analysis";

        // tool_choice: "none" — the agent only needs the provided cart data;
        // no MCP tool calls are required or expected.
        var agentResponse = await _foundryClient.InvokeAsync(
            agentId: _agentId,
            userMessage: userMessage,
            userId: memoryUserId,
            toolChoice: "none");

        _logger.LogInformation("CartRecoveryAgent response length: {Length}", agentResponse.ResponseText.Length);

        return ParseResults(agentResponse.ResponseText, carts);
    }

    private static List<CartRecoveryResult> ParseResults(string rawResponse, List<CartRecoveryInput> carts)
    {
        // Strip markdown code fences if the model added them
        var cleaned = Regex.Replace(rawResponse, @"^```(?:json)?\s*", "", RegexOptions.Multiline);
        cleaned = Regex.Replace(cleaned, @"```\s*$", "", RegexOptions.Multiline).Trim();

        // Extract the JSON array
        var start = cleaned.IndexOf('[');
        var end   = cleaned.LastIndexOf(']');
        if (start >= 0 && end > start)
            cleaned = cleaned[start..(end + 1)];

        var results = JsonSerializer.Deserialize<List<CartRecoveryResult>>(cleaned,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

        return results ?? carts.Select(c => new CartRecoveryResult
        {
            CartId = c.CartId,
            Error  = "Parse error"
        }).ToList();
    }
}
