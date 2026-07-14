using System.Text.Json;
using Azure.Storage.Queues;
using Azure.Identity;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Processes sales order status messages from the queue.
/// The initial status-1 message is now enqueued server-side by <see cref="OrderPlacedSqlTrigger"/>.
/// </summary>
public class ProcessSalesOrderStatus
{
    private const string QueueName = "sales-order-status";
    private readonly ILogger<ProcessSalesOrderStatus> _logger;
    private readonly OrderService _orderService;
    private readonly EmailService _emailService;
    private readonly BankService _bankService;
    private readonly OrderPipelineConfigService _pipelineConfig;
    private readonly WarehouseService? _warehouse;
    private readonly bool _emailEnabled;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public ProcessSalesOrderStatus(
        ILogger<ProcessSalesOrderStatus> logger,
        OrderService orderService,
        EmailService emailService,
        BankService bankService,
        OrderPipelineConfigService pipelineConfig,
        WarehouseService? warehouse = null)
    {
        _logger = logger;
        _orderService = orderService;
        _emailService = emailService;
        _bankService = bankService;
        _pipelineConfig = pipelineConfig;
        _warehouse = warehouse;
        _emailEnabled = string.Equals(
            Environment.GetEnvironmentVariable("ORDER_NOTIFICATIONS_EMAIL_ENABLED"),
            "true", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Queue trigger: parses message, updates DB, optionally sends shipped email, and re-queues with next status and visibility.
    /// </summary>
    [Function(nameof(ProcessSalesOrderStatus_QueueTrigger))]
    public async Task ProcessSalesOrderStatus_QueueTrigger(
        [QueueTrigger(QueueName, Connection = "AzureWebJobsStorage")] BinaryData queueMessage)
    {
        SalesOrderStatusMessage? msg;
        try
        {
            msg = JsonSerializer.Deserialize<SalesOrderStatusMessage>(queueMessage.ToString(), JsonOptions);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Invalid queue message (invalid JSON). Message will retry or go to poison queue.");
            throw;
        }

        if (msg == null || msg.SalesOrderID <= 0)
        {
            _logger.LogWarning("Invalid queue message: missing or invalid SalesOrderID. Skipping.");
            return;
        }

        int salesOrderId = msg.SalesOrderID;
        int status = msg.Status;

        _logger.LogInformation("Processing SalesOrderID={SalesOrderId}, Status={Status}", salesOrderId, status);

        // Warehouse pick-ready intercept: order has been approved and the pick-delay has elapsed.
        // Hand off to the warehouse service — it will re-enqueue Status=5 when all items are picked.
        if (status == 2 && msg.WarehousePickReady && _warehouse != null)
        {
            _logger.LogInformation("SalesOrderID={SalesOrderId} WarehousePickReady — handing off to warehouse pick", salesOrderId);
            await _warehouse.EnqueueRetrieveOperationsForOrderAsync(salesOrderId);
            return; // Warehouse gates shipment — no further re-queuing here
        }

        // Terminal statuses: update DB only, send email if Shipped, do not re-queue
        if (status == 4 || status == 5 || status == 6 || status == 7)
        {
            var rows = await _orderService.UpdateOrderStatusAsync(salesOrderId, (byte)status);
            if (rows == 0)
            {
                _logger.LogWarning("Order not found. SalesOrderID={SalesOrderId}. Stopping processing (e.g. order may have been removed by seed job).", salesOrderId);
                return;
            }
            if (status == 5)
            {
                await SendShippedEmailAsync(salesOrderId);
                await RecordSaleBankCreditAsync(salesOrderId);
            }
            _logger.LogInformation("Terminal status {Status} applied for SalesOrderID={SalesOrderId}", status, salesOrderId);
            return;
        }

        // Backordered (Status 3) re-queued message: next step is Shipped (5)
        if (status == 3)
        {
            var rows = await _orderService.UpdateOrderStatusAsync(salesOrderId, 5);
            if (rows == 0)
            {
                _logger.LogWarning("Order not found. SalesOrderID={SalesOrderId}. Stopping processing (e.g. order may have been removed by seed job).", salesOrderId);
                return;
            }
            await SendShippedEmailAsync(salesOrderId);
            await RecordSaleBankCreditAsync(salesOrderId);
            _logger.LogInformation("Backordered order moved to Shipped for SalesOrderID={SalesOrderId}", salesOrderId);
            return;
        }

        // Compute next status for 1 (In Process) or 2 (Approved)
        int nextStatus;
        if (status == 1)
            nextStatus = Random.Shared.NextDouble() < 0.05 ? 4 : 2; // 5% Rejected, 95% Approved
        else if (status == 2)
            nextStatus = Random.Shared.NextDouble() < 0.10 ? 3 : 5; // 10% Backordered, 90% Shipped
        else
        {
            _logger.LogWarning("Unexpected status {Status} for SalesOrderID={SalesOrderId}. Skipping re-queue.", status, salesOrderId);
            return;
        }

        var updated = await _orderService.UpdateOrderStatusAsync(salesOrderId, (byte)nextStatus);
        if (updated == 0)
        {
            _logger.LogWarning("Order not found. SalesOrderID={SalesOrderId}. Stopping processing (e.g. order may have been removed by seed job).", salesOrderId);
            return;
        }

        if (nextStatus == 5)
        {
            await SendShippedEmailAsync(salesOrderId);
            await RecordSaleBankCreditAsync(salesOrderId);
            _logger.LogInformation("Order Shipped for SalesOrderID={SalesOrderId}", salesOrderId);
            return;
        }

        if (nextStatus == 3)
        {
            var visibilityDays = 2 + (2 * Random.Shared.NextDouble());
            var visibility = TimeSpan.FromDays(visibilityDays);
            await RequeueAsync(salesOrderId, 3, visibility);
            _logger.LogInformation("Order Backordered for SalesOrderID={SalesOrderId}, re-queued with visibility {Days:F1} days", salesOrderId, visibility.TotalDays);
            return;
        }

        // nextStatus == 2 (Approved): schedule the warehouse pick delay then hand off
        var cfg = await _pipelineConfig.GetConfigAsync();
        var minHours = (double)cfg.ApprovedToShippedMinHours;
        var maxHours = (double)cfg.ApprovedToShippedMaxHours;
        var delayHours = minHours + (maxHours - minHours) * Random.Shared.NextDouble();
        var visibilityApproved = TimeSpan.FromHours(Math.Max(delayHours, 0));

        if (_warehouse != null)
        {
            // Gate shipping on warehouse pick completion.
            // After the configured delay, the message re-surfaces with WarehousePickReady=true
            // and the warehouse service is invoked to retrieve all order items.
            await RequeueAsync(salesOrderId, 2, visibilityApproved, pendingWarehousePick: true);
            _logger.LogInformation(
                "Order Approved→WarehousePick for SalesOrderID={SalesOrderId}, pick delay {Hours:F1} h",
                salesOrderId, visibilityApproved.TotalHours);
        }
        else
        {
            await RequeueAsync(salesOrderId, 2, visibilityApproved);
            _logger.LogInformation("Order Approved for SalesOrderID={SalesOrderId}, re-queued with visibility {Hours:F1} h (config: {Min}-{Max} h)",
                salesOrderId, visibilityApproved.TotalHours, minHours, maxHours);
        }
    }

    private async Task RecordSaleBankCreditAsync(int salesOrderId)
    {
        try
        {
            await _bankService.InitializeAsync();
            var financials = await _orderService.GetOrderSaleFinancialsAsync(salesOrderId);
            if (financials == null)
            {
                _logger.LogWarning("[Bank] Could not resolve financials for SalesOrderID={SalesOrderId} — skipping bank credit.", salesOrderId);
                return;
            }

            // Build a description that explains exactly what was included/excluded.
            string description;
            if (financials.FreightUsd > 0m)
            {
                // Customer paid shipping — freight is a pass-through, tax excluded.
                description = $"Order SO-{salesOrderId} shipped — net proceeds (SubTotal excl. tax; freight pass-through)";
            }
            else
            {
                // Free shipping was given — deduct estimated shipping cost from proceeds.
                description = $"Order SO-{salesOrderId} shipped — net proceeds (SubTotal excl. tax; free-shipping cost est. {financials.FreeShippingDeductionUsd:N2} USD deducted)";
            }

            await _bankService.PostTransactionAsync(new BankTransactionRequest(
                CurrencyCode:    financials.CurrencyCode,
                Amount:          financials.NetAmount,
                Description:     description,
                ReferenceId:     $"SO-{salesOrderId}",
                TransactionType: "sale"));

            _logger.LogInformation(
                "[Bank] Credited {Currency} {NetAmount:N2} for SalesOrderID={SalesOrderId} " +
                "(SubTotal={SubTotal:N2} USD, Tax={Tax:N2} USD excluded, Freight={Freight:N2} USD, FreeShippingDeduction={FreeShipDeduction:N2} USD, Lines={Lines})",
                financials.CurrencyCode, financials.NetAmount, salesOrderId,
                financials.SubTotalUsd, financials.TaxAmtUsd, financials.FreightUsd,
                financials.FreeShippingDeductionUsd, financials.LineCount);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Bank] Non-fatal: failed to record bank credit for SalesOrderID={SalesOrderId}", salesOrderId);
        }
    }

    private async Task SendShippedEmailAsync(int salesOrderId)
    {
        const string subject = "Your order has pretend-shipped – demo";
        const string body = "This is a demo. Your order has been marked as shipped. Thank you for using Adventure Works.";

        if (!_emailEnabled)
        {
            _logger.LogInformation(
                "[EmailNotifications disabled] Shipped email suppressed for SalesOrderID={SalesOrderId}. Subject: '{Subject}' Body: '{Body}'",
                salesOrderId, subject, body);
            return;
        }

        var emailInfo = await _orderService.GetCustomerEmailInfoBySalesOrderIdAsync(salesOrderId);
        if (emailInfo == null)
        {
            _logger.LogWarning("Could not find customer email for SalesOrderID={SalesOrderId}. Skipping shipped email.", salesOrderId);
            return;
        }

        var sent = await _emailService.SendCustomerEmailAsync(
            emailInfo.Value.CustomerId,
            emailInfo.Value.EmailAddressId,
            subject,
            body,
            attachmentUrl: null);
        if (sent)
            _logger.LogInformation("Shipped email sent for SalesOrderID={SalesOrderId}", salesOrderId);
        else
            _logger.LogWarning("Shipped email failed for SalesOrderID={SalesOrderId}", salesOrderId);
    }

    private async Task RequeueAsync(int salesOrderId, int status, TimeSpan visibilityTimeout,
        bool pendingWarehousePick = false)
    {
        if (pendingWarehousePick && _warehouse != null)
        {
            // Instead of re-queuing status=2 again, wait for the visibility delay then
            // kick off warehouse pick. We achieve the delay by re-queuing a special marker
            // that the queue processor interprets as "time to pick now".
            // Simplest approach: re-queue status=2 with same delay; on next processing
            // the status==2 branch now routes to warehouse instead of shipping directly.
            // To avoid looping, we mark the message differently — use a dedicated
            // "warehouse-pick-ready" flag by checking if warehouse is available when
            // status==2 is re-processed (it will call EnqueueRetrieveOperationsForOrderAsync
            // and NOT re-queue status=2 again, breaking the loop).
            // The "pendingWarehousePick" path: enqueue with the configured delay so the
            // warehouse pick starts after pick-prep time has elapsed.
            var queueClient = await GetQueueClientAsync();
            // Re-enqueue with status=2 and the visibility delay; next time it processes,
            // warehouse != null so it will call EnqueueRetrieveOperationsForOrderAsync
            // and then return without further re-queuing (the warehouse gates status=5).
            var message = JsonSerializer.Serialize(new { SalesOrderID = salesOrderId, Status = 2, WarehousePickReady = true });
            await queueClient.SendMessageAsync(message, visibilityTimeout: visibilityTimeout, timeToLive: null);
            return;
        }

        var qc = await GetQueueClientAsync();
        var msg = JsonSerializer.Serialize(new { SalesOrderID = salesOrderId, Status = status });
        await qc.SendMessageAsync(msg, visibilityTimeout: visibilityTimeout, timeToLive: null);
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
        var queueClient = queueServiceClient.GetQueueClient(QueueName);
        await queueClient.CreateIfNotExistsAsync();
        return queueClient;
    }

    private class SalesOrderStatusMessage
    {
        public int SalesOrderID { get; set; }
        public int Status { get; set; }
        public bool WarehousePickReady { get; set; }
    }

}
