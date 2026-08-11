using System.ComponentModel;
using AdventureWorks.Services;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace AdventureWorks.Tools;

/// <summary>
/// MCP tools exposing the manufacturing simulation and planning APIs.
/// Intended for use by manufacturing and operations agents.
/// </summary>
[McpServerToolType]
public class ManufacturingMcpTools
{
    private readonly ManufacturingService _manufacturing;

    public ManufacturingMcpTools(ManufacturingService manufacturing)
    {
        _manufacturing = manufacturing;
    }

    // ── Simulation Control ───────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get the current live status of the manufacturing simulation: whether it is running, queue depth, work order counts (pending/in-progress/completed today), material shortages, recent scrap events, and load per production location.")]
    public async Task<string> GetManufacturingStatus()
    {
        return await _manufacturing.GetManufacturingStatusAsync();
    }

    [McpServerTool]
    [Description("List all manufacturing routing operations that are currently in progress, including elapsed time, product name, location, and operation sequence number. Use this to see what the shop floor is actively working on.")]
    public async Task<string> GetActiveManufacturingOperations()
    {
        return await _manufacturing.GetActiveOperationsAsync();
    }

    [McpServerTool]
    [Description("Start a new manufacturing production run for a finished good. Explodes the bill of materials, creates work orders for all components, and queues routing operations. The productId must be a finished good with MakeFlag=true. Use GetProductionFeasibility first to verify sufficient component stock.")]
    public async Task<string> BeginManufacturingRun(
        McpServer server,
        RequestContext<CallToolRequestParams> context,
        [Description("ProductID of the finished good to manufacture. Must have MakeFlag=true.")] int productId,
        [Description("Number of units to produce.")] int orderQty,
        [Description("Optional due date in ISO 8601 format (e.g. 2026-04-30). Defaults to 7 days from now.")] string? dueDate = null,
        [Description("Set to true to skip confirmation (for programmatic/autonomous callers).")] bool confirmed = false)
    {
        if (!confirmed)
        {
            if (context.Params?.InputResponses?.TryGetValue("confirm", out var response) is true)
            {
                var elicit = response.Deserialize(InputResponse.ElicitResultJsonTypeInfo);
                if (elicit?.IsAccepted is not true)
                    return "Manufacturing run cancelled.";
            }
            else if (server.IsMrtrSupported)
            {
                throw new InputRequiredException(
                    inputRequests: new Dictionary<string, InputRequest>
                    {
                        ["confirm"] = InputRequest.ForElicitation(new ElicitRequestParams
                        {
                            Message = $"Start manufacturing run: {orderQty}x Product #{productId}, due {dueDate ?? "7 days from now"}. This will create work orders and consume components. Proceed?",
                            RequestedSchema = new()
                            {
                                Properties =
                                {
                                    ["confirm"] = new ElicitRequestParams.StringSchema
                                    {
                                        Title = "Confirm production run",
                                    },
                                },
                            },
                        })
                    },
                    requestState: $"{productId}:{orderQty}:{dueDate}");
            }
            else
            {
                return "This is a destructive operation. Resend with confirmed=true to proceed.";
            }
        }

        DateTime? due = null;
        if (!string.IsNullOrEmpty(dueDate) && DateTime.TryParse(dueDate, out var d))
            due = d;

        return await _manufacturing.BeginManufacturingRunAsync(productId, orderQty, due);
    }

    [McpServerTool]
    [Description("Stop the manufacturing simulation by clearing the production queue. In-flight operations will finish but no new ones will be started. Use this when you need to pause manufacturing, for example to reconfigure scrap rates or location capacity before restarting.")]
    public async Task<string> StopManufacturing(
        McpServer server,
        RequestContext<CallToolRequestParams> context,
        [Description("Set to true to skip confirmation (for programmatic/autonomous callers).")] bool confirmed = false)
    {
        if (!confirmed)
        {
            if (context.Params?.InputResponses?.TryGetValue("confirm", out var response) is true)
            {
                var elicit = response.Deserialize(InputResponse.ElicitResultJsonTypeInfo);
                if (elicit?.IsAccepted is not true)
                    return "Stop manufacturing cancelled.";
            }
            else if (server.IsMrtrSupported)
            {
                throw new InputRequiredException(
                    inputRequests: new Dictionary<string, InputRequest>
                    {
                        ["confirm"] = InputRequest.ForElicitation(new ElicitRequestParams
                        {
                            Message = "This will clear the production queue. In-flight operations will complete but no new work will be started. Proceed?",
                            RequestedSchema = new()
                            {
                                Properties =
                                {
                                    ["confirm"] = new ElicitRequestParams.StringSchema
                                    {
                                        Title = "Confirm stop",
                                    },
                                },
                            },
                        })
                    },
                    requestState: "stop");
            }
            else
            {
                return "This is a destructive operation. Resend with confirmed=true to proceed.";
            }
        }

        return await _manufacturing.StopManufacturingAsync();
    }

    // ── Workforce ────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get a headcount summary of the manufacturing workforce grouped by production location and shift. Shows total workers and how many are currently active.")]
    public async Task<string> GetManufacturingWorkforce()
    {
        return await _manufacturing.GetWorkforceAsync();
    }

    // ── Quality / Scrap ──────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Retrieve scrap events recorded during manufacturing. Optionally filter by vendorId to investigate scrap attributable to components from a specific supplier. Shows product name, location, scrapped quantity, and scrap reason.")]
    public async Task<string> GetManufacturingScrapEvents(
        [Description("Optional vendor ID to filter scrap events to components supplied by that vendor.")] int? vendorId = null)
    {
        return await _manufacturing.GetScrapEventsAsync(vendorId);
    }

    [McpServerTool]
    [Description("Get an aggregated quality report per supplier vendor showing total components supplied, number of scrap events, total scrapped quantity, and scrap rate. Optionally scope to a single vendor by providing vendorId.")]
    public async Task<string> GetVendorQualityReport(
        [Description("Optional vendor ID to scope the report to a single supplier. Omit to get the full cross-vendor report.")] int? vendorId = null)
    {
        return await _manufacturing.GetVendorQualityReportAsync(vendorId);
    }

    // ── Scrap & Location Configuration ───────────────────────────────────────

    [McpServerTool]
    [Description("Get the current per-location scrap failure rates and applicable scrap reason codes. Use this to understand the current quality configuration of each production station before making adjustments.")]
    public async Task<string> GetScrapConfiguration()
    {
        return await _manufacturing.GetScrapConfigAsync();
    }

    [McpServerTool]
    [Description("Update the scrap failure rate for a specific production location. Used to simulate quality improvements or degradation. failureRatePct must be between 0.0 (no failures) and 1.0 (100% failure). Optionally provide scrapReasonIds (array of ints) to restrict which scrap reasons apply.")]
    public async Task<string> UpdateScrapConfiguration(
        McpServer server,
        RequestContext<CallToolRequestParams> context,
        [Description("The LocationID of the production station to update.")] int locationId,
        [Description("Failure rate as a decimal between 0.0 and 1.0 (e.g. 0.05 = 5% scrap rate).")] double failureRatePct,
        [Description("Optional comma-separated list of scrap reason IDs to apply at this location (e.g. '2,7,14').")] string? scrapReasonIds = null,
        [Description("Optional note describing why this configuration was changed.")] string? note = null,
        [Description("Set to true to skip confirmation (for programmatic/autonomous callers).")] bool confirmed = false)
    {
        if (!confirmed)
        {
            if (context.Params?.InputResponses?.TryGetValue("confirm", out var response) is true)
            {
                var elicit = response.Deserialize(InputResponse.ElicitResultJsonTypeInfo);
                if (elicit?.IsAccepted is not true)
                    return "Scrap configuration update cancelled.";
            }
            else if (server.IsMrtrSupported)
            {
                throw new InputRequiredException(
                    inputRequests: new Dictionary<string, InputRequest>
                    {
                        ["confirm"] = InputRequest.ForElicitation(new ElicitRequestParams
                        {
                            Message = $"Update scrap rate for Location #{locationId} to {failureRatePct:P0}. This changes the quality failure simulation for this station. Proceed?",
                            RequestedSchema = new()
                            {
                                Properties =
                                {
                                    ["confirm"] = new ElicitRequestParams.StringSchema
                                    {
                                        Title = "Confirm scrap configuration change",
                                    },
                                },
                            },
                        })
                    },
                    requestState: $"{locationId}:{failureRatePct}");
            }
            else
            {
                return "This is a destructive operation. Resend with confirmed=true to proceed.";
            }
        }

        int[]? reasonIds = null;
        if (!string.IsNullOrWhiteSpace(scrapReasonIds))
        {
            reasonIds = scrapReasonIds
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(s => int.TryParse(s, out int id) ? id : -1)
                .Where(id => id > 0)
                .ToArray();
        }

        return await _manufacturing.UpdateScrapConfigAsync(locationId, failureRatePct, reasonIds, note);
    }

    [McpServerTool]
    [Description("Get the capacity and shift configuration for all production locations, including capacity units, daily operating hours, speed factor, and shift start hour.")]
    public async Task<string> GetLocationConfiguration()
    {
        return await _manufacturing.GetLocationConfigAsync();
    }

    [McpServerTool]
    [Description("Update the capacity and shift settings for a specific production location. Use to simulate overtime, shift changes, or capacity expansions. speedFactor > 1.0 means faster than normal, < 1.0 means slower.")]
    public async Task<string> UpdateLocationConfiguration(
        McpServer server,
        RequestContext<CallToolRequestParams> context,
        [Description("The LocationID of the production station to update.")] int locationId,
        [Description("Number of parallel work units the station can handle (minimum 1).")] int capacityUnits,
        [Description("Hours per day the station operates (e.g. 8.0, 12.0, 16.0). Defaults to 8.")] double dailyOperatingHours = 8.0,
        [Description("Processing speed multiplier relative to standard routing time (e.g. 1.5 = 50% faster). Defaults to 1.0.")] double speedFactor = 1.0,
        [Description("Hour of day (0-23) when the shift starts. Defaults to 6.")] int shiftStartHour = 6,
        [Description("Optional note describing the reason for this configuration change.")] string? note = null,
        [Description("Set to true to skip confirmation (for programmatic/autonomous callers).")] bool confirmed = false)
    {
        if (!confirmed)
        {
            if (context.Params?.InputResponses?.TryGetValue("confirm", out var response) is true)
            {
                var elicit = response.Deserialize(InputResponse.ElicitResultJsonTypeInfo);
                if (elicit?.IsAccepted is not true)
                    return "Location configuration update cancelled.";
            }
            else if (server.IsMrtrSupported)
            {
                throw new InputRequiredException(
                    inputRequests: new Dictionary<string, InputRequest>
                    {
                        ["confirm"] = InputRequest.ForElicitation(new ElicitRequestParams
                        {
                            Message = $"Update Location #{locationId}: capacity={capacityUnits}, hours={dailyOperatingHours}, speed={speedFactor}x, shift start={shiftStartHour}:00. This changes production capacity. Proceed?",
                            RequestedSchema = new()
                            {
                                Properties =
                                {
                                    ["confirm"] = new ElicitRequestParams.StringSchema
                                    {
                                        Title = "Confirm location configuration change",
                                    },
                                },
                            },
                        })
                    },
                    requestState: $"{locationId}");
            }
            else
            {
                return "This is a destructive operation. Resend with confirmed=true to proceed.";
            }
        }

        return await _manufacturing.UpdateLocationConfigAsync(locationId, capacityUnits, dailyOperatingHours, speedFactor, shiftStartHour, note);
    }

    // ── Planning ─────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Check whether a specific finished good can be manufactured given current component stock. Returns the maximum producible quantity and any bottleneck components. Optionally includes in-flight supply orders (withProcurement=true).")]
    public async Task<string> GetProductionFeasibility(
        [Description("ProductID of the finished good to check. Must be a manufactured finished good.")] int productId,
        [Description("Number of units you want to produce.")] int qty = 1,
        [Description("If true, factors in pending supply orders when calculating feasibility. Defaults to true.")] bool withProcurement = true)
    {
        return await _manufacturing.GetFeasibilityAsync(productId, qty, withProcurement);
    }

    [McpServerTool]
    [Description("Get a feasibility snapshot for ALL manufactured finished goods showing the maximum producible quantity of each, inventory signal (overstock/low-stock/out-of-stock/healthy), pricing signal, and weeks of supply. Great for prioritising which products to manufacture next.")]
    public async Task<string> GetAllProductsFeasibility(
        [Description("Desired production quantity to check against. Defaults to 1.")] int qty = 1)
    {
        return await _manufacturing.GetFeasibilityAllAsync(qty);
    }

    [McpServerTool]
    [Description("Get a full bill-of-materials (BOM) cost breakdown for a manufactured product including routing labour costs and gross margin vs list price. Set useCurrent=true to use the latest component costs recorded by the supply chain simulation rather than standard costs.")]
    public async Task<string> GetProductCostAnalysis(
        [Description("ProductID of the manufactured finished good.")] int productId,
        [Description("If true, uses the most recent actual costs from supply chain purchase history. If false, uses standard costs from the database. Defaults to false.")] bool useCurrent = false)
    {
        return await _manufacturing.GetCostAnalysisAsync(productId, useCurrent);
    }

    [McpServerTool]
    [Description("Get a full catalog snapshot of all manufactured finished goods with stock levels, sales velocity, weeks of supply, and derived signals. Optional filters: inventorySignal ('overstock', 'low-stock', 'out-of-stock', 'healthy') or pricingSignal ('thin-margin', 'loss-making', 'healthy').")]
    public async Task<string> GetManufacturingCatalogSnapshot(
        [Description("Optional inventory signal filter: 'overstock', 'low-stock', 'out-of-stock', or 'healthy'.")] string? inventorySignal = null,
        [Description("Optional pricing signal filter: 'thin-margin', 'loss-making', or 'healthy'.")] string? pricingSignal = null)
    {
        return await _manufacturing.GetCatalogSnapshotAsync(inventorySignal, pricingSignal);
    }

    [McpServerTool]
    [Description("Find finished goods that have excess inventory relative to recent sales velocity (candidates for promotions or discounts in the eShop). Default threshold is 12 weeks of supply.")]
    public async Task<string> GetOverstockItems(
        [Description("Minimum weeks of supply to qualify as overstock. Defaults to 12.")] double minWeeks = 12.0)
    {
        return await _manufacturing.GetOverstockItemsAsync(minWeeks);
    }

    [McpServerTool]
    [Description("Find finished goods whose gross margin is below a given threshold — candidates for a list price increase. Default threshold is 20% margin.")]
    public async Task<string> GetThinMarginProducts(
        [Description("Maximum gross margin percentage to qualify as thin-margin (0.0 to 1.0). Defaults to 0.20 (20%).")] double maxMarginPct = 0.20)
    {
        return await _manufacturing.GetThinMarginItemsAsync(maxMarginPct);
    }

    [McpServerTool]
    [Description("Forecast which purchased components will run out of stock within the next N days based on current manufacturing activity and sales velocity. Returns items sorted by urgency (critical/warning/watch).")]
    public async Task<string> GetComponentShortageForecast(
        [Description("Number of days to forecast. Defaults to 90.")] int days = 90)
    {
        return await _manufacturing.GetShortageForecastAsync(days);
    }

    [McpServerTool]
    [Description("Get reorder recommendations for components forecast to run out within the next N days. Returns suggested order quantities, the best vendor option (cheapest that can fulfil), and alternative vendor pricing. Use this to drive supply chain purchasing decisions.")]
    public async Task<string> GetReorderRecommendations(
        [Description("Number of days to look ahead for shortage forecasting. Defaults to 60.")] int days = 60)
    {
        return await _manufacturing.GetReorderRecommendationsAsync(days);
    }

    [McpServerTool]
    [Description(
        "Propose starting a manufacturing run for a product, pending human approval. " +
        "Use this instead of BeginManufacturingRun when the agent mode is ProposePending. " +
        "The proposal is saved and must be approved in the Manufacturing Agent Control page before production begins. " +
        "Provide a clear rationale explaining why this run is recommended based on inventory levels.")]
    public async Task<string> ProposeManufacturingRun(
        [Description("ProductID of the finished good to manufacture. Must have MakeFlag=true.")] int productId,
        [Description("Number of units to produce.")] int qty,
        [Description("Rationale for the proposal — why is this production run recommended? Include inventory levels and demand context.")]
        string rationale,
        [Description("The SalesOrderID that triggered this analysis.")] int salesOrderId,
        [Description("The agent RunID for this invocation (from the invocation payload).")] string runId)
    {
        return await _manufacturing.ProposeManufacturingRunAsync(
            productId, qty, rationale, salesOrderId, runId);
    }
}
