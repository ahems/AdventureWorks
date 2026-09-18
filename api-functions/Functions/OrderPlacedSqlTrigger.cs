using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Queues;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Extensions.Sql;
using Microsoft.Extensions.Logging;
using api_functions.Models;
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
///   3. Creates a pending agent run record and enqueues to <c>manufacturing-agent-queue</c>
/// </summary>
public class OrderPlacedSqlTrigger
{
    private const string ReceiptQueueName = "order-receipt-generation";
    private const string StatusQueueName  = "sales-order-status";
    private const string AutoPromotionQueueName = "auto-promotion-queue";

    private readonly ILogger<OrderPlacedSqlTrigger>  _logger;
    private readonly OrderService                     _orderService;
    private readonly ManufacturingAgentConfigService  _agentConfig;
    private readonly ManufacturingAgentRunService     _runService;
    private readonly OrderPipelineConfigService       _pipelineConfig;
    private readonly WebPubSubService                 _webPubSub;
    private readonly AutoPromotionConfigService       _autoPromoConfig;

    public OrderPlacedSqlTrigger(
        ILogger<OrderPlacedSqlTrigger> logger,
        OrderService orderService,
        ManufacturingAgentConfigService agentConfig,
        ManufacturingAgentRunService runService,
        OrderPipelineConfigService pipelineConfig,
        WebPubSubService webPubSub,
        AutoPromotionConfigService autoPromoConfig)
    {
        _logger          = logger;
        _orderService    = orderService;
        _agentConfig     = agentConfig;
        _runService      = runService;
        _pipelineConfig  = pipelineConfig;
        _webPubSub       = webPubSub;
        _autoPromoConfig = autoPromoConfig;
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
                await EnqueueManufacturingAgentAsync(order.SalesOrderID, order.CustomerID);
                await CheckAutoPromotionThresholdAsync(order.OnlineOrderFlag);
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

    /// <summary>
    /// Creates a pending agent run record and enqueues a message to the manufacturing-agent-queue.
    /// The queue trigger (<see cref="ManufacturingAgentQueueTrigger"/>) picks it up and invokes
    /// the hosted agent, with exponential-backoff retries on rate-limit failures.
    /// </summary>
    private async Task EnqueueManufacturingAgentAsync(int salesOrderId, int customerId)
    {
        // Create a pending run record first so the UI shows it immediately
        var mode  = await _agentConfig.GetModeAsync();

        // Off mode: skip entirely — no queue message, no run record, no token consumption.
        if (mode == ManufacturingAgentMode.Off)
        {
            _logger.LogDebug(
                "Manufacturing agent is Off — skipping enqueue for SalesOrderID={SalesOrderId}.",
                salesOrderId);
            return;
        }

        var runId = await _runService.CreateRunAsync(salesOrderId, customerId, mode);

        var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        if (string.IsNullOrEmpty(queueServiceUri))
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
            queueServiceUri = $"https://{accountName}.queue.core.windows.net";
        }

        var queueSvcClient = new QueueServiceClient(new Uri(queueServiceUri), new DefaultAzureCredential(),
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
        var agentQueue     = queueSvcClient.GetQueueClient(ManufacturingAgentRunService.QueueName);

        var msgPayload = JsonSerializer.Serialize(
            new ManufacturingAgentQueueMessage(salesOrderId, customerId, runId, RetryCount: 0),
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

        await agentQueue.SendMessageAsync(msgPayload);

        _logger.LogInformation(
            "Enqueued manufacturing agent job for SalesOrderID={SalesOrderId}, RunId={RunId}, Mode={Mode}",
            salesOrderId, runId, mode);

        await _webPubSub.SendToGroupAsync("orders", new { @event = "order-placed", salesOrderId, customerId });
        await _webPubSub.SendToGroupAsync("manufacturing-agent", new { @event = "run-created", runId, salesOrderId });
    }

    private async Task CheckAutoPromotionThresholdAsync(bool onlineOrderFlag)
    {
        try
        {
            var (triggered, orderType) = await _autoPromoConfig.IncrementCounterAndCheckThresholdAsync(onlineOrderFlag);
            if (!triggered) return;

            var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
            if (string.IsNullOrEmpty(queueServiceUri))
            {
                var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                    ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
                queueServiceUri = $"https://{accountName}.queue.core.windows.net";
            }

            var queueSvcClient = new QueueServiceClient(new Uri(queueServiceUri), new DefaultAzureCredential(),
                new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
            var queue = queueSvcClient.GetQueueClient(AutoPromotionQueueName);

            var msg = JsonSerializer.Serialize(new { orderType });
            await queue.SendMessageAsync(Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(msg)));

            _logger.LogInformation("[AutoPromotion] Threshold met for {OrderType} — enqueued generation job.", orderType);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AutoPromotion] Failed to check/enqueue auto-promotion threshold.");
        }
    }
}

public class SalesOrderHeaderRow
{
    public int SalesOrderID { get; set; }
    public int CustomerID { get; set; }
    public bool OnlineOrderFlag { get; set; }
}
