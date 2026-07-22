using System.Net;
using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Queues;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP endpoints that control and monitor the manufacturing simulation.
///
/// POST /api/manufacturing/begin         – Explode BOM, create WorkOrders + routing, seed queue
/// POST /api/manufacturing/stop          – Clear the production queue (scale-to-zero follows)
/// GET  /api/manufacturing/status        – Live counts, shortages, scrap events, location load
/// GET  /api/manufacturing/active        – In-progress routing operations with elapsed time
/// GET  /api/manufacturing/scrap-config  – Per-location failure rates and applicable scrap reasons
/// PUT  /api/manufacturing/scrap-config/{locationId} – Update failure rate/reasons for a station
/// GET  /api/manufacturing/location-config             – Per-location capacity settings
/// PUT  /api/manufacturing/location-config/{locationId} – Update capacity/shift/speed for a station
/// GET  /api/manufacturing/workforce     – Headcount summary by location and shift
/// GET  /api/manufacturing/workforce/detail – All workers with status, operator assignment, pay rate
/// GET  /api/manufacturing/scrap-events  – All scrap events with optional ?vendorId= filter
/// GET  /api/manufacturing/vendor-quality          – Aggregated quality report per supplier vendor
/// GET  /api/manufacturing/vendor-quality/{vendorId} – Quality report scoped to one vendor
/// </summary>
public class ManufacturingControlFunction
{
    private const string QUEUE_NAME = "production-wo-queue";
    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private readonly ILogger<ManufacturingControlFunction> _logger;
    private readonly WorkOrderSimulationService _sim;
    private readonly WorkforceService _workforce;
    private readonly WebPubSubService _webPubSub;

    public ManufacturingControlFunction(
        ILogger<ManufacturingControlFunction> logger,
        WorkOrderSimulationService sim,
        WorkforceService workforce,
        WebPubSubService webPubSub)
    {
        _logger    = logger;
        _sim       = sim;
        _workforce = workforce;
        _webPubSub = webPubSub;
    }

    // ── POST /api/manufacturing/begin ─────────────────────────────────────────

    [Function(nameof(ManufacturingBegin))]
    public async Task<HttpResponseData> ManufacturingBegin(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/begin")]
        HttpRequestData req)
    {
        BeginRequest? body;
        try
        {
            body = JsonSerializer.Deserialize<BeginRequest>(
                await new StreamReader(req.Body).ReadToEndAsync(), JsonOpts);
        }
        catch
        {
            return await BadRequestAsync(req, "Invalid JSON body.");
        }

        if (body == null || body.ProductId <= 0 || body.OrderQty <= 0)
            return await BadRequestAsync(req, "productId and orderQty are required and must be > 0.");

        if (body.OrderQty > WarehouseService.INVENTORY_MAX_QTY)
            return await BadRequestAsync(req,
                $"orderQty cannot exceed {WarehouseService.INVENTORY_MAX_QTY} — the maximum units the warehouse can hold per SKU (smallint limit).");

        // 1. Validate the root product is a finished good
        var productInfo = await _sim.ValidateFinishedGoodAsync(body.ProductId);
        if (productInfo == null)
            return await BadRequestAsync(req, $"ProductID {body.ProductId} not found.");
        if (!productInfo.MakeFlag || !productInfo.FinishedGoodsFlag)
            return await BadRequestAsync(req,
                $"ProductID {body.ProductId} ({productInfo.Name}) is not a manufactured finished good. " +
                "Only products with MakeFlag=true and FinishedGoodsFlag=true can be the root of a production run.");

        // 2. Initialise Table Storage tables on first use
        await _sim.InitializeTablesAsync();

        // 3. Explode BOM
        var bomFlat = await _sim.GetBomFlatAsync(body.ProductId);
        if (!bomFlat.Any(n => n.Depth > 0))
            _logger.LogWarning("ProductID {ProductId} has no BOM entries — will create a single WorkOrder with default routing.", body.ProductId);

        // 4. Inventory warnings for purchased (MakeFlag=false) components
        var purchasedNodes = bomFlat.Where(n => !n.MakeFlag && n.Depth > 0).ToList();
        var warnings = await _sim.GetInventoryWarningsAsync(purchasedNodes, body.OrderQty);
        if (warnings.Any())
            _logger.LogWarning("Inventory shortages detected for {Count} component(s) — scheduling anyway. Production may stall.", warnings.Count);

        // 5. Deduplicate manufactured BOM nodes: aggregate required quantity by productId
        var now    = DateTime.UtcNow;
        var dueDate = body.DueDate ?? now.AddDays(7);
        var runId  = Guid.NewGuid().ToString("N");

        var manufacturedNodes = bomFlat
            .Where(n => n.MakeFlag && n.ProductId != body.ProductId)
            .GroupBy(n => n.ProductId)
            .Select(g => new
            {
                ProductId       = g.Key,
                Name            = g.First().Name,
                TotalQty        = (int)Math.Ceiling(g.Max(n => (double)n.CumulativeQty) * body.OrderQty),
                ParentProductId = g.First().ParentProductId,
            })
            .ToList();

        // 6. Identify which manufactured nodes are leaf nodes
        //    (no other manufactured BOM node lists them as a parent)
        var parentProductIds = bomFlat
            .Where(n => n.MakeFlag && n.ParentProductId.HasValue)
            .Select(n => n.ParentProductId!.Value)
            .ToHashSet();

        // 7. Create WorkOrders (root last so all children exist first)
        var woMap = new Dictionary<int, int>(); // productId → workOrderId

        foreach (var node in manufacturedNodes)
        {
            var woId = await _sim.CreateWorkOrderAsync(node.ProductId, node.TotalQty, now, dueDate);
            var isAssembly = parentProductIds.Contains(node.ProductId);
            var routing    = await _sim.GetRoutingTemplateAsync(node.ProductId, isAssembly);
            await _sim.CreateWorkOrderRoutingAsync(woId, node.ProductId, routing, now, dueDate);
            woMap[node.ProductId] = woId;
            _logger.LogDebug("Created WorkOrder {WorkOrderId} for component ProductID={ProductId} Qty={Qty}",
                woId, node.ProductId, node.TotalQty);
        }

        var rootWoId = await _sim.CreateWorkOrderAsync(body.ProductId, body.OrderQty, now, dueDate);
        var rootIsAssembly = parentProductIds.Contains(body.ProductId) || manufacturedNodes.Any();
        var rootRouting    = await _sim.GetRoutingTemplateAsync(body.ProductId, rootIsAssembly);
        await _sim.CreateWorkOrderRoutingAsync(rootWoId, body.ProductId, rootRouting, now, dueDate);
        woMap[body.ProductId] = rootWoId;

        // 8. Build and save run record
        var runWoItems = woMap.Select(kvp => new RunWoItem(
            WorkOrderId:     kvp.Value,
            ProductId:       kvp.Key,
            ParentProductId: bomFlat.FirstOrDefault(n => n.ProductId == kvp.Key)?.ParentProductId,
            IsLeaf:          !parentProductIds.Contains(kvp.Key))).ToList();

        var runRecord = new ManufacturingRunRecord(
            runId, body.ProductId, rootWoId, now, runWoItems);
        await _sim.SaveRunAsync(runRecord);

        // 9. Enqueue first routing op for each leaf WorkOrder
        var queueClient = await GetQueueClientAsync();
        var leafWos = runWoItems.Where(w => w.IsLeaf).ToList();

        foreach (var leaf in leafWos)
        {
            var firstOp = await _sim.GetFirstRoutingOpAsync(leaf.WorkOrderId);
            if (firstOp == null)
            {
                _logger.LogWarning("WorkOrder {WorkOrderId} has no routing ops — skipping.", leaf.WorkOrderId);
                continue;
            }

            var msg = new WorkOrderOperationMessage
            {
                RunId              = runId,
                WorkOrderId        = leaf.WorkOrderId,
                ProductId          = leaf.ProductId,
                OperationSequence  = firstOp.OperationSequence,
                LocationId         = firstOp.LocationId,
                PlannedCostForOp   = (double)firstOp.PlannedCost,
                CostRateForLocation = (double)firstOp.CostRate,
            };

            await queueClient.SendMessageAsync(
                JsonSerializer.Serialize(msg),
                visibilityTimeout: TimeSpan.Zero);

            _logger.LogInformation(
                "Enqueued start op for RunId={RunId} WO={WorkOrderId} Product={ProductId} Op={OpSeq} Location={LocationId}",
                runId, leaf.WorkOrderId, leaf.ProductId, firstOp.OperationSequence, firstOp.LocationId);
        }

        var result = new BeginManufacturingResult(runId, rootWoId,
            woMap.Count, leafWos.Count, warnings);

        var response = req.CreateResponse(HttpStatusCode.Accepted);
        await response.WriteAsJsonAsync(result);
        return response;
    }

    // ── POST /api/manufacturing/stop ──────────────────────────────────────────

    [Function(nameof(ManufacturingStop))]
    public async Task<HttpResponseData> ManufacturingStop(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/stop")]
        HttpRequestData req)
    {
        var queueClient = await GetQueueClientAsync();
        await queueClient.ClearMessagesAsync();

        _logger.LogInformation("Manufacturing queue cleared — simulation stopped.");
        await _webPubSub.SendToGroupAsync("manufacturing-ops", new { @event = "simulation-stopped" });
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(new { message = "Production queue cleared. Container will scale to zero once in-flight messages complete." });
        return response;
    }

    // ── GET /api/manufacturing/status ─────────────────────────────────────────

    [Function(nameof(ManufacturingStatus))]
    public async Task<HttpResponseData> ManufacturingStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/status")]
        HttpRequestData req)
    {
        try
        {
        var queueClient  = await GetQueueClientAsync();
        var queueProps   = await queueClient.GetPropertiesAsync();
        long queueDepth  = queueProps.Value.ApproximateMessagesCount;

        var (pending, inProgress, completedToday) = await _sim.GetWorkOrderCountsAsync();
        var shortages    = await _sim.GetAllShortagesAsync();
        var scrapEvents  = await _sim.GetRecentScrapEventsAsync(10);
        var locationLoad = await _sim.GetLocationLoadsAsync();

        var status = new ManufacturingStatusData(
            IsRunning:        queueDepth > 0 || inProgress > 0,
            QueueDepth:       queueDepth,
            PendingWorkOrders:    pending,
            InProgressWorkOrders: inProgress,
            CompletedToday:       completedToday,
            StalledForMaterials:  shortages.Count,
            Shortages:   shortages,
            RecentScrapEvents: scrapEvents,
            LocationLoad: locationLoad);

        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(status);
        return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ManufacturingStatus failed");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.GetType().Name, message = ex.Message, inner = ex.InnerException?.Message });
            return err;
        }
    }

    // ── GET /api/manufacturing/active ─────────────────────────────────────────

    [Function(nameof(ManufacturingActive))]
    public async Task<HttpResponseData> ManufacturingActive(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/active")]
        HttpRequestData req)
    {
        var activeOps = await _sim.GetActiveOperationsAsync();
        var response  = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(activeOps);
        return response;
    }

    // ── GET /api/manufacturing/scrap-config ───────────────────────────────────

    [Function(nameof(GetScrapConfig))]
    public async Task<HttpResponseData> GetScrapConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/scrap-config")]
        HttpRequestData req)
    {
        var configs  = await _sim.GetAllScrapConfigsAsync();
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(configs);
        return response;
    }

    // ── PUT /api/manufacturing/scrap-config/{locationId} ─────────────────────

    [Function(nameof(PutScrapConfig))]
    public async Task<HttpResponseData> PutScrapConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "manufacturing/scrap-config/{locationId:int}")]
        HttpRequestData req, int locationId)
    {
        ScrapConfigRequest? body;
        try
        {
            body = JsonSerializer.Deserialize<ScrapConfigRequest>(
                await new StreamReader(req.Body).ReadToEndAsync(), JsonOpts);
        }
        catch
        {
            return await BadRequestAsync(req, "Invalid JSON body.");
        }

        if (body == null || body.FailureRatePct < 0 || body.FailureRatePct > 1)
            return await BadRequestAsync(req, "failureRatePct must be between 0.0 and 1.0.");

        await _sim.UpsertScrapConfigAsync(locationId, body.FailureRatePct,
            body.ScrapReasonIds ?? Array.Empty<int>(), body.Note);

        _logger.LogInformation(
            "Scrap config updated for LocationID={LocationId}: rate={Rate:P0}, reasons={Reasons}",
            locationId, body.FailureRatePct, string.Join(",", body.ScrapReasonIds ?? Array.Empty<int>()));

        await _webPubSub.SendToGroupAsync("manufacturing-ops", new { @event = "config-changed", configType = "scrap", locationId });
        var updated  = await _sim.GetScrapConfigAsync(locationId);
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(updated);
        return response;
    }

    // ── GET /api/manufacturing/location-config ────────────────────────────────

    [Function(nameof(GetLocationConfig))]
    public async Task<HttpResponseData> GetLocationConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/location-config")]
        HttpRequestData req)
    {
        var configs  = await _sim.GetAllLocationConfigsAsync();
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(configs);
        return response;
    }

    // ── PUT /api/manufacturing/location-config/{locationId} ───────────────────

    [Function(nameof(PutLocationConfig))]
    public async Task<HttpResponseData> PutLocationConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "manufacturing/location-config/{locationId:int}")]
        HttpRequestData req, int locationId)
    {
        LocationConfigRequest? body;
        try
        {
            body = JsonSerializer.Deserialize<LocationConfigRequest>(
                await new StreamReader(req.Body).ReadToEndAsync(), JsonOpts);
        }
        catch
        {
            return await BadRequestAsync(req, "Invalid JSON body.");
        }

        if (body == null || body.CapacityUnits < 1)
            return await BadRequestAsync(req, "capacityUnits must be at least 1.");

        var config = new LocationConfigData(
            locationId,
            body.CapacityUnits,
            body.DailyOperatingHours > 0 ? body.DailyOperatingHours : 8.0,
            body.SpeedFactor > 0 ? body.SpeedFactor : 1.0,
            body.OvertimeMultiplier > 0 ? body.OvertimeMultiplier : 1.5,
            body.ShiftStartHour >= 0 && body.ShiftStartHour < 24 ? body.ShiftStartHour : 6,
            body.Note);

        await _sim.UpsertLocationConfigAsync(locationId, config);

        _logger.LogInformation(
            "Location config updated for LocationID={LocationId}: capacity={Units}, speed={Speed:F2}, hours={Hours}h",
            locationId, config.CapacityUnits, config.SpeedFactor, config.DailyOperatingHours);

        await _webPubSub.SendToGroupAsync("manufacturing-ops", new { @event = "config-changed", configType = "location", locationId });
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(config);
        return response;
    }

    // ── Shared queue helper (mirrors ProcessSalesOrderStatus pattern) ─────────

    internal static async Task<QueueClient> GetQueueClientAsync()
    {
        var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        if (string.IsNullOrEmpty(queueServiceUri))
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not configured.");
            queueServiceUri = $"https://{accountName}.queue.core.windows.net";
        }

        var svc    = new QueueServiceClient(
            new Uri(queueServiceUri),
            new DefaultAzureCredential(),
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
        var client = svc.GetQueueClient(QUEUE_NAME);
        await client.CreateIfNotExistsAsync();
        return client;
    }

    private static async Task<HttpResponseData> BadRequestAsync(HttpRequestData req, string message)
    {
        var response = req.CreateResponse(HttpStatusCode.BadRequest);
        await response.WriteAsJsonAsync(new { error = message });
        return response;
    }

    // ── GET /api/manufacturing/workforce ─────────────────────────────────────

    [Function(nameof(ManufacturingWorkforce))]
    public async Task<HttpResponseData> ManufacturingWorkforce(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/workforce")]
        HttpRequestData req)
    {
        await _workforce.InitializeAsync();
        var snapshot = await _workforce.GetSnapshotAsync();
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(snapshot);
        return response;
    }

    [Function(nameof(ManufacturingWorkforceDetail))]
    public async Task<HttpResponseData> ManufacturingWorkforceDetail(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/workforce/detail")]
        HttpRequestData req)
    {
        await _workforce.InitializeAsync();
        var workers = await _workforce.GetDetailAsync();
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(workers);
        return response;
    }

    // ── Vendor quality / scrap attribution ────────────────────────────────────

    [Function(nameof(ManufacturingGetScrapEvents))]
    public async Task<HttpResponseData> ManufacturingGetScrapEvents(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/scrap-events")]
        HttpRequestData req)
    {
        var qs = System.Web.HttpUtility.ParseQueryString(req.Url?.Query ?? "");
        int? vendorId = int.TryParse(qs["vendorId"], out int vid) ? vid : null;

        var events = await _sim.GetAllScrapEventsAsync(vendorId);
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(events);
        return response;
    }

    [Function(nameof(ManufacturingGetVendorQuality))]
    public async Task<HttpResponseData> ManufacturingGetVendorQuality(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/vendor-quality")]
        HttpRequestData req)
    {
        var report = await _sim.GetVendorQualityReportAsync();
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(report);
        return response;
    }

    [Function(nameof(ManufacturingGetVendorQualityById))]
    public async Task<HttpResponseData> ManufacturingGetVendorQualityById(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/vendor-quality/{vendorId:int}")]
        HttpRequestData req,
        int vendorId)
    {
        var report = await _sim.GetVendorQualityReportAsync(vendorId);
        if (report.Count == 0)
        {
            var notFound = req.CreateResponse(HttpStatusCode.NotFound);
            await notFound.WriteAsJsonAsync(new { error = $"No attributed scrap events found for VendorID {vendorId}." });
            return notFound;
        }
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(report[0]);
        return response;
    }

    // ── Request body types ─────────────────────────────────────────────────────

    private sealed class BeginRequest
    {
        public int ProductId { get; set; }
        public int OrderQty  { get; set; }
        public DateTime? DueDate { get; set; }
    }

    private sealed class ScrapConfigRequest
    {
        public double FailureRatePct { get; set; }
        public int[]? ScrapReasonIds { get; set; }
        public string? Note { get; set; }
    }

    private sealed class LocationConfigRequest
    {
        public int    CapacityUnits       { get; set; }
        public double DailyOperatingHours { get; set; }
        public double SpeedFactor         { get; set; }
        public double OvertimeMultiplier  { get; set; }
        public int    ShiftStartHour      { get; set; }
        public string? Note               { get; set; }
    }
}
