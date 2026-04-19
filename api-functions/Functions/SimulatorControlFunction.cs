using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Coordinated simulator control endpoint.
/// Consolidates the reset operation so all three simulators (manufacturing queue,
/// supply chain, and bank) are cleared together in the correct order, avoiding orphaned
/// bank transactions from partial resets.
/// </summary>
public class SimulatorControlFunction
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private readonly ILogger<SimulatorControlFunction> _logger;
    private readonly SupplyChainService _supplyChain;
    private readonly BankService _bank;

    public SimulatorControlFunction(
        ILogger<SimulatorControlFunction> logger,
        SupplyChainService supplyChain,
        BankService bank)
    {
        _logger      = logger;
        _supplyChain = supplyChain;
        _bank        = bank;
    }

    /// <summary>
    /// Resets all simulators in the correct order:
    /// 1. Clear the manufacturing work-order queue (stops in-flight routing operations).
    /// 2. Reset the supply chain (reverts all POs to initial state, re-seeds vendor stock).
    /// 3. Reset the bank (wipes all transactions, re-seeds the USD balance from profit data).
    ///
    /// Use this instead of individual resets to ensure bank transactions remain
    /// consistent with simulator state.
    /// </summary>
    [Function("SimulatorsReset")]
    public async Task<HttpResponseData> Reset(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "simulators/reset")]
        HttpRequestData req)
    {
        _logger.LogWarning("[SimulatorControl] Full simulator reset requested from {IP}",
            req.Headers.TryGetValues("X-Forwarded-For", out var fwd) ? string.Join(", ", fwd) : "unknown");

        var steps = new List<string>();

        // Step 1 — Clear manufacturing queue
        try
        {
            var queueClient = await ManufacturingControlFunction.GetQueueClientAsync();
            await queueClient.ClearMessagesAsync();
            steps.Add("Manufacturing queue cleared.");
            _logger.LogInformation("[SimulatorControl] Step 1 complete: manufacturing queue cleared.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[SimulatorControl] Step 1 failed: could not clear manufacturing queue.");
            steps.Add($"Manufacturing queue clear FAILED: {ex.Message}");
        }

        // Step 2 — Reset supply chain
        try
        {
            await _supplyChain.ResetAsync();
            steps.Add("Supply chain reset. Vendor stock re-seeded.");
            _logger.LogInformation("[SimulatorControl] Step 2 complete: supply chain reset.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[SimulatorControl] Step 2 failed: could not reset supply chain.");
            steps.Add($"Supply chain reset FAILED: {ex.Message}");
        }

        // Step 3 — Reset bank (last — so all pre-reset transactions are wiped consistently)
        try
        {
            await _bank.ResetAsync();
            var accounts = await _bank.GetAllAccountsAsync();
            var total    = await _bank.GetTotalUsdAsync(accounts);
            steps.Add($"Bank reset and re-seeded. New USD total: ${total:N2}");
            _logger.LogInformation("[SimulatorControl] Step 3 complete: bank reset. USD total={Total:N2}", total);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[SimulatorControl] Step 3 failed: could not reset bank.");
            steps.Add($"Bank reset FAILED: {ex.Message}");
        }

        var resp = req.CreateResponse(HttpStatusCode.OK);
        resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await resp.WriteStringAsync(JsonSerializer.Serialize(new
        {
            message  = "Simulator reset complete.",
            steps,
            resetAtUtc = DateTimeOffset.UtcNow,
        }, _json));
        return resp;
    }
}
