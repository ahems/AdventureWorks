using System.Net;
using System.Text.Json;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// Planning and intelligence endpoints for the manufacturing + supply chain simulation.
/// Routes: /api/plan/*
/// </summary>
public class ManufacturingPlanningFunction
{
    private readonly ManufacturingPlanningService _planning;
    private readonly SupplyChainService _supply;
    private readonly ILogger<ManufacturingPlanningFunction> _logger;

    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented        = true,
    };

    public ManufacturingPlanningFunction(
        ManufacturingPlanningService planning,
        SupplyChainService supply,
        ILogger<ManufacturingPlanningFunction> logger)
    {
        _planning = planning;
        _supply   = supply;
        _logger   = logger;
    }

    // ── Feasibility ───────────────────────────────────────────────────────────

    /// <summary>
    /// GET /api/plan/feasibility/{productId}?qty={n}
    /// How many units of this finished good can be built right now?
    /// Optionally factors in in-flight supply orders.
    /// </summary>
    [Function("PlanFeasibility")]
    public async Task<HttpResponseData> GetFeasibility(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "plan/feasibility/{productId:int}")] HttpRequestData req,
        int productId)
    {
        await _supply.InitializeAsync();

        var qs = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        int qty = int.TryParse(qs["qty"], out var q) && q > 0 ? q : 1;
        bool withProcurement = qs["withProcurement"]?.ToLowerInvariant() != "false";

        IReadOnlyList<PurchaseOrder>? pending = null;
        if (withProcurement)
        {
            pending = (await _supply.GetOrdersAsync(includeCompleted: false))
                .Where(o => o.Status is "placed" or "confirmed" or "picking" or "shipped")
                .ToList();
        }

        var result = await _planning.GetFeasibilityAsync(productId, qty, pending);
        if (result == null)
            return await NotFoundAsync(req, $"ProductID {productId} not found or is not a manufactured finished good.");

        return await OkAsync(req, result);
    }

    /// <summary>
    /// GET /api/plan/feasibility?qty={n}
    /// Feasibility snapshot for ALL manufactured finished goods.
    /// Returns how many of each can be built from current stock.
    /// </summary>
    [Function("PlanFeasibilityAll")]
    public async Task<HttpResponseData> GetFeasibilityAll(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "plan/feasibility")] HttpRequestData req)
    {
        await _supply.InitializeAsync();

        var qs = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        int qty = int.TryParse(qs["qty"], out var q) && q > 0 ? q : 1;

        // Get the snapshot (includes maxProducibleNow per product)
        var snapshot = await _planning.GetCatalogSnapshotAsync();

        // Return a lightweight summary suitable for a grid
        var result = snapshot.Select(s => new
        {
            s.ProductId,
            s.Name,
            s.ProductNumber,
            s.ListPrice,
            s.CurrentStockQty,
            s.MaxProducibleNow,
            CanMeetRequest = s.MaxProducibleNow >= qty || s.MaxProducibleNow == -1,
            s.InventorySignal,
            s.PricingSignal,
            s.SalesLast30Days,
            s.WeeksOfSupply,
        }).OrderBy(s => s.Name).ToList();

        return await OkAsync(req, result);
    }

    // ── Cost / pricing analysis ───────────────────────────────────────────────

    /// <summary>
    /// GET /api/plan/cost/{productId}
    /// Full BOM cost breakdown + routing labour + margin vs list price for a single product.
    /// </summary>
    [Function("PlanCostAnalysis")]
    public async Task<HttpResponseData> GetCostAnalysis(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "plan/cost/{productId:int}")] HttpRequestData req,
        int productId)
    {
        var result = await _planning.GetCostAnalysisAsync(productId);
        if (result == null)
            return await NotFoundAsync(req, $"ProductID {productId} not found or is not a manufactured finished good.");
        return await OkAsync(req, result);
    }

    /// <summary>
    /// GET /api/plan/cost/{productId}/current
    /// Accurate current manufacturing cost using latest ProductCostHistory for all BOM components.
    /// This provides real-time costing based on actual vendor purchase costs recorded by the
    /// supply chain simulation, falling back to ProductVendor.LastReceiptCost and Product.StandardCost.
    /// Returns detailed BOM breakdown with cost source attribution for each component.
    /// </summary>
    [Function("PlanCurrentManufacturingCost")]
    public async Task<HttpResponseData> GetCurrentManufacturingCost(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "plan/cost/{productId:int}/current")] HttpRequestData req,
        int productId)
    {
        var result = await _planning.GetCurrentManufacturingCostAsync(productId);
        if (result == null)
            return await NotFoundAsync(req, $"ProductID {productId} not found or is not a manufactured finished good.");
        return await OkAsync(req, result);
    }

    /// <summary>
    /// GET /api/plan/catalog
    /// Full snapshot of every manufactured finished good: cost, margin, stock,
    /// sales velocity, and derived signals (overstock / thin-margin etc.).
    /// Optionally filter: ?signal=overstock|thin-margin|loss-making|low-stock|out-of-stock|healthy
    /// </summary>
    [Function("PlanCatalog")]
    public async Task<HttpResponseData> GetCatalog(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "plan/catalog")] HttpRequestData req)
    {
        var qs     = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        string? invFilter     = qs["inventorySignal"]?.ToLowerInvariant();
        string? pricingFilter = qs["pricingSignal"]?.ToLowerInvariant();

        var all = await _planning.GetCatalogSnapshotAsync();

        IEnumerable<FinishedGoodSnapshot> filtered = all;
        if (!string.IsNullOrEmpty(invFilter))
            filtered = filtered.Where(s => s.InventorySignal == invFilter);
        if (!string.IsNullOrEmpty(pricingFilter))
            filtered = filtered.Where(s => s.PricingSignal == pricingFilter);

        return await OkAsync(req, filtered.OrderBy(s => s.Name).ToList());
    }

    // ── Overstock / sale candidates ───────────────────────────────────────────

    /// <summary>
    /// GET /api/plan/overstock?minWeeks={n}
    /// Products with high finished goods stock relative to recent sales velocity.
    /// These are candidates for putting on sale in the eShop.
    /// Default threshold: 12 weeks of supply.
    /// </summary>
    [Function("PlanOverstock")]
    public async Task<HttpResponseData> GetOverstock(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "plan/overstock")] HttpRequestData req)
    {
        var qs = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        double minWeeks = double.TryParse(qs["minWeeks"], out var w) && w > 0 ? w : 12.0;

        var result = await _planning.GetOverstockItemsAsync(minWeeks);
        return await OkAsync(req, new
        {
            thresholdWeeksOfSupply = minWeeks,
            count  = result.Count,
            signal = "These products have high inventory relative to sales velocity. Consider discounting in the eShop.",
            items  = result,
        });
    }

    // ── Thin margin / pricing recommendations ─────────────────────────────────

    /// <summary>
    /// GET /api/plan/thin-margin?maxMarginPct={0.20}
    /// Products where estimated gross margin is below threshold.
    /// These are candidates for a list price increase.
    /// Default threshold: 20%.
    /// </summary>
    [Function("PlanThinMargin")]
    public async Task<HttpResponseData> GetThinMargin(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "plan/thin-margin")] HttpRequestData req)
    {
        var qs = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        double maxPct = double.TryParse(qs["maxMarginPct"], out var m) && m is > 0 and < 1
            ? m : 0.20;

        var result = await _planning.GetThinMarginItemsAsync(maxPct);
        return await OkAsync(req, new
        {
            thresholdMarginPct = maxPct,
            count  = result.Count,
            signal = "These products have thin or negative margins. Consider increasing the eShop list price.",
            items  = result,
        });
    }

    // ── Shortage forecast ─────────────────────────────────────────────────────

    /// <summary>
    /// GET /api/plan/shortage-forecast?days={90}
    /// Which purchased components will run out first given current sales velocity?
    /// Returns components sorted by urgency (days until stockout).
    /// </summary>
    [Function("PlanShortageForeceast")]
    public async Task<HttpResponseData> GetShortageForeceast(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "plan/shortage-forecast")] HttpRequestData req)
    {
        var qs  = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        int days = int.TryParse(qs["days"], out var d) && d > 0 ? d : 90;

        var result = await _planning.GetShortageForeceastAsync(days);

        return await OkAsync(req, new
        {
            forecastDays = days,
            critical = result.Count(s => s.UrgencyLevel == "critical"),
            warning  = result.Count(s => s.UrgencyLevel == "warning"),
            watch    = result.Count(s => s.UrgencyLevel == "watch"),
            items    = result,
        });
    }

    // ── Reorder recommendations ───────────────────────────────────────────────

    /// <summary>
    /// GET /api/plan/reorder-recommendations?days={60}
    /// For every component forecasted to run out within &lt;days&gt; days, returns:
    /// - suggested order quantity (30-day supply)
    /// - best vendor option (cheapest that can fulfil)
    /// - all vendor alternatives with pricing
    /// </summary>
    [Function("PlanReorderRecommendations")]
    public async Task<HttpResponseData> GetReorderRecommendations(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get",
            Route = "plan/reorder-recommendations")] HttpRequestData req)
    {
        await _supply.InitializeAsync();

        var qs   = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        int days = int.TryParse(qs["days"], out var d) && d > 0 ? d : 60;

        // Get supply chain catalog for the cheapest vendor lookup
        var catalog = await _supply.GetCatalogAsync();

        // Attach WeightKg from the catalog — SupplyQuote doesn't expose weight directly
        // so we pass the catalog and re-enrich inside the service
        var recommendations = await _planning.GetReorderRecommendationsAsync(days, catalog);

        decimal totalBestCost = recommendations
            .Where(r => r.BestVendor != null)
            .Sum(r => r.BestVendor!.TotalCost);

        return await OkAsync(req, new
        {
            forecastDays = days,
            totalRecommendations = recommendations.Count,
            estimatedTotalProcurementCost = totalBestCost,
            items = recommendations,
        });
    }

    // ── Response helpers ───────────────────────────────────────────────────────

    private static async Task<HttpResponseData> OkAsync(HttpRequestData req, object body)
    {
        var res = req.CreateResponse(HttpStatusCode.OK);
        res.Headers.Add("Content-Type", "application/json");
        await res.WriteStringAsync(JsonSerializer.Serialize(body, _json));
        return res;
    }

    private static async Task<HttpResponseData> NotFoundAsync(HttpRequestData req, string msg)
    {
        var res = req.CreateResponse(HttpStatusCode.NotFound);
        res.Headers.Add("Content-Type", "application/json");
        await res.WriteStringAsync(JsonSerializer.Serialize(new { error = msg }, _json));
        return res;
    }
}
