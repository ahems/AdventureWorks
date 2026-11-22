using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// Background upkeep that used to run as a side effect of HTTP GET routes, which are now pure reads:
/// seeds the bank, warehouse, workforce and supply-chain simulation state when it is missing
/// (idempotent; also on host start), persists the manufacturing agent auto-shutoff, rejects
/// expired or over-cap agent proposals, and prunes shortage rows for deleted work orders.
/// Each step is isolated so one failing dependency does not block the others.
/// </summary>
public sealed class SimulationMaintenanceFunction(
    BankService bank,
    WarehouseService warehouse,
    WorkforceService workforce,
    SupplyChainService supplyChain,
    ManufacturingAgentConfigService agentConfig,
    ManufacturingProposalService proposals,
    WorkOrderSimulationService workOrders,
    ILogger<SimulationMaintenanceFunction> logger)
{
    [Function("SimulationMaintenance_Timer")]
    public async Task Run([TimerTrigger("0 * * * * *", RunOnStartup = true)] TimerInfo timer)
    {
        await StepAsync("bank initialization", () => bank.InitializeAsync());
        await StepAsync("warehouse initialization", () => warehouse.InitializeAsync());
        await StepAsync("workforce initialization", () => workforce.InitializeAsync());
        await StepAsync("supply-chain initialization", () => supplyChain.InitializeAsync());
        await StepAsync("agent auto-shutoff", () => agentConfig.EnforceAutoShutoffAsync());
        await StepAsync("proposal expiry", () => proposals.ExpirePendingAsync());
        await StepAsync("shortage pruning", () => workOrders.PruneStaleShortagesAsync());
    }

    private async Task StepAsync(string name, Func<Task> step)
    {
        try
        {
            await step();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[SimulationMaintenance] {Step} failed; it is retried on the next run.", name);
        }
    }
}
