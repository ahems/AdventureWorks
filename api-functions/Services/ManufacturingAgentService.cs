using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

/// <summary>
/// Unused: this class is not registered in Program.cs. New orders are queued to
/// <c>manufacturing-agent-queue</c> by <c>OrderPlacedSqlTrigger</c>, and
/// <c>ManufacturingAgentQueueTrigger</c> invokes the hosted Manufacturing agent.
/// </summary>
public class ManufacturingAgentService
{
    private readonly ILogger<ManufacturingAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public ManufacturingAgentService(
        ILogger<ManufacturingAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _telemetryClient = telemetryClient;
        _foundryClient = foundryClient;
        _agentId = configuration["AI_AGENT_MANUFACTURING_ID"]
            ?? throw new InvalidOperationException(
                "AI_AGENT_MANUFACTURING_ID environment variable is not set");
    }

    /// <summary>
    /// Fire-and-forget invocation of the Manufacturing Agent.
    /// The caller returns immediately; the Foundry run continues in the background.
    /// </summary>
    /// <param name="salesOrderId">The <c>SalesOrderID</c> of the newly placed order.</param>
    /// <param name="customerId">The <c>CustomerID</c> associated with the order.</param>
    public void InvokeFireAndForget(int salesOrderId, int customerId)
    {
        _ = Task.Run(async () =>
        {
            using var operation = _telemetryClient.StartOperation<RequestTelemetry>(
                "ManufacturingAgent.Invoke");
            operation.Telemetry.Properties["SalesOrderId"] = salesOrderId.ToString();
            operation.Telemetry.Properties["CustomerId"] = customerId.ToString();

            try
            {
                _logger.LogInformation(
                    "Invoking manufacturing agent for SalesOrderID={SalesOrderId}, CustomerID={CustomerId}",
                    salesOrderId, customerId);

                var message =
                    $"New sales order received. SalesOrderID={salesOrderId}, CustomerID={customerId}. " +
                    "Please acknowledge this order trigger and review whether any ordered products " +
                    "require manufacturing or supply chain attention to maintain adequate stock levels.";

                var response = await _foundryClient.InvokeAsync(
                    agentId: _agentId,
                    userMessage: message,
                    userId: $"manufacturing-trigger-order-{salesOrderId}");

                _logger.LogInformation(
                    "Manufacturing agent acknowledged SalesOrderID={SalesOrderId}. ResponseId={ResponseId}",
                    salesOrderId, response.ResponseId);

                operation.Telemetry.Properties["ResponseId"] = response.ResponseId ?? string.Empty;
                operation.Telemetry.Success = true;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "Manufacturing agent invocation failed for SalesOrderID={SalesOrderId}",
                    salesOrderId);
                operation.Telemetry.Success = false;
            }
        });
    }
}
