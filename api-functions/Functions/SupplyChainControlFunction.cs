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

    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented        = true,
    };

    public SupplyChainControlFunction(
        SupplyChainService service,
        ILogger<SupplyChainControlFunction> logger)
    {
        _svc    = service;
        _logger = logger;
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

        var order = await _svc.PlaceOrderAsync(vendorId, productId, qty);
        if (order == null)
        {
            var quote = await _svc.GetQuoteAsync(vendorId, productId, qty);
            string msg = quote == null
                ? $"Vendor '{vendorId}' or ProductID {productId} not found."
                : $"Insufficient stock. Available: {quote.StockAvailable}, requested: {qty}.";
            return await UnprocessableAsync(req, msg);
        }

        // Enqueue the pending→approved transition (fires after PendingToApprovedSimMin delay)
        var queueClient = await GetQueueClientAsync();
        await EnqueueTransitionAsync(queueClient, order.OrderId,
            targetStatus: "approved",
            delaySec: 5);          // 5 sim-min = 5 real sec at scale 60

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

    // ── Reset ─────────────────────────────────────────────────────────────────

    [Function("SupplyChainReset")]
    public async Task<HttpResponseData> Reset(
        [HttpTrigger(AuthorizationLevel.Anonymous, "delete", Route = "supply/reset")] HttpRequestData req)
    {
        await _svc.ResetAsync();
        return await OkAsync(req, new { message = "Supply chain simulation reset. Vendor stock re-seeded." });
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    private static async Task<Azure.Storage.Queues.QueueClient> GetQueueClientAsync()
    {
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
        return client;
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
