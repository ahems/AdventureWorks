using System.Net;
using System.Text.Json;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// HTTP-triggered endpoints for the supply chain procurement simulation.
/// All routes are under /api/supply/*.
/// </summary>
public class SupplyChainControlFunction
{
    private readonly SupplyChainService _svc;
    private readonly ILogger<SupplyChainControlFunction> _logger;
    private readonly WebPubSubService _webPubSub;

    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented        = true,
    };

    public SupplyChainControlFunction(
        SupplyChainService service,
        ILogger<SupplyChainControlFunction> logger,
        WebPubSubService webPubSub)
    {
        _svc    = service;
        _logger = logger;
        _webPubSub = webPubSub;
    }

    // ── Vendors ───────────────────────────────────────────────────────────────

    [Function("SupplyChainGetVendors")]
    public async Task<HttpResponseData> GetVendors(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "supply/vendors")] HttpRequestData req)
    {
        await _svc.InitializeAsync();
        var result = await _svc.GetVendorSummariesAsync();
        return await OkAsync(req, result);
    }

    [Function("SupplyChainGetVendor")]
    public async Task<HttpResponseData> GetVendor(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "supply/vendors/{vendorId}")] HttpRequestData req,
        string vendorId)
    {
        await _svc.InitializeAsync();
        var vendors = await _svc.GetVendorSummariesAsync();
        var vendor  = vendors.FirstOrDefault(v => v.Vendor.VendorId == vendorId);
        if (vendor == null)
            return await NotFoundAsync(req, $"Vendor '{vendorId}' not found.");

        var catalog = await _svc.GetCatalogAsync();
        var stock   = catalog.Where(c => c.VendorId == vendorId).ToList();

        return await OkAsync(req, new { vendor, stock });
    }

    // ── Catalog ───────────────────────────────────────────────────────────────

    [Function("SupplyChainGetCatalog")]
    public async Task<HttpResponseData> GetCatalog(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "supply/catalog")] HttpRequestData req)
    {
        await _svc.InitializeAsync();
        var catalog = await _svc.GetCatalogAsync();
        return await OkAsync(req, catalog);
    }

    [Function("SupplyChainGetCatalogByProduct")]
    public async Task<HttpResponseData> GetCatalogByProduct(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "supply/catalog/{productId:int}")] HttpRequestData req,
        int productId)
    {
        await _svc.InitializeAsync();
        var catalog = await _svc.GetCatalogAsync(productId);
        if (!catalog.Any())
            return await NotFoundAsync(req, $"No vendor offers found for ProductID {productId}.");
        return await OkAsync(req, catalog);
    }

    // ── Quote ─────────────────────────────────────────────────────────────────

    [Function("SupplyChainGetQuote")]
    public async Task<HttpResponseData> GetQuote(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "supply/quote")] HttpRequestData req)
    {
        await _svc.InitializeAsync();

        var qs        = req.Url?.Query ?? "";
        var qparsed   = System.Web.HttpUtility.ParseQueryString(qs);
        string? vendorId = qparsed["vendorId"];
        if (!int.TryParse(qparsed["productId"], out int productId))
            return await BadRequestAsync(req, "Missing or invalid 'productId' query parameter.");
        if (!int.TryParse(qparsed["qty"], out int qty) || qty <= 0)
            qty = 1;
        if (string.IsNullOrEmpty(vendorId))
            return await BadRequestAsync(req, "Missing 'vendorId' query parameter.");

        var quote = await _svc.GetQuoteAsync(vendorId, productId, qty);
        if (quote == null)
            return await NotFoundAsync(req, $"No quote available for vendor '{vendorId}', productId {productId}.");

        return await OkAsync(req, quote);
    }

    // ── Orders ────────────────────────────────────────────────────────────────

    [Function("SupplyChainPlaceOrder")]
    public async Task<HttpResponseData> PlaceOrder(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "supply/order")] HttpRequestData req)
    {
        await _svc.InitializeAsync();
        JsonDocument? body;
        try { body = await JsonDocument.ParseAsync(req.Body); }
        catch { return await BadRequestAsync(req, "Invalid JSON body."); }

        var root = body.RootElement;
        if (!root.TryGetProperty("vendorId", out var vidEl) ||
            !root.TryGetProperty("productId", out var pidEl) ||
            !root.TryGetProperty("qty", out var qtyEl))
            return await BadRequestAsync(req, "Body must include vendorId, productId, qty.");

        string vendorId = vidEl.GetString() ?? "";
        if (!pidEl.TryGetInt32(out int productId) || !qtyEl.TryGetInt32(out int qty) || qty <= 0)
            return await BadRequestAsync(req, "productId must be an integer; qty must be a positive integer.");

        if (qty > WarehouseService.INVENTORY_MAX_QTY)
            return await BadRequestAsync(req,
                $"qty cannot exceed {WarehouseService.INVENTORY_MAX_QTY} — the maximum units the warehouse can hold per SKU (smallint limit).");

        var order = await _svc.PlaceOrderAsync(vendorId, productId, qty);
        if (order == null)
        {
            var quote = await _svc.GetQuoteAsync(vendorId, productId, qty);
            string msg;
            if (quote == null)
                msg = $"Vendor '{vendorId}' or ProductID {productId} not found in the supply catalog.";
            else if (qty < quote.MinOrderQty)
                msg = $"Quantity too low. Minimum order for ProductID {productId} from vendor '{vendorId}' is {quote.MinOrderQty} units (requested: {qty}).";
            else if (qty > quote.MaxOrderQty)
                msg = $"Quantity too high. Maximum order is {quote.MaxOrderQty} units (requested: {qty}).";
            else
                msg = $"Insufficient stock. Available: {quote.StockAvailable}, requested: {qty}.";
            return await UnprocessableAsync(req, msg);
        }

        // Enqueue the pending→approved transition (fires after PendingToApprovedSimMin delay)
        var queueClient = await GetQueueClientAsync();
        await EnqueueTransitionAsync(queueClient, order.OrderId,
            targetStatus: "approved",
            delaySec: 5);          // 5 sim-min = 5 real sec at scale 60

        // Schedule vendor restock at placement time (supplier knows to replenish when PO arrives)
        var vendor = await _svc.GetVendorAsync(vendorId);
        int restockHrs  = vendor?.RestockDelaySimHrs ?? 12;
        double effScale = await _svc.GetEffectiveTimeScaleAsync();
        int restockSec  = Math.Max(1, (int)(restockHrs * 3600.0 / effScale));

        var restockMsg = new Models.PurchaseOrderMessage
        {
            MessageType    = "vendor-restock",
            VendorId       = vendorId,
            ProductId      = productId,
            OrderedQty     = qty,
            ScheduledAtUtc = DateTime.UtcNow.AddSeconds(restockSec),
        };
        string restockJson    = JsonSerializer.Serialize(restockMsg);
        string restockEncoded = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(restockJson));
        await queueClient.SendMessageAsync(restockEncoded,
            visibilityTimeout: TimeSpan.FromSeconds(restockSec));

        await _webPubSub.SendToGroupAsync("supply-chain", new { @event = "po-created", productId, vendorId, qty });

        return await CreatedAsync(req, order);
    }

    [Function("SupplyChainGetOrders")]
    public async Task<HttpResponseData> GetOrders(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "supply/orders")] HttpRequestData req)
    {
        await _svc.InitializeAsync();
        var orders = await _svc.GetOrdersAsync(includeCompleted: false);
        return await OkAsync(req, orders);
    }

    [Function("SupplyChainGetOrderHistory")]
    public async Task<HttpResponseData> GetOrderHistory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "supply/orders/history")] HttpRequestData req)
    {
        await _svc.InitializeAsync();
        var orders = await _svc.GetOrderHistoryAsync();
        return await OkAsync(req, orders);
    }

    [Function("SupplyChainGetOrder")]
    public async Task<HttpResponseData> GetOrder(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "supply/order/{orderId}")] HttpRequestData req,
        string orderId)
    {
        var order = await _svc.GetOrderAsync(orderId.ToUpperInvariant());
        if (order == null)
            return await NotFoundAsync(req, $"Order '{orderId}' not found.");
        return await OkAsync(req, order);
    }

    [Function("SupplyChainCancelOrder")]
    public async Task<HttpResponseData> CancelOrder(
        [HttpTrigger(AuthorizationLevel.Anonymous, "delete", Route = "supply/order/{orderId}")] HttpRequestData req,
        string orderId)
    {
        string reason = "Cancelled by operator";
        try
        {
            var body = await JsonDocument.ParseAsync(req.Body);
            if (body.RootElement.TryGetProperty("reason", out var r))
                reason = r.GetString() ?? reason;
        }
        catch { /* reason stays default */ }

        bool ok = await _svc.CancelOrderAsync(orderId.ToUpperInvariant(), reason);
        if (!ok)
            return await UnprocessableAsync(req, $"Order '{orderId}' not found or cannot be cancelled (must be in 'pending' status).");

        return await OkAsync(req, new { message = $"Order {orderId} cancelled.", reason });
    }

    // ── Initialize ──────────────────────────────────────────────────────────

    [Function("SupplyChainInitialize")]
    public async Task<HttpResponseData> Initialize(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "supply/initialize")] HttpRequestData req)
    {
        await _svc.ForceReinitializeAsync();
        return await OkAsync(req, new { message = "Supply chain re-initialized with updated stock levels." });
    }

    // ── Restock ───────────────────────────────────────────────────────────────

    [Function("SupplyChainRestock")]
    public async Task<HttpResponseData> Restock(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "supply/restock/{vendorId}")] HttpRequestData req,
        string vendorId)
    {
        int productId = 0;
        try
        {
            var body = await JsonDocument.ParseAsync(req.Body);
            if (body.RootElement.TryGetProperty("productId", out var pid))
                int.TryParse(pid.ToString(), out productId);
        }
        catch { /* productId stays 0 = all */ }

        await _svc.RestockVendorAsync(vendorId, productId);
        return await OkAsync(req, new
        {
            message = productId > 0
                ? $"Restocked {vendorId} for ProductID {productId}."
                : $"Restocked all components for {vendorId}.",
        });
    }

    // ── Supply Chain Config ────────────────────────────────────────────────────

    [Function("SupplyChainGetConfig")]
    public async Task<HttpResponseData> GetConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "supply/config")] HttpRequestData req)
    {
        double multiplier = await _svc.GetSpeedMultiplierAsync();
        return await OkAsync(req, new { supplyChainSpeedMultiplier = multiplier });
    }

    [Function("SupplyChainPutConfig")]
    public async Task<HttpResponseData> PutConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "supply/config")] HttpRequestData req)
    {
        JsonDocument? body;
        try { body = await JsonDocument.ParseAsync(req.Body); }
        catch { return await BadRequestAsync(req, "Invalid JSON body."); }

        if (!body.RootElement.TryGetProperty("supplyChainSpeedMultiplier", out var valEl))
            return await BadRequestAsync(req, "Body must include 'supplyChainSpeedMultiplier' (number 1–50).");

        double value;
        if (valEl.ValueKind == JsonValueKind.Number)
            value = valEl.GetDouble();
        else
            return await BadRequestAsync(req, "'supplyChainSpeedMultiplier' must be a number.");

        if (value < 1.0 || value > 50.0)
            return await BadRequestAsync(req, "'supplyChainSpeedMultiplier' must be between 1 and 50.");

        await _svc.SetSpeedMultiplierAsync(value);
        return await OkAsync(req, new { supplyChainSpeedMultiplier = value, message = $"Speed multiplier updated to {value}×." });
    }


    // ── Bulk Reorder ─────────────────────────────────────────────────────────

    /// <summary>
    /// Accepts a bulk reorder plan and places all orders server-side with staggered
    /// delivery timing per vendor. Returns HTTP 202 immediately; orders are placed
    /// in the background with real-time Web PubSub events after each one.
    /// </summary>
    [Function("SupplyChainReorderAll")]
    public async Task<HttpResponseData> ReorderAll(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "supply/reorder-all")] HttpRequestData req)
    {
        await _svc.InitializeAsync();

        JsonDocument? body;
        try { body = await JsonDocument.ParseAsync(req.Body); }
        catch { return await BadRequestAsync(req, "Invalid JSON body."); }

        if (!body.RootElement.TryGetProperty("items", out var itemsEl) || itemsEl.ValueKind != JsonValueKind.Array)
            return await BadRequestAsync(req, "Body must include 'items' array.");

        // Parse the plan
        var plan = new List<ReorderItem>();
        foreach (var itemEl in itemsEl.EnumerateArray())
        {
            if (!itemEl.TryGetProperty("productId", out var pidEl) || !pidEl.TryGetInt32(out int productId))
                continue;
            if (!itemEl.TryGetProperty("remainingToOrder", out var rtoEl) || !rtoEl.TryGetInt32(out int remainingToOrder))
                continue;
            if (!itemEl.TryGetProperty("quotes", out var quotesEl) || quotesEl.ValueKind != JsonValueKind.Array)
                continue;

            var quotes = new List<ReorderQuote>();
            foreach (var qEl in quotesEl.EnumerateArray())
            {
                quotes.Add(new ReorderQuote
                {
                    VendorId       = qEl.TryGetProperty("vendorId", out var v) ? v.GetString() ?? "" : "",
                    StockAvailable = qEl.TryGetProperty("stockAvailable", out var sa) && sa.TryGetInt32(out int saVal) ? saVal : 0,
                    MinOrderQty    = qEl.TryGetProperty("minOrderQty", out var mn) && mn.TryGetInt32(out int mnVal) ? mnVal : 1,
                    MaxOrderQty    = qEl.TryGetProperty("maxOrderQty", out var mx) && mx.TryGetInt32(out int mxVal) ? mxVal : 0,
                    UnitCost       = qEl.TryGetProperty("unitCost", out var uc) && uc.TryGetDouble(out double ucVal) ? ucVal : 0,
                });
            }

            plan.Add(new ReorderItem { ProductId = productId, RemainingToOrder = remainingToOrder, Quotes = quotes });
        }

        if (plan.Count == 0)
            return await BadRequestAsync(req, "No valid items in the reorder plan.");

        // Count total orders we expect to place (for the response)
        int totalPlanned = 0;
        foreach (var item in plan)
        {
            int remaining = item.RemainingToOrder;
            foreach (var q in item.Quotes.Where(q => q.StockAvailable > 0).OrderBy(q => q.UnitCost))
            {
                if (remaining <= 0) break;
                int minQty = Math.Max(1, q.MinOrderQty);
                int maxQty = q.MaxOrderQty > 0 ? q.MaxOrderQty : q.StockAvailable;
                int vendorStock = q.StockAvailable;
                while (remaining > 0 && vendorStock >= minQty)
                {
                    int desired = Math.Min(Math.Min(remaining, vendorStock), maxQty);
                    int orderQty = Math.Max(desired, minQty);
                    if (orderQty > vendorStock) break;
                    totalPlanned++;
                    remaining -= orderQty;
                    vendorStock -= orderQty;
                }
            }
        }

        // Fire-and-forget: start placing orders in the background
        _ = Task.Run(async () =>
        {
            try
            {
                await ExecuteBulkReorderAsync(plan);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Bulk reorder background task failed.");
            }
        });

        var response = req.CreateResponse(HttpStatusCode.Accepted);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync(JsonSerializer.Serialize(
            new { accepted = true, totalOrdersPlanned = totalPlanned }, _json));
        return response;
    }

    private async Task ExecuteBulkReorderAsync(List<ReorderItem> plan)
    {
        var queueClient = await GetQueueClientAsync();
        double effScale = await _svc.GetEffectiveTimeScaleAsync();

        // Pre-cache vendor info to avoid repeated lookups
        var vendorCache = new System.Collections.Concurrent.ConcurrentDictionary<string, VendorInfo?>(
            StringComparer.OrdinalIgnoreCase);

        // Global counters (thread-safe)
        int totalPlaced = 0;
        int totalFailed = 0;

        // Global per-vendor stagger index (thread-safe)
        var vendorOrderIndex = new System.Collections.Concurrent.ConcurrentDictionary<string, int>(
            StringComparer.OrdinalIgnoreCase);

        // Web PubSub throttle: push every N orders per product instead of every 1
        const int PUB_SUB_BATCH_SIZE = 50;

        // Process products in parallel (each product's orders are independent)
        await Parallel.ForEachAsync(plan,
            new ParallelOptions { MaxDegreeOfParallelism = 8 },
            async (item, ct) =>
        {
            var available = item.Quotes
                .Where(q => q.StockAvailable > 0)
                .OrderBy(q => q.UnitCost)
                .ToList();

            int remaining = item.RemainingToOrder;
            int productOrderCount = 0;

            foreach (var quote in available)
            {
                if (remaining <= 0) break;
                int minQty = Math.Max(1, quote.MinOrderQty);
                int maxQty = quote.MaxOrderQty > 0 ? quote.MaxOrderQty : quote.StockAvailable;
                int vendorStock = quote.StockAvailable;

                // Cache vendor info
                if (!vendorCache.TryGetValue(quote.VendorId, out var vendor))
                {
                    vendor = await _svc.GetVendorAsync(quote.VendorId);
                    vendorCache.TryAdd(quote.VendorId, vendor);
                }

                int restockHrs = vendor?.RestockDelaySimHrs ?? 12;
                int restockSec = Math.Max(1, (int)(restockHrs * 3600.0 / effScale));

                while (remaining > 0 && vendorStock >= minQty)
                {
                    int desired = Math.Min(Math.Min(remaining, vendorStock), maxQty);
                    int orderQty = Math.Max(desired, minQty);
                    if (orderQty > vendorStock) break;

                    var orderId = await _svc.PlaceOrderFastAsync(quote.VendorId, item.ProductId, orderQty);
                    if (orderId == null)
                    {
                        Interlocked.Increment(ref totalFailed);
                        break; // vendor can't fulfill — try next
                    }

                    // Stagger: each successive PO to the same vendor gets +3s delay
                    int idx = vendorOrderIndex.AddOrUpdate(quote.VendorId, 0, (_, v) => v + 1);
                    int staggerDelay = 5 + (idx * 3);

                    // Fire transition + restock queue messages concurrently
                    var transitionTask = EnqueueTransitionAsync(queueClient, orderId,
                        targetStatus: "approved",
                        delaySec: staggerDelay);

                    var restockMsg = new Models.PurchaseOrderMessage
                    {
                        MessageType    = "vendor-restock",
                        VendorId       = quote.VendorId,
                        ProductId      = item.ProductId,
                        OrderedQty     = orderQty,
                        ScheduledAtUtc = DateTime.UtcNow.AddSeconds(restockSec),
                    };
                    string restockJson    = JsonSerializer.Serialize(restockMsg);
                    string restockEncoded = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(restockJson));
                    var restockTask = queueClient.SendMessageAsync(restockEncoded,
                        visibilityTimeout: TimeSpan.FromSeconds(restockSec));

                    await Task.WhenAll(transitionTask, restockTask);

                    Interlocked.Increment(ref totalPlaced);
                    productOrderCount++;
                    remaining -= orderQty;
                    vendorStock -= orderQty;

                    // Throttled Web PubSub: push every N orders
                    if (productOrderCount % PUB_SUB_BATCH_SIZE == 0)
                    {
                        await _webPubSub.SendToGroupAsync("supply-chain", new
                        {
                            @event = "po-created",
                            productId = item.ProductId,
                            vendorId = quote.VendorId,
                            qty = orderQty,
                            batchCount = PUB_SUB_BATCH_SIZE,
                        });
                    }
                }
            }

            // Final push for any remaining orders not yet notified
            if (productOrderCount % PUB_SUB_BATCH_SIZE != 0)
            {
                await _webPubSub.SendToGroupAsync("supply-chain", new
                {
                    @event = "po-created",
                    productId = item.ProductId,
                    batchCount = productOrderCount % PUB_SUB_BATCH_SIZE,
                });
            }
        });

        _logger.LogInformation("Bulk reorder complete: placed {Placed} orders, {Failed} failed.", totalPlaced, totalFailed);
    }

    private sealed class ReorderItem
    {
        public int ProductId { get; set; }
        public int RemainingToOrder { get; set; }
        public List<ReorderQuote> Quotes { get; set; } = [];
    }

    private sealed class ReorderQuote
    {
        public string VendorId { get; set; } = "";
        public int StockAvailable { get; set; }
        public int MinOrderQty { get; set; }
        public int MaxOrderQty { get; set; }
        public double UnitCost { get; set; }
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    private static Azure.Storage.Queues.QueueClient? _cachedQueueClient;
    private static readonly SemaphoreSlim _queueInitLock = new(1, 1);

    private static async Task<Azure.Storage.Queues.QueueClient> GetQueueClientAsync()
    {
        if (_cachedQueueClient != null) return _cachedQueueClient;
        await _queueInitLock.WaitAsync();
        try
        {
            if (_cachedQueueClient != null) return _cachedQueueClient;
            string? queueUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
            Azure.Storage.Queues.QueueClient client;
            if (!string.IsNullOrEmpty(queueUri))
            {
                var svc = new Azure.Storage.Queues.QueueServiceClient(
                    new Uri(queueUri),
                    new Azure.Identity.DefaultAzureCredential());
                client = svc.GetQueueClient(SupplyChainService.QUEUE_NAME);
            }
            else
            {
                string connStr = Environment.GetEnvironmentVariable("AzureWebJobsStorage") ?? "UseDevelopmentStorage=true";
                client = new Azure.Storage.Queues.QueueClient(
                    connStr, SupplyChainService.QUEUE_NAME,
                    new Azure.Storage.Queues.QueueClientOptions
                    {
                        MessageEncoding = Azure.Storage.Queues.QueueMessageEncoding.Base64
                    });
            }
            await client.CreateIfNotExistsAsync();
            _cachedQueueClient = client;
            return client;
        }
        finally { _queueInitLock.Release(); }
    }

    private static async Task EnqueueTransitionAsync(
        Azure.Storage.Queues.QueueClient queue,
        string orderId,
        string targetStatus,
        int delaySec)
    {
        var msg = new Models.PurchaseOrderMessage
        {
            MessageType   = "order-transition",
            OrderId       = orderId,
            TargetStatus  = targetStatus,
            ScheduledAtUtc = DateTime.UtcNow.AddSeconds(delaySec),
        };
        string json = JsonSerializer.Serialize(msg);
        string encoded = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json));
        await queue.SendMessageAsync(encoded, visibilityTimeout: TimeSpan.FromSeconds(delaySec));
    }

    // ── Response helpers ───────────────────────────────────────────────────────

    private static async Task<HttpResponseData> OkAsync(HttpRequestData req, object body)
    {
        var res = req.CreateResponse(HttpStatusCode.OK);
        res.Headers.Add("Content-Type", "application/json");
        await res.WriteStringAsync(JsonSerializer.Serialize(body, _json));
        return res;
    }

    private static async Task<HttpResponseData> CreatedAsync(HttpRequestData req, object body)
    {
        var res = req.CreateResponse(HttpStatusCode.Created);
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

    private static async Task<HttpResponseData> BadRequestAsync(HttpRequestData req, string msg)
    {
        var res = req.CreateResponse(HttpStatusCode.BadRequest);
        res.Headers.Add("Content-Type", "application/json");
        await res.WriteStringAsync(JsonSerializer.Serialize(new { error = msg }, _json));
        return res;
    }

    private static async Task<HttpResponseData> UnprocessableAsync(HttpRequestData req, string msg)
    {
        var res = req.CreateResponse(HttpStatusCode.UnprocessableEntity);
        res.Headers.Add("Content-Type", "application/json");
        await res.WriteStringAsync(JsonSerializer.Serialize(new { error = msg }, _json));
        return res;
    }
}
