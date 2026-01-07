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
/// Durable Azure Function for generating PDF receipts for customer orders
/// Uses fire-and-forget pattern with queue-based processing
/// </summary>
public class GenerateOrderReceipts
{
    private readonly ILogger<GenerateOrderReceipts> _logger;
    private readonly ReceiptService _receiptService;
    private readonly PdfReceiptGenerator _pdfGenerator;
    private const string QUEUE_NAME = "order-receipt-generation";

    public GenerateOrderReceipts(
        ILogger<GenerateOrderReceipts> logger,
        ReceiptService receiptService,
        PdfReceiptGenerator pdfGenerator)
    {
        _logger = logger;
        _receiptService = receiptService;
        _pdfGenerator = pdfGenerator;
    }

    /// <summary>
    /// HTTP trigger to enqueue receipt generation jobs for one or more sales order numbers
    /// POST body: { "salesOrderNumbers": ["SO43659", "SO43660", ...] }
    /// </summary>
    [Function(nameof(GenerateOrderReceipts_HttpStart))]
    public async Task<HttpResponseData> GenerateOrderReceipts_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        FunctionContext executionContext)
    {
        _logger.LogInformation("HTTP trigger received request to enqueue receipt generation jobs");

        try
        {
            // Parse request body with case-insensitive deserialization
            string requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var options = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            };
            var requestData = JsonSerializer.Deserialize<ReceiptGenerationRequest>(requestBody, options);

            if (requestData == null || requestData.SalesOrderNumbers == null || !requestData.SalesOrderNumbers.Any())
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteStringAsync(
                    "Invalid request. Please provide a JSON body with 'salesOrderNumbers' array. Example: { \"salesOrderNumbers\": [\"SO43659\", \"SO43660\"] }"
                );
                return badRequestResponse;
            }

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

            var queueClient = queueServiceClient.GetQueueClient(QUEUE_NAME);

            // Create queue if it doesn't exist
            try
            {
                _logger.LogInformation("Ensuring queue '{queueName}' exists", QUEUE_NAME);
                await queueClient.CreateIfNotExistsAsync();
                _logger.LogInformation("Queue '{queueName}' is ready", QUEUE_NAME);
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 404)
            {
                _logger.LogError(ex, "Failed to create queue '{queueName}'. The Managed Identity may not have 'Storage Queue Data Contributor' role.", QUEUE_NAME);
                throw new InvalidOperationException(
                    $"Queue '{QUEUE_NAME}' does not exist and cannot be created. " +
                    "Please create the queue manually or grant 'Storage Queue Data Contributor' role to the function's Managed Identity.",
                    ex);
            }

            // Enqueue one message per sales order number
            int enqueued = 0;
            var enqueuedOrders = new List<string>();

            foreach (var salesOrderNumber in requestData.SalesOrderNumbers)
            {
                if (string.IsNullOrWhiteSpace(salesOrderNumber))
                {
                    _logger.LogWarning("Skipping empty or null sales order number");
                    continue;
                }

                var message = JsonSerializer.Serialize(new
                {
                    SalesOrderNumber = salesOrderNumber.Trim()
                });

                await queueClient.SendMessageAsync(message);
                enqueued++;
                enqueuedOrders.Add(salesOrderNumber.Trim());

                _logger.LogInformation("Enqueued receipt generation for order: {orderNumber}", salesOrderNumber);
            }

            _logger.LogInformation("Enqueued {count} receipt generation jobs", enqueued);

            var successResponse = req.CreateResponse(HttpStatusCode.Accepted);
            await successResponse.WriteAsJsonAsync(new
            {
                message = $"Successfully enqueued {enqueued} receipt generation job(s)",
                enqueuedOrders = enqueuedOrders,
                totalEnqueued = enqueued
            });

            return successResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error enqueueing receipt generation jobs");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }

    /// <summary>
    /// Queue trigger that processes individual receipt generation jobs
    /// </summary>
    [Function(nameof(GenerateOrderReceipts_QueueTrigger))]
    public async Task GenerateOrderReceipts_QueueTrigger(
        [QueueTrigger(QUEUE_NAME, Connection = "AzureWebJobsStorage")] BinaryData queueMessage,
        FunctionContext executionContext)
    {
        try
        {
            // Parse queue message
            var messageData = JsonSerializer.Deserialize<JsonElement>(queueMessage.ToString());
            var salesOrderNumber = messageData.GetProperty("SalesOrderNumber").GetString();

            if (string.IsNullOrEmpty(salesOrderNumber))
            {
                _logger.LogError("Invalid queue message: SalesOrderNumber is null or empty");
                return;
            }

            _logger.LogInformation("Processing receipt generation for order: {orderNumber}", salesOrderNumber);

            // Fetch receipt data from database
            var receiptData = await _receiptService.GetReceiptDataBySalesOrderNumberAsync(salesOrderNumber);

            if (receiptData == null)
            {
                _logger.LogWarning("Order not found: {orderNumber}", salesOrderNumber);
                return;
            }

            _logger.LogInformation(
                "Retrieved order data for {orderNumber}: Customer={customer}, Items={itemCount}, Total=${total}",
                salesOrderNumber,
                receiptData.CustomerName,
                receiptData.LineItems.Count,
                receiptData.TotalDue
            );

            // Generate and upload PDF receipt
            var blobUrl = await _pdfGenerator.GenerateAndUploadReceiptAsync(receiptData);

            _logger.LogInformation(
                "Successfully generated receipt for order {orderNumber}. PDF available at: {blobUrl}",
                salesOrderNumber,
                blobUrl
            );
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "Error processing receipt generation from queue. Message will be retried or moved to poison queue."
            );
            throw; // Rethrow to allow Azure Functions retry logic and poison queue handling
        }
    }

    /// <summary>
    /// Request model for HTTP trigger
    /// </summary>
    private class ReceiptGenerationRequest
    {
        public List<string> SalesOrderNumbers { get; set; } = new();
    }
}
