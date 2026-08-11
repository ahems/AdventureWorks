using System.ComponentModel;
using AdventureWorks.Services;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace AdventureWorks.Tools;

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
    public async Task<string> ResetAllSimulators(
        McpServer server,
        RequestContext<CallToolRequestParams> context,
        [Description("Set to true to skip confirmation (for programmatic/autonomous callers).")] bool confirmed = false)
    {
        // MRTR confirmation for interactive clients
        if (!confirmed)
        {
            if (context.Params?.InputResponses?.TryGetValue("confirm", out var response) is true)
            {
                var result = response.Deserialize(InputResponse.ElicitResultJsonTypeInfo);
                if (result?.IsAccepted is not true)
                    return "Reset cancelled by user.";
            }
            else if (server.IsMrtrSupported)
            {
                throw new InputRequiredException(
                    inputRequests: new Dictionary<string, InputRequest>
                    {
                        ["confirm"] = InputRequest.ForElicitation(new ElicitRequestParams
                        {
                            Message = "This will permanently clear ALL transaction history, vendor stock levels, and in-flight work orders across all three simulators. Are you sure?",
                            RequestedSchema = new()
                            {
                                Properties =
                                {
                                    ["confirm"] = new ElicitRequestParams.StringSchema
                                    {
                                        Title = "Confirm reset",
                                        Description = "Accept to proceed with the full reset.",
                                    },
                                },
                            },
                        })
                    },
                    requestState: "reset-all");
            }
            else
            {
                return "This is a destructive operation. Resend with confirmed=true to proceed.";
            }
        }

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
