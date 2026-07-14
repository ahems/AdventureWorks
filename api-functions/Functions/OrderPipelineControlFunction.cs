using System.Net;
using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Queues;
using Dapper;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP control surface for the sales-order status pipeline.
///
/// GET  /api/orders/pipeline/config           — current timing configuration
/// PUT  /api/orders/pipeline/config           — update timing configuration
/// GET  /api/orders/pipeline/status           — per-status order counts
/// POST /api/orders/pipeline/promote-pending  — enqueue all Status=1 orders → Status=2 (immediate)
/// POST /api/orders/pipeline/promote-approved — enqueue all Status=2+3 orders → Status=5 (immediate)
/// </summary>
public class OrderPipelineControlFunction
{
    private const string StatusQueueName = "sales-order-status";

    private readonly ILogger<OrderPipelineControlFunction> _logger;
    private readonly OrderPipelineConfigService _config;
    private readonly string _connectionString;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy        = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    public OrderPipelineControlFunction(
        ILogger<OrderPipelineControlFunction> logger,
        OrderPipelineConfigService config,
        IConfiguration configuration)
    {
        _logger           = logger;
        _config           = config;
        _connectionString = configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured.");
    }

    // ── GET config ───────────────────────────────────────────────────────────

    [Function("OrderPipeline_GetConfig")]
    public async Task<HttpResponseData> GetConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/pipeline/config")]
        HttpRequestData req)
    {
        var cfg  = await _config.GetConfigAsync();
        var resp = req.CreateResponse(HttpStatusCode.OK);
        resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await resp.WriteStringAsync(JsonSerializer.Serialize(new
        {
            processingToApprovedMinMinutes    = cfg.ProcessingToApprovedMinMinutes,
            processingToApprovedMaxMinutes    = cfg.ProcessingToApprovedMaxMinutes,
            approvedToShippedMinHours         = cfg.ApprovedToShippedMinHours,
            approvedToShippedMaxHours         = cfg.ApprovedToShippedMaxHours,
            shippedToDeliveredMinDaysB2C      = cfg.ShippedToDeliveredMinDaysB2C,
            shippedToDeliveredMaxDaysB2C      = cfg.ShippedToDeliveredMaxDaysB2C,
            shippedToDeliveredMinDaysB2B      = cfg.ShippedToDeliveredMinDaysB2B,
            shippedToDeliveredMaxDaysB2B      = cfg.ShippedToDeliveredMaxDaysB2B,
        }, JsonOpts));
        return resp;
    }

    // ── PUT config ───────────────────────────────────────────────────────────

    [Function("OrderPipeline_PutConfig")]
    public async Task<HttpResponseData> PutConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "orders/pipeline/config")]
        HttpRequestData req)
    {
        OrderPipelineConfigRequest? input;
        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            input = JsonSerializer.Deserialize<OrderPipelineConfigRequest>(body, JsonOpts);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[PipelineConfig] Invalid request body.");
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteStringAsync("{\"error\":\"Invalid JSON body.\"}");
            return bad;
        }

        if (input is null ||
            input.ProcessingToApprovedMinMinutes < 1 || input.ProcessingToApprovedMaxMinutes > 1440 ||
            input.ProcessingToApprovedMinMinutes > input.ProcessingToApprovedMaxMinutes ||
            input.ApprovedToShippedMinHours < 0 || input.ApprovedToShippedMaxHours > 168 ||
            input.ApprovedToShippedMinHours > input.ApprovedToShippedMaxHours ||
            input.ShippedToDeliveredMinDaysB2C < 1 || input.ShippedToDeliveredMaxDaysB2C > 30 ||
            input.ShippedToDeliveredMinDaysB2C > input.ShippedToDeliveredMaxDaysB2C ||
            input.ShippedToDeliveredMinDaysB2B < 1 || input.ShippedToDeliveredMaxDaysB2B > 30 ||
            input.ShippedToDeliveredMinDaysB2B > input.ShippedToDeliveredMaxDaysB2B)
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteStringAsync(
                "{\"error\":\"Invalid values. Min must be <= max. processingToApproved: 1\u20131440 min. approvedToShipped: 0\u2013168 h. shippedToDelivered: 1\u201330 days.\"}" );
            return bad;
        }

        var cfg = new OrderPipelineConfig(
            input.ProcessingToApprovedMinMinutes,
            input.ProcessingToApprovedMaxMinutes,
            input.ApprovedToShippedMinHours,
            input.ApprovedToShippedMaxHours,
            input.ShippedToDeliveredMinDaysB2C,
            input.ShippedToDeliveredMaxDaysB2C,
            input.ShippedToDeliveredMinDaysB2B,
            input.ShippedToDeliveredMaxDaysB2B);

        await _config.SaveConfigAsync(cfg);

        var resp = req.CreateResponse(HttpStatusCode.OK);
        resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await resp.WriteStringAsync(JsonSerializer.Serialize(new
        {
            processingToApprovedMinMinutes    = cfg.ProcessingToApprovedMinMinutes,
            processingToApprovedMaxMinutes    = cfg.ProcessingToApprovedMaxMinutes,
            approvedToShippedMinHours         = cfg.ApprovedToShippedMinHours,
            approvedToShippedMaxHours         = cfg.ApprovedToShippedMaxHours,
            shippedToDeliveredMinDaysB2C      = cfg.ShippedToDeliveredMinDaysB2C,
            shippedToDeliveredMaxDaysB2C      = cfg.ShippedToDeliveredMaxDaysB2C,
            shippedToDeliveredMinDaysB2B      = cfg.ShippedToDeliveredMinDaysB2B,
            shippedToDeliveredMaxDaysB2B      = cfg.ShippedToDeliveredMaxDaysB2B,
            message = "Configuration saved.",
        }, JsonOpts));
        return resp;
    }

    // ── GET status counts ────────────────────────────────────────────────────

    [Function("OrderPipeline_GetStatus")]
    public async Task<HttpResponseData> GetStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/pipeline/status")]
        HttpRequestData req)
    {
        using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Active pipeline statuses (all time) + terminal statuses for last 7 days
        var rows = await conn.QueryAsync(@"
            SELECT
                Status,
                COUNT(*)       AS OrderCount,
                SUM(TotalDue)  AS TotalValue
            FROM Sales.SalesOrderHeader
            WHERE Status IN (1, 2, 3)
               OR (Status IN (4, 5, 6, 7) AND OrderDate >= DATEADD(day, -7, GETDATE()))
            GROUP BY Status
            ORDER BY Status", commandTimeout: 30);

        var statusMap = rows.ToDictionary(
            r => (int)r.Status,
            r => new { orderCount = (int)r.OrderCount, totalValue = Math.Round((decimal)r.TotalValue, 2) });

        var resp = req.CreateResponse(HttpStatusCode.OK);
        resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await resp.WriteStringAsync(JsonSerializer.Serialize(new
        {
            inProcess    = statusMap.TryGetValue(1, out var s1) ? s1 : new { orderCount = 0, totalValue = 0m },
            approved     = statusMap.TryGetValue(2, out var s2) ? s2 : new { orderCount = 0, totalValue = 0m },
            backordered  = statusMap.TryGetValue(3, out var s3) ? s3 : new { orderCount = 0, totalValue = 0m },
            rejected     = statusMap.TryGetValue(4, out var s4) ? s4 : new { orderCount = 0, totalValue = 0m },
            shipped      = statusMap.TryGetValue(5, out var s5) ? s5 : new { orderCount = 0, totalValue = 0m },
            cancelled    = statusMap.TryGetValue(6, out var s6) ? s6 : new { orderCount = 0, totalValue = 0m },
            delivered    = statusMap.TryGetValue(7, out var s7) ? s7 : new { orderCount = 0, totalValue = 0m },
            note         = "Rejected/Shipped/Cancelled/Delivered counts reflect last 7 days only.",
        }, JsonOpts));
        return resp;
    }

    // ── POST promote-pending (Status=1 → Status=2 immediate) ─────────────────

    [Function("OrderPipeline_PromotePending")]
    public async Task<HttpResponseData> PromotePending(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/pipeline/promote-pending")]
        HttpRequestData req)
    {
        using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var orderIds = (await conn.QueryAsync<int>(
            "SELECT SalesOrderID FROM Sales.SalesOrderHeader WHERE Status = 1",
            commandTimeout: 30)).ToList();

        if (orderIds.Count == 0)
        {
            var empty = req.CreateResponse(HttpStatusCode.OK);
            await empty.WriteStringAsync("{\"promoted\":0,\"message\":\"No In Process orders to promote.\"}");
            return empty;
        }

        var queueClient = await GetQueueClientAsync();
        foreach (var id in orderIds)
        {
            var message = JsonSerializer.Serialize(new { SalesOrderID = id, Status = 2 });
            await queueClient.SendMessageAsync(message);  // immediate (no visibility delay)
        }

        _logger.LogInformation("[Pipeline] Promoted {Count} In Process orders → Approved (Status=2).", orderIds.Count);

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteStringAsync(
            JsonSerializer.Serialize(new { promoted = orderIds.Count, message = $"Enqueued {orderIds.Count} order(s) for immediate approval." }, JsonOpts));
        return resp;
    }

    // ── POST promote-approved (Status=2,3 → Status=5 immediate) ─────────────

    [Function("OrderPipeline_PromoteApproved")]
    public async Task<HttpResponseData> PromoteApproved(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/pipeline/promote-approved")]
        HttpRequestData req)
    {
        using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var orderIds = (await conn.QueryAsync<int>(
            "SELECT SalesOrderID FROM Sales.SalesOrderHeader WHERE Status IN (2, 3)",
            commandTimeout: 30)).ToList();

        if (orderIds.Count == 0)
        {
            var empty = req.CreateResponse(HttpStatusCode.OK);
            await empty.WriteStringAsync("{\"promoted\":0,\"message\":\"No Approved or Backordered orders to ship.\"}");
            return empty;
        }

        var queueClient = await GetQueueClientAsync();
        foreach (var id in orderIds)
        {
            var message = JsonSerializer.Serialize(new { SalesOrderID = id, Status = 5 });
            await queueClient.SendMessageAsync(message);  // immediate
        }

        _logger.LogInformation("[Pipeline] Promoted {Count} Approved/Backordered orders → Shipped (Status=5).", orderIds.Count);

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteStringAsync(
            JsonSerializer.Serialize(new { promoted = orderIds.Count, message = $"Enqueued {orderIds.Count} order(s) for immediate shipment." }, JsonOpts));
        return resp;
    }

    // ── Queue client helper ───────────────────────────────────────────────────

    private static async Task<QueueClient> GetQueueClientAsync()
    {
        var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        if (string.IsNullOrEmpty(queueServiceUri))
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName is not configured.");
            queueServiceUri = $"https://{accountName}.queue.core.windows.net";
        }

        var queueServiceClient = new QueueServiceClient(
            new Uri(queueServiceUri),
            new DefaultAzureCredential(),
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });

        var queueClient = queueServiceClient.GetQueueClient(StatusQueueName);
        await queueClient.CreateIfNotExistsAsync();
        return queueClient;
    }
}

// ── DTO ───────────────────────────────────────────────────────────────────────

file class OrderPipelineConfigRequest
{
    public int ProcessingToApprovedMinMinutes { get; set; }
    public int ProcessingToApprovedMaxMinutes { get; set; }
    public int ApprovedToShippedMinHours      { get; set; }
    public int ApprovedToShippedMaxHours      { get; set; }
    public int ShippedToDeliveredMinDaysB2C   { get; set; } = 3;
    public int ShippedToDeliveredMaxDaysB2C   { get; set; } = 7;
    public int ShippedToDeliveredMinDaysB2B   { get; set; } = 5;
    public int ShippedToDeliveredMaxDaysB2B   { get; set; } = 10;
}
