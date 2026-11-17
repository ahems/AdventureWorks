using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using System.Net;
using System.Text.Json;
using Azure.Storage.Queues;
using ApiFunctions.Auth;
using Azure;
using Microsoft.Data.SqlClient;

namespace api_functions.Functions;

/// <summary>
/// Orchestrates receipt generation and email delivery for completed orders
/// Confirms queue persistence before accepting asynchronous generation and delivery.
/// </summary>
public class GenerateAndSendReceiptFunction
{
    private readonly ILogger<GenerateAndSendReceiptFunction> _logger;
    private readonly ReceiptService _receiptService;
    private readonly EmailService _emailService;
    private readonly IReceiptAccessService _access;
    private readonly QueueClient _receiptQueue;
    private const string EMAIL_QUEUE_NAME = "order-email-generation";

    public GenerateAndSendReceiptFunction(
        ILogger<GenerateAndSendReceiptFunction> logger,
        ReceiptService receiptService,
        EmailService emailService,
        IReceiptAccessService access,
        QueueClient receiptQueue)
    {
        _logger = logger;
        _receiptService = receiptService;
        _emailService = emailService;
        _access = access;
        _receiptQueue = receiptQueue;
    }

    /// <summary>
    /// Generates a PDF receipt for an order and sends it via email to the customer's selected email address
    /// Returns after authorization and confirmed queue persistence; generation and delivery run asynchronously.
    /// </summary>
    /// <param name="req">HTTP request with order details</param>
    /// <returns>Accepted response if validation passes</returns>
    /// <response code="202">Request accepted, processing in background</response>
    /// <response code="400">Invalid request parameters</response>
    /// <response code="500">Internal server error</response>
    [Function("GenerateAndSendReceipt")]
    public async Task<HttpResponseData> GenerateAndSendReceipt(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/generate-and-send-receipt")]
        HttpRequestData req)
    {
        _logger.LogInformation("GenerateAndSendReceipt function processing request");

        var user = FunctionUser.Current(req.FunctionContext);
        if (!user.IsAuthenticated || (!user.IsConsumer && !user.IsInternal) ||
            (user.IsConsumer && user.CustomerId is not > 0))
        {
            _logger.LogWarning("Denied unbound receipt email request");
            var denied = req.CreateResponse(HttpStatusCode.Forbidden);
            await denied.WriteAsJsonAsync(new { error = "Order access is not allowed." });
            return denied;
        }

        try
        {
            // Parse request body
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var request = JsonSerializer.Deserialize<GenerateAndSendReceiptRequest>(requestBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (request == null)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Invalid request body" });
                return badRequestResponse;
            }

            // Validate required fields
            if (request.SalesOrderId <= 0)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "SalesOrderId is required and must be greater than 0" });
                return badRequestResponse;
            }

            if (request.CustomerId <= 0)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "CustomerId is required and must be greater than 0" });
                return badRequestResponse;
            }

            if (request.EmailAddressId <= 0)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "EmailAddressId is required and must be greater than 0" });
                return badRequestResponse;
            }

            if (!await _access.CanSendAsync(request.SalesOrderId, request.CustomerId,
                    request.EmailAddressId, user.IsConsumer ? user.CustomerId : null))
            {
                _logger.LogWarning("Denied receipt order/customer/email binding");
                var denied = req.CreateResponse(HttpStatusCode.Forbidden);
                await denied.WriteAsJsonAsync(new { error = "Order access is not allowed." });
                return denied;
            }

            _logger.LogInformation(
                "Accepted receipt generation and email request for SalesOrderId={salesOrderId}, CustomerId={customerId}, EmailAddressId={emailAddressId}",
                request.SalesOrderId,
                request.CustomerId,
                request.EmailAddressId
            );

            await EnqueueReceiptAndEmailAsync(
                request.SalesOrderId, request.CustomerId, request.EmailAddressId,
                req.FunctionContext.CancellationToken);

            // Return immediately
            var acceptedResponse = req.CreateResponse(HttpStatusCode.Accepted);
            await acceptedResponse.WriteAsJsonAsync(new
            {
                message = "Receipt generation and email delivery queued",
                salesOrderId = request.SalesOrderId,
                customerId = request.CustomerId,
                emailAddressId = request.EmailAddressId
            });
            return acceptedResponse;
        }
        catch (JsonException)
        {
            var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
            await badRequest.WriteAsJsonAsync(new { error = "Invalid request body" });
            return badRequest;
        }
        catch (Exception ex) when (ex is RequestFailedException or SqlException)
        {
            _logger.LogError(ex, "Error in GenerateAndSendReceipt endpoint");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while processing the request" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Enqueue receipt generation first, then enqueue email sending to follow
    /// Uses existing GenerateOrderReceipts queue infrastructure
    /// </summary>
    private async Task EnqueueReceiptAndEmailAsync(
        int salesOrderId, int customerId, int emailAddressId, CancellationToken cancellationToken)
    {
        _logger.LogInformation(
            "Enqueueing receipt generation and email for SalesOrderId={salesOrderId}",
            salesOrderId
        );

        var salesOrderNumber = $"SO{salesOrderId}";
        var receiptMessage = JsonSerializer.Serialize(new
        {
            SalesOrderNumber = salesOrderNumber,
            EmailMetadata = new
            {
                CustomerId = customerId,
                EmailAddressId = emailAddressId,
                SalesOrderId = salesOrderId
            }
        });

        await _receiptQueue.SendMessageAsync(receiptMessage, cancellationToken);
        _logger.LogInformation("Enqueued receipt generation for {orderNumber} with email follow-up", salesOrderNumber);
    }

    /// <summary>
    /// Queue trigger that processes email sending jobs after receipt generation completes
    /// </summary>
    [Function(nameof(SendOrderEmail_QueueTrigger))]
    public async Task SendOrderEmail_QueueTrigger(
        [QueueTrigger(EMAIL_QUEUE_NAME, Connection = "AzureWebJobsStorage")] BinaryData queueMessage,
        FunctionContext executionContext)
    {
        try
        {
            // Parse queue message
            var messageData = JsonSerializer.Deserialize<JsonElement>(queueMessage.ToString());
            var salesOrderNumber = messageData.GetProperty("SalesOrderNumber").GetString();
            var customerId = messageData.GetProperty("CustomerId").GetInt32();
            var emailAddressId = messageData.GetProperty("EmailAddressId").GetInt32();

            if (string.IsNullOrEmpty(salesOrderNumber))
            {
                _logger.LogError("Invalid queue message: SalesOrderNumber is null or empty");
                return;
            }

            if (!salesOrderNumber.StartsWith("SO", StringComparison.Ordinal) ||
                !int.TryParse(salesOrderNumber.AsSpan(2), out var orderId) || orderId <= 0 ||
                salesOrderNumber != $"SO{orderId}" || customerId <= 0 || emailAddressId <= 0 ||
                !await _access.CanSendAsync(orderId, customerId, emailAddressId, null))
            {
                throw new InvalidOperationException("Receipt email metadata does not match the persisted order/customer/email.");
            }

            _logger.LogInformation(
                "Processing email sending for order: {orderNumber}",
                salesOrderNumber
            );

            // Fetch receipt data to build email content
            var receiptData = await _receiptService.GetReceiptDataBySalesOrderNumberAsync(salesOrderNumber);

            if (receiptData == null)
            {
                _logger.LogWarning("Order not found: {orderNumber}", salesOrderNumber);
                return;
            }

            // Construct blob URL for the receipt (should already exist from receipt generation)
            var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName");
            var pdfBlobUrl = $"https://{storageAccountName}.blob.core.windows.net/adventureworks-receipts/CustomerReceipts/{salesOrderNumber}.pdf";

            _logger.LogInformation(
                "Sending order confirmation email with receipt attachment: {blobUrl}",
                pdfBlobUrl
            );

            var emailSubject = $"🎉 Demo Order Confirmed - {salesOrderNumber}";
            var emailContent = $@"Thank you for your demo order!

Order Number: {salesOrderNumber}
Order Date: {receiptData.OrderDate:MMMM dd, yyyy}
Total: {receiptData.TotalDue:C}

Your demo receipt is attached to this email.

Items in Your Order:
{string.Join("\n", receiptData.LineItems.Select(item => $"- {item.ProductName} (Qty: {item.Quantity}) - {item.LineTotal:C}"))}

Fictional Shipping Address:
{receiptData.ShipToAddressLine1}
{(string.IsNullOrEmpty(receiptData.ShipToAddressLine2) ? "" : receiptData.ShipToAddressLine2 + "\n")}{receiptData.ShipToCity}, {receiptData.ShipToStateProvince} {receiptData.ShipToPostalCode}
{receiptData.ShipToCountry}

Thanks for exploring our demo! Feel free to place more pretend orders. 🛒";

            var emailSuccess = await _emailService.SendCustomerEmailAsync(
                customerId,
                emailAddressId,
                emailSubject,
                emailContent,
                pdfBlobUrl
            );

            if (emailSuccess)
            {
                _logger.LogInformation(
                    "Successfully sent order confirmation email for {orderNumber}",
                    salesOrderNumber
                );
            }
            else
            {
                _logger.LogWarning(
                    "Failed to send order confirmation email for {orderNumber}",
                    salesOrderNumber
                );
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "Error processing email sending from queue. Message will be retried or moved to poison queue."
            );
            throw; // Rethrow to allow Azure Functions retry logic
        }
    }
}

/// <summary>
/// Request model for generating and sending receipt
/// </summary>
public class GenerateAndSendReceiptRequest
{
    /// <summary>
    /// The Sales Order ID from Sales.SalesOrderHeader
    /// </summary>
    public int SalesOrderId { get; set; }

    /// <summary>
    /// The Customer ID from Sales.Customer
    /// </summary>
    public int CustomerId { get; set; }

    /// <summary>
    /// The EmailAddressID from Person.EmailAddress (selected by customer during checkout)
    /// </summary>
    public int EmailAddressId { get; set; }
}
