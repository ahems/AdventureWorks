using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Queues;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// HTTP entry-points for manually advancing sales order status.
///
/// Both endpoints enqueue a message onto the <c>sales-order-status</c> queue so that
/// <see cref="ProcessSalesOrderStatus.ProcessSalesOrderStatus_QueueTrigger"/> handles
/// the actual DB update, shipped-email, and bank-credit recording — keeping all
/// side-effects in one place and preserving the queue-driven automation pipeline.
/// </summary>
public class OrderStatusFunctions
{
    private const string StatusQueueName = "sales-order-status";

    private readonly ILogger<OrderStatusFunctions> _logger;

    public OrderStatusFunctions(ILogger<OrderStatusFunctions> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Enqueues a Status=1 (In Process) message so the order enters the
    /// automated status pipeline. A random 5–60 minute visibility timeout
    /// matches the original behaviour of the now-removed HTTP trigger.
    ///
    /// Route: POST /api/orders/begin-processing-order
    /// Body:  { "salesOrderId": &lt;int&gt; }  (camelCase or PascalCase)
    /// </summary>
    [Function(nameof(BeginProcessingOrder))]
    public async Task<HttpResponseData> BeginProcessingOrder(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/begin-processing-order")] HttpRequestData req)
    {
        _logger.LogInformation("BeginProcessingOrder triggered");

        int salesOrderId;
        try
        {
            using var body = await JsonDocument.ParseAsync(req.Body);
            salesOrderId = body.RootElement.TryGetProperty("salesOrderId", out var lower)
                ? lower.GetInt32()
                : body.RootElement.GetProperty("SalesOrderID").GetInt32();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "BeginProcessingOrder: invalid request body");
            var bad = req.CreateResponse(System.Net.HttpStatusCode.BadRequest);
            await bad.WriteStringAsync("{\"error\":\"salesOrderId is required\"}");
            return bad;
        }

        if (salesOrderId <= 0)
        {
            var bad = req.CreateResponse(System.Net.HttpStatusCode.BadRequest);
            await bad.WriteStringAsync("{\"error\":\"salesOrderId must be a positive integer\"}");
            return bad;
        }

        var queueClient = await GetQueueClientAsync();
        var message = JsonSerializer.Serialize(new { SalesOrderID = salesOrderId, Status = 1 });
        var visibilityMinutes = 5 + 55 * Random.Shared.NextDouble();
        await queueClient.SendMessageAsync(
            message,
            visibilityTimeout: TimeSpan.FromMinutes(visibilityMinutes),
            timeToLive: null);

        _logger.LogInformation(
            "BeginProcessingOrder: enqueued SalesOrderID={SalesOrderId}, visibility={Minutes:F1} min",
            salesOrderId, visibilityMinutes);

        var response = req.CreateResponse(System.Net.HttpStatusCode.Accepted);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync(
            $"{{\"message\":\"Order SO{salesOrderId} queued for processing\",\"salesOrderId\":{salesOrderId}}}");
        return response;
    }

    /// <summary>
    /// Immediately ships a sales order by enqueueing a terminal Status=5 (Shipped)
    /// message with no visibility delay. The queue trigger handles DB update,
    /// shipped-notification email, and bank-credit recording automatically.
    ///
    /// Route: POST /api/orders/{salesOrderId}/ship
    /// </summary>
    [Function(nameof(ShipOrder))]
    public async Task<HttpResponseData> ShipOrder(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/{salesOrderId:int}/ship")] HttpRequestData req,
        int salesOrderId)
    {
        _logger.LogInformation("ShipOrder triggered for SalesOrderID={SalesOrderId}", salesOrderId);

        if (salesOrderId <= 0)
        {
            var bad = req.CreateResponse(System.Net.HttpStatusCode.BadRequest);
            await bad.WriteStringAsync("{\"error\":\"salesOrderId must be a positive integer\"}");
            return bad;
        }

        var queueClient = await GetQueueClientAsync();
        // No visibility timeout: the queue trigger processes this immediately
        // so the DB is updated and shipped email + bank credit fire promptly.
        var message = JsonSerializer.Serialize(new { SalesOrderID = salesOrderId, Status = 5 });
        await queueClient.SendMessageAsync(message);

        _logger.LogInformation("ShipOrder: enqueued Status=5 for SalesOrderID={SalesOrderId}", salesOrderId);

        var response = req.CreateResponse(System.Net.HttpStatusCode.Accepted);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync(
            $"{{\"message\":\"Order SO{salesOrderId} queued for shipment\",\"salesOrderId\":{salesOrderId}}}");
        return response;
    }

    private static async Task<QueueClient> GetQueueClientAsync()
    {
        var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        if (string.IsNullOrEmpty(queueServiceUri))
        {
            var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
            queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
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
