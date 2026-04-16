using System.ComponentModel;
using AdventureWorks.Services;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
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
    private readonly TelemetryClient _telemetryClient;

    public ManufacturingMcpTools(ManufacturingService manufacturing, TelemetryClient telemetryClient)
    {
        _manufacturing = manufacturing;
        _telemetryClient = telemetryClient;
    }

    // ── Simulation Control ───────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get the current live status of the manufacturing simulation: whether it is running, queue depth, work order counts (pending/in-progress/completed today), material shortages, recent scrap events, and load per production location.")]
    public async Task<string> GetManufacturingStatus()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetManufacturingStatus");
        try
        {
            var result = await _manufacturing.GetManufacturingStatusAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "GetManufacturingStatus" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetManufacturingStatus" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("List all manufacturing routing operations that are currently in progress, including elapsed time, product name, location, and operation sequence number. Use this to see what the shop floor is actively working on.")]
    public async Task<string> GetActiveManufacturingOperations()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetActiveManufacturingOperations");
        try
        {
            var result = await _manufacturing.GetActiveOperationsAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "GetActiveManufacturingOperations" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetActiveManufacturingOperations" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Start a new manufacturing production run for a finished good. Explodes the bill of materials, creates work orders for all components, and queues routing operations. The productId must be a finished good with MakeFlag=true. Use GetProductionFeasibility first to verify sufficient component stock.")]
    public async Task<string> BeginManufacturingRun(
        [Description("ProductID of the finished good to manufacture. Must have MakeFlag=true.")] int productId,
        [Description("Number of units to produce.")] int orderQty,
        [Description("Optional due date in ISO 8601 format (e.g. 2026-04-30). Defaults to 7 days from now.")] string? dueDate = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_BeginManufacturingRun");
        operation.Telemetry.Properties["productId"] = productId.ToString();
        operation.Telemetry.Properties["orderQty"] = orderQty.ToString();
        try
        {
            DateTime? due = null;
            if (!string.IsNullOrEmpty(dueDate) && DateTime.TryParse(dueDate, out var d))
                due = d;

            var result = await _manufacturing.BeginManufacturingRunAsync(productId, orderQty, due);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "BeginManufacturingRun" },
                { "productId", productId.ToString() },
                { "orderQty", orderQty.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "BeginManufacturingRun" }, { "productId", productId.ToString() } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Stop the manufacturing simulation by clearing the production queue. In-flight operations will finish but no new ones will be started. Use this when you need to pause manufacturing, for example to reconfigure scrap rates or location capacity before restarting.")]
    public async Task<string> StopManufacturing()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_StopManufacturing");
        try
        {
            var result = await _manufacturing.StopManufacturingAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "StopManufacturing" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "StopManufacturing" } });
            throw;
        }
    }

    // ── Workforce ────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get a headcount summary of the manufacturing workforce grouped by production location and shift. Shows total workers and how many are currently active.")]
    public async Task<string> GetManufacturingWorkforce()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetManufacturingWorkforce");
        try
        {
            var result = await _manufacturing.GetWorkforceAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "GetManufacturingWorkforce" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetManufacturingWorkforce" } });
            throw;
        }
    }

    // ── Quality / Scrap ──────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Retrieve scrap events recorded during manufacturing. Optionally filter by vendorId to investigate scrap attributable to components from a specific supplier. Shows product name, location, scrapped quantity, and scrap reason.")]
    public async Task<string> GetManufacturingScrapEvents(
        [Description("Optional vendor ID to filter scrap events to components supplied by that vendor.")] int? vendorId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetManufacturingScrapEvents");
        try
        {
            var result = await _manufacturing.GetScrapEventsAsync(vendorId);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetManufacturingScrapEvents" },
                { "vendorId", vendorId?.ToString() ?? "all" }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetManufacturingScrapEvents" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get an aggregated quality report per supplier vendor showing total components supplied, number of scrap events, total scrapped quantity, and scrap rate. Optionally scope to a single vendor by providing vendorId.")]
    public async Task<string> GetVendorQualityReport(
        [Description("Optional vendor ID to scope the report to a single supplier. Omit to get the full cross-vendor report.")] int? vendorId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetVendorQualityReport");
        try
        {
            var result = await _manufacturing.GetVendorQualityReportAsync(vendorId);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetVendorQualityReport" },
                { "vendorId", vendorId?.ToString() ?? "all" }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetVendorQualityReport" } });
            throw;
        }
    }

    // ── Scrap & Location Configuration ───────────────────────────────────────

    [McpServerTool]
    [Description("Get the current per-location scrap failure rates and applicable scrap reason codes. Use this to understand the current quality configuration of each production station before making adjustments.")]
    public async Task<string> GetScrapConfiguration()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetScrapConfiguration");
        try
        {
            var result = await _manufacturing.GetScrapConfigAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "GetScrapConfiguration" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetScrapConfiguration" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Update the scrap failure rate for a specific production location. Used to simulate quality improvements or degradation. failureRatePct must be between 0.0 (no failures) and 1.0 (100% failure). Optionally provide scrapReasonIds (array of ints) to restrict which scrap reasons apply.")]
    public async Task<string> UpdateScrapConfiguration(
        [Description("The LocationID of the production station to update.")] int locationId,
        [Description("Failure rate as a decimal between 0.0 and 1.0 (e.g. 0.05 = 5% scrap rate).")] double failureRatePct,
        [Description("Optional comma-separated list of scrap reason IDs to apply at this location (e.g. '2,7,14').")] string? scrapReasonIds = null,
        [Description("Optional note describing why this configuration was changed.")] string? note = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_UpdateScrapConfiguration");
        operation.Telemetry.Properties["locationId"] = locationId.ToString();
        try
        {
            int[]? reasonIds = null;
            if (!string.IsNullOrWhiteSpace(scrapReasonIds))
            {
                reasonIds = scrapReasonIds
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(s => int.TryParse(s, out int id) ? id : -1)
                    .Where(id => id > 0)
                    .ToArray();
            }

            var result = await _manufacturing.UpdateScrapConfigAsync(locationId, failureRatePct, reasonIds, note);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "UpdateScrapConfiguration" },
                { "locationId", locationId.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "UpdateScrapConfiguration" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get the capacity and shift configuration for all production locations, including capacity units, daily operating hours, speed factor, and shift start hour.")]
    public async Task<string> GetLocationConfiguration()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetLocationConfiguration");
        try
        {
            var result = await _manufacturing.GetLocationConfigAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", "GetLocationConfiguration" } });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetLocationConfiguration" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Update the capacity and shift settings for a specific production location. Use to simulate overtime, shift changes, or capacity expansions. speedFactor > 1.0 means faster than normal, < 1.0 means slower.")]
    public async Task<string> UpdateLocationConfiguration(
        [Description("The LocationID of the production station to update.")] int locationId,
        [Description("Number of parallel work units the station can handle (minimum 1).")] int capacityUnits,
        [Description("Hours per day the station operates (e.g. 8.0, 12.0, 16.0). Defaults to 8.")] double dailyOperatingHours = 8.0,
        [Description("Processing speed multiplier relative to standard routing time (e.g. 1.5 = 50% faster). Defaults to 1.0.")] double speedFactor = 1.0,
        [Description("Hour of day (0-23) when the shift starts. Defaults to 6.")] int shiftStartHour = 6,
        [Description("Optional note describing the reason for this configuration change.")] string? note = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_UpdateLocationConfiguration");
        operation.Telemetry.Properties["locationId"] = locationId.ToString();
        try
        {
            var result = await _manufacturing.UpdateLocationConfigAsync(locationId, capacityUnits, dailyOperatingHours, speedFactor, shiftStartHour, note);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "UpdateLocationConfiguration" },
                { "locationId", locationId.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "UpdateLocationConfiguration" } });
            throw;
        }
    }

    // ── Planning ─────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Check whether a specific finished good can be manufactured given current component stock. Returns the maximum producible quantity and any bottleneck components. Optionally includes in-flight supply orders (withProcurement=true).")]
    public async Task<string> GetProductionFeasibility(
        [Description("ProductID of the finished good to check. Must be a manufactured finished good.")] int productId,
        [Description("Number of units you want to produce.")] int qty = 1,
        [Description("If true, factors in pending supply orders when calculating feasibility. Defaults to true.")] bool withProcurement = true)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetProductionFeasibility");
        operation.Telemetry.Properties["productId"] = productId.ToString();
        try
        {
            var result = await _manufacturing.GetFeasibilityAsync(productId, qty, withProcurement);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetProductionFeasibility" },
                { "productId", productId.ToString() },
                { "qty", qty.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetProductionFeasibility" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get a feasibility snapshot for ALL manufactured finished goods showing the maximum producible quantity of each, inventory signal (overstock/low-stock/out-of-stock/healthy), pricing signal, and weeks of supply. Great for prioritising which products to manufacture next.")]
    public async Task<string> GetAllProductsFeasibility(
        [Description("Desired production quantity to check against. Defaults to 1.")] int qty = 1)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetAllProductsFeasibility");
        try
        {
            var result = await _manufacturing.GetFeasibilityAllAsync(qty);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetAllProductsFeasibility" },
                { "qty", qty.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetAllProductsFeasibility" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get a full bill-of-materials (BOM) cost breakdown for a manufactured product including routing labour costs and gross margin vs list price. Set useCurrent=true to use the latest component costs recorded by the supply chain simulation rather than standard costs.")]
    public async Task<string> GetProductCostAnalysis(
        [Description("ProductID of the manufactured finished good.")] int productId,
        [Description("If true, uses the most recent actual costs from supply chain purchase history. If false, uses standard costs from the database. Defaults to false.")] bool useCurrent = false)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetProductCostAnalysis");
        operation.Telemetry.Properties["productId"] = productId.ToString();
        try
        {
            var result = await _manufacturing.GetCostAnalysisAsync(productId, useCurrent);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetProductCostAnalysis" },
                { "productId", productId.ToString() },
                { "useCurrent", useCurrent.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetProductCostAnalysis" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get a full catalog snapshot of all manufactured finished goods with stock levels, sales velocity, weeks of supply, and derived signals. Optional filters: inventorySignal ('overstock', 'low-stock', 'out-of-stock', 'healthy') or pricingSignal ('thin-margin', 'loss-making', 'healthy').")]
    public async Task<string> GetManufacturingCatalogSnapshot(
        [Description("Optional inventory signal filter: 'overstock', 'low-stock', 'out-of-stock', or 'healthy'.")] string? inventorySignal = null,
        [Description("Optional pricing signal filter: 'thin-margin', 'loss-making', or 'healthy'.")] string? pricingSignal = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetManufacturingCatalogSnapshot");
        try
        {
            var result = await _manufacturing.GetCatalogSnapshotAsync(inventorySignal, pricingSignal);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetManufacturingCatalogSnapshot" },
                { "inventorySignal", inventorySignal ?? "all" },
                { "pricingSignal", pricingSignal ?? "all" }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetManufacturingCatalogSnapshot" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Find finished goods that have excess inventory relative to recent sales velocity (candidates for promotions or discounts in the eShop). Default threshold is 12 weeks of supply.")]
    public async Task<string> GetOverstockItems(
        [Description("Minimum weeks of supply to qualify as overstock. Defaults to 12.")] double minWeeks = 12.0)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetOverstockItems");
        try
        {
            var result = await _manufacturing.GetOverstockItemsAsync(minWeeks);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetOverstockItems" },
                { "minWeeks", minWeeks.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetOverstockItems" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Find finished goods whose gross margin is below a given threshold — candidates for a list price increase. Default threshold is 20% margin.")]
    public async Task<string> GetThinMarginProducts(
        [Description("Maximum gross margin percentage to qualify as thin-margin (0.0 to 1.0). Defaults to 0.20 (20%).")] double maxMarginPct = 0.20)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetThinMarginProducts");
        try
        {
            var result = await _manufacturing.GetThinMarginItemsAsync(maxMarginPct);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetThinMarginProducts" },
                { "maxMarginPct", maxMarginPct.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetThinMarginProducts" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Forecast which purchased components will run out of stock within the next N days based on current manufacturing activity and sales velocity. Returns items sorted by urgency (critical/warning/watch).")]
    public async Task<string> GetComponentShortageForecast(
        [Description("Number of days to forecast. Defaults to 90.")] int days = 90)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetComponentShortageForecast");
        try
        {
            var result = await _manufacturing.GetShortageForecastAsync(days);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetComponentShortageForecast" },
                { "days", days.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetComponentShortageForecast" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get reorder recommendations for components forecast to run out within the next N days. Returns suggested order quantities, the best vendor option (cheapest that can fulfil), and alternative vendor pricing. Use this to drive supply chain purchasing decisions.")]
    public async Task<string> GetReorderRecommendations(
        [Description("Number of days to look ahead for shortage forecasting. Defaults to 60.")] int days = 60)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetReorderRecommendations");
        try
        {
            var result = await _manufacturing.GetReorderRecommendationsAsync(days);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetReorderRecommendations" },
                { "days", days.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetReorderRecommendations" } });
            throw;
        }
    }
}
