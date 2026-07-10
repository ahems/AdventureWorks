using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Queues;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Extensions.Sql;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// SQL change-tracking trigger that fires when new rows are inserted into
/// Sales.SalesOrderHeader (i.e. a customer places an order).
///
/// This is the server-side replacement for the two fire-and-forget HTTP calls
/// that OrderConfirmationPage.tsx used to make after checkout:
///   - POST /api/orders/generate-and-send-receipt
///   - POST /api/orders/begin-processing-order
///
/// On each INSERT the function:
///   1. Enqueues a receipt-generation + email job on <c>order-receipt-generation</c>
///   2. Enqueues an order-status pipeline job on <c>sales-order-status</c>
///   3. Fire-and-forgets the Manufacturing Agent via <see cref="ManufacturingAgentService"/>
/// </summary>
public class OrderPlacedSqlTrigger
{
    private const string ReceiptQueueName = "order-receipt-generation";
    private const string StatusQueueName = "sales-order-status";

    private readonly ILogger<OrderPlacedSqlTrigger> _logger;
    private readonly OrderService _orderService;
    private readonly ManufacturingAgentService _manufacturingAgentService;
    private readonly OrderPipelineConfigService _pipelineConfig;

    public OrderPlacedSqlTrigger(
        ILogger<OrderPlacedSqlTrigger> logger,
        OrderService orderService,
        ManufacturingAgentService manufacturingAgentService,
        OrderPipelineConfigService pipelineConfig)
    {
        _logger = logger;
        _orderService = orderService;
        _manufacturingAgentService = manufacturingAgentService;
        _pipelineConfig = pipelineConfig;
    }

    [Function(nameof(OrderPlacedSqlTrigger))]
    public async Task RunAsync(
        [SqlTrigger("[Sales].[SalesOrderHeader]", "SQL_CONNECTION_STRING")]
        IReadOnlyList<SqlChange<SalesOrderHeaderRow>> changes)
    {
        foreach (var change in changes.Where(c => c.Operation == SqlChangeOperation.Insert))
        {
            var order = change.Item;
            _logger.LogInformation(
                "SQL trigger: new order SalesOrderID={SalesOrderId}, CustomerID={CustomerId}",
                order.SalesOrderID, order.CustomerID);

            try
            {
                await EnqueueReceiptAndStatusAsync(order.SalesOrderID);
                _manufacturingAgentService.InvokeFireAndForget(order.SalesOrderID, order.CustomerID);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "Error processing SQL trigger for SalesOrderID={SalesOrderId}",
                    order.SalesOrderID);
            }
        }
    }

    private async Task EnqueueReceiptAndStatusAsync(int salesOrderId)
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

        // --- Receipt generation queue -------------------------------------------
        // Look up the customer's primary email address ID from SQL.
        // If no email is found, the receipt PDF is still generated but no email is sent.
        var emailInfo = await _orderService.GetCustomerEmailInfoBySalesOrderIdAsync(salesOrderId);

        var receiptQueueClient = queueServiceClient.GetQueueClient(ReceiptQueueName);
        await receiptQueueClient.CreateIfNotExistsAsync();

        var salesOrderNumber = $"SO{salesOrderId}";
        var receiptMessage = JsonSerializer.Serialize(new
        {
            SalesOrderNumber = salesOrderNumber,
            EmailMetadata = emailInfo.HasValue
                ? new
                {
                    CustomerId = emailInfo.Value.CustomerId,
                    EmailAddressId = emailInfo.Value.EmailAddressId,
                    SalesOrderId = salesOrderId
                }
                : (object?)null
        });
        await receiptQueueClient.SendMessageAsync(receiptMessage);
        _logger.LogInformation(
            "Enqueued receipt generation for SalesOrderID={SalesOrderId} (emailInfo={HasEmail})",
            salesOrderId, emailInfo.HasValue);

        // --- Order status pipeline queue ----------------------------------------
        // Read configurable timing from the pipeline config service.
        var statusQueueClient = queueServiceClient.GetQueueClient(StatusQueueName);
        await statusQueueClient.CreateIfNotExistsAsync();

        var statusMessage = JsonSerializer.Serialize(new { SalesOrderID = salesOrderId, Status = 1 });
        var cfg = await _pipelineConfig.GetConfigAsync();
        var minMin = (double)cfg.ProcessingToApprovedMinMinutes;
        var maxMin = (double)cfg.ProcessingToApprovedMaxMinutes;
        var visibilityMinutes = minMin + (maxMin - minMin) * Random.Shared.NextDouble();
        await statusQueueClient.SendMessageAsync(
            statusMessage,
            visibilityTimeout: TimeSpan.FromMinutes(visibilityMinutes),
            timeToLive: null);
        _logger.LogInformation(
            "Enqueued order status pipeline for SalesOrderID={SalesOrderId}, visibility={Minutes:F1} min (config: {Min}-{Max} min)",
            salesOrderId, visibilityMinutes, minMin, maxMin);
    }
}

/// <summary>
/// Minimal column projection of <c>Sales.SalesOrderHeader</c> for the SQL trigger payload.
/// Only columns declared here are deserialized; all others are ignored.
/// </summary>
public class SalesOrderHeaderRow
{
    public int SalesOrderID { get; set; }
    public int CustomerID { get; set; }
}
