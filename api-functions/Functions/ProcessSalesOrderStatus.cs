using System.Net;
using System.Text.Json;
using Azure.Storage.Queues;
using Azure.Identity;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Processes sales order status messages from the queue and provides HTTP entry point to begin processing.
/// </summary>
public class ProcessSalesOrderStatus
{
    private const string QueueName = "sales-order-status";
    private readonly ILogger<ProcessSalesOrderStatus> _logger;
    private readonly OrderService _orderService;
    private readonly EmailService _emailService;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public ProcessSalesOrderStatus(
        ILogger<ProcessSalesOrderStatus> logger,
        OrderService orderService,
        EmailService emailService)
    {
        _logger = logger;
        _orderService = orderService;
        _emailService = emailService;
    }

    /// <summary>
    /// HTTP trigger to start order status processing. Enqueues first message with Status 1 and visibility 5–60 minutes.
    /// </summary>
    [Function(nameof(BeginProcessingOrder))]
    public async Task<HttpResponseData> BeginProcessingOrder(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/begin-processing-order")] HttpRequestData req)
    {
        try
        {
            string requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var request = JsonSerializer.Deserialize<BeginProcessingOrderRequest>(requestBody, JsonOptions);
            var salesOrderId = request?.SalesOrderId ?? request?.SalesOrderID ?? 0;

            if (salesOrderId <= 0)
            {
                var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequest.WriteAsJsonAsync(new { error = "salesOrderId must be greater than 0" });
                return badRequest;
            }

            var queueClient = await GetQueueClientAsync();
            var message = JsonSerializer.Serialize(new { SalesOrderID = salesOrderId, Status = 1 });
            var visibilityMinutes = 5 + (55 * Random.Shared.NextDouble());
            var visibility = TimeSpan.FromMinutes(visibilityMinutes);

            await queueClient.SendMessageAsync(
                message,
                visibilityTimeout: visibility,
                timeToLive: null);

            _logger.LogInformation(
                "Enqueued begin-processing for SalesOrderID={SalesOrderId}, visibility={VisibilityMinutes:F1} min",
                salesOrderId, visibility.TotalMinutes);

            var accepted = req.CreateResponse(HttpStatusCode.Accepted);
            await accepted.WriteAsJsonAsync(new
            {
                message = "Order status processing started",
                salesOrderId
            });
            return accepted;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error enqueueing begin-processing order");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
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

        // Terminal statuses: update DB only, send email if Shipped, do not re-queue
        if (status == 4 || status == 5 || status == 6)
        {
            var rows = await _orderService.UpdateOrderStatusAsync(salesOrderId, (byte)status);
            if (rows == 0)
            {
                _logger.LogWarning("Order not found. SalesOrderID={SalesOrderId}. Stopping processing (e.g. order may have been removed by seed job).", salesOrderId);
                return;
            }
            if (status == 5)
                await SendShippedEmailAsync(salesOrderId);
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

        // nextStatus == 2 (Approved): re-queue with visibility 1–12 hours, skewed toward lower
        var delayHours = 1 + 11 * Math.Pow(Random.Shared.NextDouble(), 2);
        var visibilityApproved = TimeSpan.FromHours(delayHours);
        await RequeueAsync(salesOrderId, 2, visibilityApproved);
        _logger.LogInformation("Order Approved for SalesOrderID={SalesOrderId}, re-queued with visibility {Hours:F1} h", salesOrderId, visibilityApproved.TotalHours);
    }

    private async Task SendShippedEmailAsync(int salesOrderId)
    {
        var emailInfo = await _orderService.GetCustomerEmailInfoBySalesOrderIdAsync(salesOrderId);
        if (emailInfo == null)
        {
            _logger.LogWarning("Could not find customer email for SalesOrderID={SalesOrderId}. Skipping shipped email.", salesOrderId);
            return;
        }

        const string subject = "Your order has pretend-shipped – demo";
        const string body = "This is a demo. Your order has been marked as shipped. Thank you for using Adventure Works.";
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

    private async Task RequeueAsync(int salesOrderId, int status, TimeSpan visibilityTimeout)
    {
        var queueClient = await GetQueueClientAsync();
        var message = JsonSerializer.Serialize(new { SalesOrderID = salesOrderId, Status = status });
        await queueClient.SendMessageAsync(message, visibilityTimeout: visibilityTimeout, timeToLive: null);
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
    }

    private class BeginProcessingOrderRequest
    {
        public int SalesOrderId { get; set; }
        public int SalesOrderID { get; set; }
    }
}
