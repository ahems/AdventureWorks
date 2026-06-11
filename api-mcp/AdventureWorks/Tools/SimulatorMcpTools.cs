using System.ComponentModel;
using AdventureWorks.Services;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using ModelContextProtocol.Server;

namespace AdventureWorks.Tools;

/// <summary>
/// MCP tools for coordinated simulator control.
/// Provides a single reset operation that clears all three simulators together
/// (manufacturing queue, supply chain, bank) in the correct order to avoid
/// orphaned bank transactions from partial resets.
/// </summary>
[McpServerToolType]
public class SimulatorMcpTools
{
    private readonly SimulatorService _simulator;
    private readonly TelemetryClient _telemetryClient;

    public SimulatorMcpTools(SimulatorService simulator, TelemetryClient telemetryClient)
    {
        _simulator       = simulator;
        _telemetryClient = telemetryClient;
    }

    [McpServerTool]
    [Description("Reset ALL simulators together in the correct order: (1) clears the manufacturing work-order queue, (2) resets the supply chain and re-seeds vendor stock, (3) resets the bank and re-seeds the USD balance from historical profit. Use this instead of individual resets to ensure bank transactions remain consistent with simulator state. WARNING: all transaction history, vendor stock levels, and in-flight work orders will be permanently cleared.")]
    public async Task<string> ResetAllSimulators()
    {
        using var op = _telemetryClient.StartOperation<RequestTelemetry>("MCP_ResetAllSimulators");
        try
        {
            var result = await _simulator.ResetAllSimulatorsAsync();
            op.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "ResetAllSimulators" } });
            return result;
        }
        catch (Exception ex)
        {
            op.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "ResetAllSimulators" } });
            throw;
        }
    }
}
