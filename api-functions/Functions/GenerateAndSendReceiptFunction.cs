using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using System.Net;
using System.Text.Json;
using Azure.Storage.Queues;
using Azure.Identity;

namespace api_functions.Functions;

/// <summary>
/// Orchestrates receipt generation and email delivery for completed orders
/// Fire-and-forget pattern: generates PDF receipt then emails it to customer's selected address
/// </summary>
public class GenerateAndSendReceiptFunction
{
    private readonly ILogger<GenerateAndSendReceiptFunction> _logger;
    private readonly ReceiptService _receiptService;
    private readonly EmailService _emailService;
    private const string RECEIPT_QUEUE_NAME = "order-receipt-generation";
    private const string EMAIL_QUEUE_NAME = "order-email-generation";

    public GenerateAndSendReceiptFunction(
        ILogger<GenerateAndSendReceiptFunction> logger,
        ReceiptService receiptService,
        EmailService emailService)
    {
        _logger = logger;
        _receiptService = receiptService;
        _emailService = emailService;
    }

    /// <summary>
    /// Generates a PDF receipt for an order and sends it via email to the customer's selected email address
    /// This is a fire-and-forget endpoint - returns immediately after validation, processes asynchronously
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

            _logger.LogInformation(
                "Accepted receipt generation and email request for SalesOrderId={salesOrderId}, CustomerId={customerId}, EmailAddressId={emailAddressId}",
                request.SalesOrderId,
                request.CustomerId,
                request.EmailAddressId
            );

            // Fire-and-forget: Enqueue receipt generation, then email will follow
            _ = Task.Run(async () =>
            {
                try
                {
                    await EnqueueReceiptAndEmailAsync(
                        request.SalesOrderId,
                        request.CustomerId,
                        request.EmailAddressId
                    );
                }
                catch (Exception ex)
                {
                    _logger.LogError(
                        ex,
                        "Error in background processing for SalesOrderId={salesOrderId}",
                        request.SalesOrderId
                    );
                }
            });

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
        catch (Exception ex)
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
    private async Task EnqueueReceiptAndEmailAsync(int salesOrderId, int customerId, int emailAddressId)
    {
        try
        {
            _logger.LogInformation(
                "Enqueueing receipt generation and email for SalesOrderId={salesOrderId}",
                salesOrderId
            );

            // Get queue service URI from environment variables
            var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
            if (string.IsNullOrEmpty(queueServiceUri))
            {
                var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                    ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
                queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
            }

            // Create queue client with managed identity
            var queueServiceClient = new QueueServiceClient(
                new Uri(queueServiceUri),
                new DefaultAzureCredential(),
                new QueueClientOptions
                {
                    MessageEncoding = QueueMessageEncoding.Base64
                }
            );

            // Step 1: Enqueue receipt generation with email metadata (reuse existing infrastructure)
            var receiptQueueClient = queueServiceClient.GetQueueClient(RECEIPT_QUEUE_NAME);
            await receiptQueueClient.CreateIfNotExistsAsync();

            var salesOrderNumber = $"SO{salesOrderId}";
            var receiptMessage = JsonSerializer.Serialize(new
            {
                SalesOrderNumber = salesOrderNumber,
                // Include email metadata so receipt generation can enqueue email AFTER PDF is ready
                EmailMetadata = new
                {
                    CustomerId = customerId,
                    EmailAddressId = emailAddressId,
                    SalesOrderId = salesOrderId
                }
            });

            await receiptQueueClient.SendMessageAsync(receiptMessage);
            _logger.LogInformation("Enqueued receipt generation for {orderNumber} with email follow-up", salesOrderNumber);
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "Error enqueueing receipt and email for SalesOrderId={salesOrderId}",
                salesOrderId
            );
            throw;
        }
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

            _logger.LogInformation(
                "Processing email sending for order: {orderNumber}, EmailAddressId={emailAddressId}",
                salesOrderNumber,
                emailAddressId
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

⚠️ IMPORTANT: This is a Demo Site!
This order is completely fictional - perfect for testing our e-commerce platform! 
Nothing will actually ship, and no real charges have been made. We're just showing 
off what's possible with modern web technologies. Your pretend order is safe with us! 😊

Your demo receipt is attached to this email.

Items in Your Make-Believe Order:
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
                    "Successfully sent order confirmation email for {orderNumber} to EmailAddressId={emailAddressId}",
                    salesOrderNumber,
                    emailAddressId
                );
            }
            else
            {
                _logger.LogWarning(
                    "Failed to send order confirmation email for {orderNumber} to EmailAddressId={emailAddressId}",
                    salesOrderNumber,
                    emailAddressId
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
