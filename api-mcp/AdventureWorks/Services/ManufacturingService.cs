using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AdventureWorks.Services;

/// <summary>
/// Calls the api-functions manufacturing and planning endpoints on behalf of MCP tools.
/// Base URL is read from the API_FUNCTIONS_URL environment variable / configuration.
/// </summary>
public class ManufacturingService
{
    private readonly HttpClient _http;
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public ManufacturingService(HttpClient http) => _http = http;

    // ── Manufacturing Status ─────────────────────────────────────────────────

    public async Task<string> GetManufacturingStatusAsync()
    {
        var resp = await _http.GetAsync("api/manufacturing/status");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving manufacturing status: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Manufacturing Simulation Status");
        sb.AppendLine();
        sb.AppendLine($"Running: {root.GetBoolOrDefault("isRunning")}");
        sb.AppendLine($"Queue Depth: {root.GetIntOrDefault("queueDepth")}");
        sb.AppendLine($"Pending Work Orders: {root.GetIntOrDefault("pendingWorkOrders")}");
        sb.AppendLine($"In-Progress Work Orders: {root.GetIntOrDefault("inProgressWorkOrders")}");
        sb.AppendLine($"Completed Today: {root.GetIntOrDefault("completedToday")}");
        sb.AppendLine($"Stalled for Materials: {root.GetIntOrDefault("stalledForMaterials")}");

        if (root.TryGetProperty("shortages", out var shortages) && shortages.ValueKind == JsonValueKind.Array)
        {
            var shortageCount = shortages.GetArrayLength();
            if (shortageCount > 0)
            {
                sb.AppendLine();
                sb.AppendLine($"### Material Shortages ({shortageCount})");
                foreach (var s in shortages.EnumerateArray().Take(10))
                    sb.AppendLine($"  - WO {s.GetStringOrDefault("workOrderId")}: {s.GetStringOrDefault("productName")} — needs {s.GetStringOrDefault("componentName")} x{s.GetIntOrDefault("required")}, available: {s.GetIntOrDefault("available")}");
            }
        }

        if (root.TryGetProperty("recentScrapEvents", out var scrap) && scrap.ValueKind == JsonValueKind.Array)
        {
            var scrapCount = scrap.GetArrayLength();
            if (scrapCount > 0)
            {
                sb.AppendLine();
                sb.AppendLine($"### Recent Scrap Events ({scrapCount})");
                foreach (var e in scrap.EnumerateArray().Take(5))
                    sb.AppendLine($"  - Location {e.GetIntOrDefault("locationId")}: {e.GetStringOrDefault("productName")} x{e.GetIntOrDefault("scrappedQty")} — {e.GetStringOrDefault("scrapReason")}");
            }
        }

        if (root.TryGetProperty("locationLoad", out var locations) && locations.ValueKind == JsonValueKind.Array)
        {
            sb.AppendLine();
            sb.AppendLine("### Location Load");
            foreach (var loc in locations.EnumerateArray())
                sb.AppendLine($"  - {loc.GetStringOrDefault("locationName")} (ID {loc.GetIntOrDefault("locationId")}): {loc.GetIntOrDefault("activeOperations")} active ops, capacity {loc.GetIntOrDefault("capacityUnits")}");
        }

        return sb.ToString();
    }

    public async Task<string> GetActiveOperationsAsync()
    {
        var resp = await _http.GetAsync("api/manufacturing/active");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving active operations: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Active Manufacturing Operations");
        sb.AppendLine();

        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind != JsonValueKind.Array || arr.GetArrayLength() == 0)
        {
            sb.AppendLine("No operations currently in progress.");
            return sb.ToString();
        }

        sb.AppendLine($"Total active: {arr.GetArrayLength()}");
        sb.AppendLine();
        foreach (var op in arr.EnumerateArray().Take(20))
        {
            sb.AppendLine($"- WO {op.GetIntOrDefault("workOrderId")} | {op.GetStringOrDefault("productName")} | Op {op.GetIntOrDefault("operationSequence")} — {op.GetStringOrDefault("operationName")}");
            sb.AppendLine($"  Location: {op.GetStringOrDefault("locationName")}, Elapsed: {op.GetStringOrDefault("elapsedDisplay")}, Qty: {op.GetIntOrDefault("qty")}");
        }

        return sb.ToString();
    }

    public async Task<string> BeginManufacturingRunAsync(int productId, int orderQty, DateTime? dueDate = null)
    {
        var body = new { productId, orderQty, dueDate };
        var resp = await _http.PostAsJsonAsync("api/manufacturing/begin", body, _json);
        var json = await resp.Content.ReadAsStringAsync();

        if (!resp.IsSuccessStatusCode)
        {
            using var errDoc = JsonDocument.Parse(json);
            var errMsg = errDoc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : json;
            return $"Failed to begin manufacturing run: {errMsg}";
        }

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var sb = new StringBuilder();
        sb.AppendLine("## Manufacturing Run Started");
        sb.AppendLine($"Run ID: {root.GetStringOrDefault("runId")}");
        sb.AppendLine($"Root Work Order ID: {root.GetIntOrDefault("rootWorkOrderId")}");
        sb.AppendLine($"Total Work Orders Created: {root.GetIntOrDefault("workOrdersCreated")}");
        sb.AppendLine($"Leaf Work Orders Queued: {root.GetIntOrDefault("leafWorkOrdersQueued")}");

        if (root.TryGetProperty("inventoryWarnings", out var warnings) && warnings.ValueKind == JsonValueKind.Array && warnings.GetArrayLength() > 0)
        {
            sb.AppendLine();
            sb.AppendLine("### Inventory Warnings");
            foreach (var w in warnings.EnumerateArray())
                sb.AppendLine($"  - {w.GetStringOrDefault("componentName")}: need {w.GetIntOrDefault("required")}, have {w.GetIntOrDefault("available")}");
        }

        return sb.ToString();
    }

    public async Task<string> StopManufacturingAsync()
    {
        var resp = await _http.PostAsync("api/manufacturing/stop", null);
        if (!resp.IsSuccessStatusCode)
            return $"Error stopping manufacturing: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetStringOrDefault("message") ?? "Manufacturing stopped.";
    }

    // ── Workforce ────────────────────────────────────────────────────────────

    public async Task<string> GetWorkforceAsync()
    {
        var resp = await _http.GetAsync("api/manufacturing/workforce");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving workforce data: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Manufacturing Workforce Summary");
        sb.AppendLine();

        if (root.TryGetProperty("totalWorkers", out var total))
            sb.AppendLine($"Total Workers: {total.GetInt32()}");
        if (root.TryGetProperty("activeWorkers", out var active))
            sb.AppendLine($"Active (On Shift): {active.GetInt32()}");

        if (root.TryGetProperty("byLocation", out var byLocation) && byLocation.ValueKind == JsonValueKind.Array)
        {
            sb.AppendLine();
            sb.AppendLine("### By Location");
            foreach (var loc in byLocation.EnumerateArray())
            {
                sb.AppendLine($"  - {loc.GetStringOrDefault("locationName")} (ID {loc.GetIntOrDefault("locationId")}): {loc.GetIntOrDefault("headcount")} workers");
            }
        }

        return sb.ToString();
    }

    // ── Scrap & Vendor Quality ───────────────────────────────────────────────

    public async Task<string> GetScrapEventsAsync(int? vendorId = null)
    {
        var url = vendorId.HasValue
            ? $"api/manufacturing/scrap-events?vendorId={vendorId.Value}"
            : "api/manufacturing/scrap-events";

        var resp = await _http.GetAsync(url);
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving scrap events: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind != JsonValueKind.Array)
            return "Unexpected response format for scrap events.";

        var sb = new StringBuilder();
        sb.AppendLine("## Scrap Events");
        sb.AppendLine($"Total events: {arr.GetArrayLength()}");
        sb.AppendLine();

        foreach (var e in arr.EnumerateArray().Take(25))
        {
            sb.AppendLine($"- {e.GetStringOrDefault("timestamp")} | {e.GetStringOrDefault("productName")} x{e.GetIntOrDefault("scrappedQty")}");
            sb.AppendLine($"  Location: {e.GetStringOrDefault("locationName")}, Reason: {e.GetStringOrDefault("scrapReason")}");
            var vendor = e.GetStringOrDefault("vendorName");
            if (!string.IsNullOrEmpty(vendor))
                sb.AppendLine($"  Vendor: {vendor} (ID {e.GetIntOrDefault("vendorId")})");
        }

        return sb.ToString();
    }

    public async Task<string> GetVendorQualityReportAsync(int? vendorId = null)
    {
        var url = vendorId.HasValue
            ? $"api/manufacturing/vendor-quality/{vendorId.Value}"
            : "api/manufacturing/vendor-quality";

        var resp = await _http.GetAsync(url);
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving vendor quality report: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind != JsonValueKind.Array)
            return "Unexpected response format for vendor quality report.";

        var sb = new StringBuilder();
        sb.AppendLine("## Vendor Quality Report");
        sb.AppendLine();

        foreach (var v in arr.EnumerateArray())
        {
            sb.AppendLine($"### {v.GetStringOrDefault("vendorName")} (ID {v.GetIntOrDefault("vendorId")})");
            sb.AppendLine($"  Total components supplied: {v.GetIntOrDefault("totalComponentsSupplied")}");
            sb.AppendLine($"  Scrap events: {v.GetIntOrDefault("scrapEventCount")}");
            sb.AppendLine($"  Scrapped qty: {v.GetIntOrDefault("totalScrappedQty")}");
            sb.AppendLine($"  Scrap rate: {v.GetDoubleOrDefault("scrapRatePct"):P1}");
            sb.AppendLine();
        }

        return sb.ToString();
    }

    // ── Scrap / Location Configuration ───────────────────────────────────────

    public async Task<string> GetScrapConfigAsync()
    {
        var resp = await _http.GetAsync("api/manufacturing/scrap-config");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving scrap config: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Manufacturing Scrap Configuration (per location)");
        sb.AppendLine();

        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in arr.EnumerateArray())
            {
                sb.AppendLine($"- Location {c.GetIntOrDefault("locationId")}: failure rate {c.GetDoubleOrDefault("failureRatePct"):P1}");
                var note = c.GetStringOrDefault("note");
                if (!string.IsNullOrEmpty(note)) sb.AppendLine($"  Note: {note}");
            }
        }

        return sb.ToString();
    }

    public async Task<string> UpdateScrapConfigAsync(int locationId, double failureRatePct, int[]? scrapReasonIds = null, string? note = null)
    {
        var body = new { failureRatePct, scrapReasonIds = scrapReasonIds ?? Array.Empty<int>(), note };
        var resp = await _http.PutAsJsonAsync($"api/manufacturing/scrap-config/{locationId}", body, _json);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync();
            return $"Error updating scrap config for location {locationId}: {err}";
        }
        return $"Scrap configuration updated for location {locationId}. Failure rate: {failureRatePct:P1}.";
    }

    public async Task<string> GetLocationConfigAsync()
    {
        var resp = await _http.GetAsync("api/manufacturing/location-config");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving location config: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Manufacturing Location Configuration");
        sb.AppendLine();

        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in arr.EnumerateArray())
            {
                sb.AppendLine($"- Location {c.GetIntOrDefault("locationId")}: capacity {c.GetIntOrDefault("capacityUnits")} units, {c.GetDoubleOrDefault("dailyOperatingHours")}h/day, speed x{c.GetDoubleOrDefault("speedFactor"):F2}");
            }
        }

        return sb.ToString();
    }

    public async Task<string> UpdateLocationConfigAsync(int locationId, int capacityUnits, double dailyOperatingHours = 8.0, double speedFactor = 1.0, int shiftStartHour = 6, string? note = null)
    {
        var body = new { capacityUnits, dailyOperatingHours, speedFactor, shiftStartHour, note };
        var resp = await _http.PutAsJsonAsync($"api/manufacturing/location-config/{locationId}", body, _json);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync();
            return $"Error updating location config for location {locationId}: {err}";
        }
        return $"Location {locationId} configuration updated: {capacityUnits} capacity units, {dailyOperatingHours}h/day, speed factor {speedFactor:F2}.";
    }

    // ── Planning ─────────────────────────────────────────────────────────────

    public async Task<string> GetFeasibilityAsync(int productId, int qty = 1, bool withProcurement = true)
    {
        var resp = await _http.GetAsync($"api/plan/feasibility/{productId}?qty={qty}&withProcurement={withProcurement}");
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
            return $"ProductID {productId} not found or is not a manufactured finished good.";
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving feasibility for ProductID {productId}: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine($"## Feasibility for ProductID {productId}");
        sb.AppendLine($"Product: {root.GetStringOrDefault("productName")}");
        sb.AppendLine($"Requested Qty: {qty}");
        sb.AppendLine($"Max Producible Now: {root.GetIntOrDefault("maxProducibleNow")}");
        sb.AppendLine($"Can Meet Request: {root.GetBoolOrDefault("canMeetRequest")}");

        if (root.TryGetProperty("bottleneckComponents", out var bottlenecks) && bottlenecks.ValueKind == JsonValueKind.Array && bottlenecks.GetArrayLength() > 0)
        {
            sb.AppendLine();
            sb.AppendLine("### Bottleneck Components");
            foreach (var b in bottlenecks.EnumerateArray().Take(10))
                sb.AppendLine($"  - {b.GetStringOrDefault("name")}: need {b.GetIntOrDefault("required")}, available {b.GetIntOrDefault("available")} (can make {b.GetIntOrDefault("maxFromStock")})");
        }

        if (root.TryGetProperty("pendingProcurementHelp", out var pending) && pending.ValueKind == JsonValueKind.Array && pending.GetArrayLength() > 0)
        {
            sb.AppendLine();
            sb.AppendLine("### Incoming Supply Orders (will help)");
            foreach (var p in pending.EnumerateArray().Take(5))
                sb.AppendLine($"  - {p.GetStringOrDefault("productName")} x{p.GetIntOrDefault("qty")} — {p.GetStringOrDefault("status")}");
        }

        return sb.ToString();
    }

    public async Task<string> GetFeasibilityAllAsync(int qty = 1)
    {
        var resp = await _http.GetAsync($"api/plan/feasibility?qty={qty}");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving feasibility snapshot: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind != JsonValueKind.Array)
            return "Unexpected response format.";

        var sb = new StringBuilder();
        sb.AppendLine("## Manufacturing Feasibility Snapshot (all finished goods)");
        sb.AppendLine($"Requested quantity: {qty}");
        sb.AppendLine();

        var canMeet = 0;
        var cannotMeet = 0;
        foreach (var p in arr.EnumerateArray())
        {
            var meets = p.GetBoolOrDefault("canMeetRequest");
            if (meets) canMeet++; else cannotMeet++;
        }
        sb.AppendLine($"Can meet requested qty ({qty}): {canMeet} products");
        sb.AppendLine($"Cannot meet requested qty: {cannotMeet} products");
        sb.AppendLine();
        sb.AppendLine("| Product | Max Producible | Inventory Signal | Pricing Signal | Weeks of Supply |");
        sb.AppendLine("|---------|---------------|-----------------|----------------|-----------------|");
        foreach (var p in arr.EnumerateArray())
        {
            sb.AppendLine($"| {p.GetStringOrDefault("name")} (ID {p.GetIntOrDefault("productId")}) | {p.GetIntOrDefault("maxProducibleNow")} | {p.GetStringOrDefault("inventorySignal")} | {p.GetStringOrDefault("pricingSignal")} | {p.GetDoubleOrDefault("weeksOfSupply"):F1} |");
        }

        return sb.ToString();
    }

    public async Task<string> GetCostAnalysisAsync(int productId, bool useCurrent = false)
    {
        var route = useCurrent
            ? $"api/plan/cost/{productId}/current"
            : $"api/plan/cost/{productId}";

        var resp = await _http.GetAsync(route);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
            return $"ProductID {productId} not found or is not a manufactured finished good.";
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving cost analysis for ProductID {productId}: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine($"## Cost Analysis for ProductID {productId}");
        sb.AppendLine($"Product: {root.GetStringOrDefault("productName")} ({root.GetStringOrDefault("productNumber")})");
        sb.AppendLine($"List Price: ${root.GetDecimalOrDefault("listPrice"):N2}");
        sb.AppendLine($"Total Standard Cost: ${root.GetDecimalOrDefault("totalStandardCost"):N2}");
        sb.AppendLine($"Gross Margin: ${root.GetDecimalOrDefault("grossMargin"):N2} ({root.GetDoubleOrDefault("grossMarginPct"):P1})");

        if (root.TryGetProperty("bomCostBreakdown", out var bom) && bom.ValueKind == JsonValueKind.Array)
        {
            sb.AppendLine();
            sb.AppendLine("### BOM Cost Breakdown");
            foreach (var c in bom.EnumerateArray().Take(15))
                sb.AppendLine($"  - {c.GetStringOrDefault("componentName")}: ${c.GetDecimalOrDefault("unitCost"):N4} x {c.GetDoubleOrDefault("qty"):F2} = ${c.GetDecimalOrDefault("totalCost"):N2}");
        }

        return sb.ToString();
    }

    public async Task<string> GetCatalogSnapshotAsync(string? inventorySignal = null, string? pricingSignal = null)
    {
        var qs = new List<string>();
        if (!string.IsNullOrEmpty(inventorySignal)) qs.Add($"inventorySignal={Uri.EscapeDataString(inventorySignal)}");
        if (!string.IsNullOrEmpty(pricingSignal)) qs.Add($"pricingSignal={Uri.EscapeDataString(pricingSignal)}");
        var url = "api/plan/catalog" + (qs.Any() ? "?" + string.Join("&", qs) : "");

        var resp = await _http.GetAsync(url);
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving catalog snapshot: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var arr = root.ValueKind == JsonValueKind.Array ? root : default;
        if (arr.ValueKind != JsonValueKind.Array)
            return "Unexpected response format.";

        var sb = new StringBuilder();
        sb.AppendLine("## Manufacturing Catalog Snapshot");
        if (!string.IsNullOrEmpty(inventorySignal)) sb.AppendLine($"Filter: inventorySignal={inventorySignal}");
        if (!string.IsNullOrEmpty(pricingSignal)) sb.AppendLine($"Filter: pricingSignal={pricingSignal}");
        sb.AppendLine($"Total products: {arr.GetArrayLength()}");
        sb.AppendLine();
        sb.AppendLine("| Product | List Price | Stock | Weeks of Supply | Inv. Signal | Pricing Signal |");
        sb.AppendLine("|---------|-----------|-------|-----------------|-------------|----------------|");

        foreach (var p in arr.EnumerateArray())
        {
            sb.AppendLine($"| {p.GetStringOrDefault("name")} (ID {p.GetIntOrDefault("productId")}) | ${p.GetDecimalOrDefault("listPrice"):N2} | {p.GetIntOrDefault("currentStockQty")} | {p.GetDoubleOrDefault("weeksOfSupply"):F1} | {p.GetStringOrDefault("inventorySignal")} | {p.GetStringOrDefault("pricingSignal")} |");
        }

        return sb.ToString();
    }

    public async Task<string> GetOverstockItemsAsync(double minWeeks = 12.0)
    {
        var resp = await _http.GetAsync($"api/plan/overstock?minWeeks={minWeeks}");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving overstock items: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Overstock Items");
        sb.AppendLine($"Threshold: {minWeeks} weeks of supply");
        sb.AppendLine(root.GetStringOrDefault("signal") ?? "");
        sb.AppendLine($"Count: {root.GetIntOrDefault("count")}");
        sb.AppendLine();

        if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var p in items.EnumerateArray())
                sb.AppendLine($"  - {p.GetStringOrDefault("name")} (ID {p.GetIntOrDefault("productId")}): {p.GetIntOrDefault("currentStockQty")} in stock, {p.GetDoubleOrDefault("weeksOfSupply"):F1} weeks, {p.GetIntOrDefault("salesLast30Days")} sold last 30 days");
        }

        return sb.ToString();
    }

    public async Task<string> GetThinMarginItemsAsync(double maxMarginPct = 0.20)
    {
        var resp = await _http.GetAsync($"api/plan/thin-margin?maxMarginPct={maxMarginPct}");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving thin-margin items: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Thin-Margin Items");
        sb.AppendLine($"Threshold: {maxMarginPct:P0} margin");
        sb.AppendLine(root.GetStringOrDefault("signal") ?? "");
        sb.AppendLine($"Count: {root.GetIntOrDefault("count")}");
        sb.AppendLine();

        if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var p in items.EnumerateArray())
                sb.AppendLine($"  - {p.GetStringOrDefault("name")} (ID {p.GetIntOrDefault("productId")}): list ${p.GetDecimalOrDefault("listPrice"):N2}, cost ${p.GetDecimalOrDefault("totalStandardCost"):N2}, margin {p.GetDoubleOrDefault("grossMarginPct"):P1}");
        }

        return sb.ToString();
    }

    public async Task<string> GetShortageForecastAsync(int days = 90)
    {
        var resp = await _http.GetAsync($"api/plan/shortage-forecast?days={days}");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving shortage forecast: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Component Shortage Forecast");
        sb.AppendLine($"Forecast window: {root.GetIntOrDefault("forecastDays")} days");
        sb.AppendLine($"Critical: {root.GetIntOrDefault("critical")} | Warning: {root.GetIntOrDefault("warning")} | Watch: {root.GetIntOrDefault("watch")}");
        sb.AppendLine();

        if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in items.EnumerateArray().Take(20))
            {
                var urgency = c.GetStringOrDefault("urgencyLevel") ?? "?";
                sb.AppendLine($"[{urgency.ToUpperInvariant()}] {c.GetStringOrDefault("componentName")} (ID {c.GetIntOrDefault("productId")})");
                sb.AppendLine($"  Stock: {c.GetIntOrDefault("currentStock")}, Daily usage: {c.GetDoubleOrDefault("dailyUsageRate"):F1}, Days until stockout: {c.GetIntOrDefault("daysUntilStockout")}");
            }
        }

        return sb.ToString();
    }

    public async Task<string> GetReorderRecommendationsAsync(int days = 60)
    {
        var resp = await _http.GetAsync($"api/plan/reorder-recommendations?days={days}");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving reorder recommendations: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Reorder Recommendations");
        sb.AppendLine($"Forecast window: {root.GetIntOrDefault("forecastDays")} days");
        sb.AppendLine($"Recommendations: {root.GetIntOrDefault("totalRecommendations")}");
        sb.AppendLine($"Estimated total procurement cost: ${root.GetDecimalOrDefault("estimatedTotalProcurementCost"):N2}");
        sb.AppendLine();

        if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var r in items.EnumerateArray().Take(20))
            {
                sb.AppendLine($"### {r.GetStringOrDefault("componentName")} (ID {r.GetIntOrDefault("productId")})");
                sb.AppendLine($"  Suggested qty: {r.GetIntOrDefault("suggestedOrderQty")}");
                sb.AppendLine($"  Days until stockout: {r.GetIntOrDefault("daysUntilStockout")}");

                if (r.TryGetProperty("bestVendor", out var best) && best.ValueKind != JsonValueKind.Null)
                {
                    sb.AppendLine($"  Best vendor: {best.GetStringOrDefault("vendorName")} (ID {best.GetStringOrDefault("vendorId")}) — ${best.GetDecimalOrDefault("unitPrice"):N4}/unit, total ${best.GetDecimalOrDefault("totalCost"):N2}");
                }

                if (r.TryGetProperty("alternatives", out var alts) && alts.ValueKind == JsonValueKind.Array)
                {
                    foreach (var a in alts.EnumerateArray().Take(3))
                        sb.AppendLine($"  Alt: {a.GetStringOrDefault("vendorName")} — ${a.GetDecimalOrDefault("unitPrice"):N4}/unit");
                }
                sb.AppendLine();
            }
        }

        return sb.ToString();
    }
}

/// <summary>
/// Extension methods to safely read JSON values without exceptions.
/// </summary>
internal static class JsonElementExtensions
{
    public static string? GetStringOrDefault(this JsonElement el, string property)
    {
        if (el.TryGetProperty(property, out var v))
            return v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString();
        return null;
    }

    public static int GetIntOrDefault(this JsonElement el, string property)
    {
        if (el.TryGetProperty(property, out var v) && v.TryGetInt32(out int i)) return i;
        return 0;
    }

    public static double GetDoubleOrDefault(this JsonElement el, string property)
    {
        if (el.TryGetProperty(property, out var v) && v.TryGetDouble(out double d)) return d;
        return 0.0;
    }

    public static decimal GetDecimalOrDefault(this JsonElement el, string property)
    {
        if (el.TryGetProperty(property, out var v) && v.TryGetDecimal(out decimal d)) return d;
        return 0m;
    }

    public static bool GetBoolOrDefault(this JsonElement el, string property)
    {
        if (el.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.True) return true;
        return false;
    }
}
