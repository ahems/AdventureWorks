using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System.Net;
using System.Text.Json;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Queues;
using Azure.Identity;
using Microsoft.Data.SqlClient;
using Dapper;

namespace api_functions.Functions;

/// <summary>
/// Fire-and-forget function that enqueues receipt generation for every order
/// that does not yet have a PDF in blob storage.
/// </summary>
public class GenerateMissingReceiptsFunction
{
    private readonly ILogger<GenerateMissingReceiptsFunction> _logger;
    private const string CONTAINER_NAME = "adventureworks-receipts";
    private const string QUEUE_NAME = "order-receipt-generation";

    public GenerateMissingReceiptsFunction(ILogger<GenerateMissingReceiptsFunction> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// POST /api/orders/generate-missing-receipts
    /// Synchronously fetches all non-cancelled order numbers (so we can return a real count),
    /// returns 202 Accepted immediately, then in the background diffs against existing blobs
    /// and enqueues only the missing ones to the receipt generation queue.
    /// </summary>
    [Function("GenerateMissingReceipts")]
    public async Task<HttpResponseData> GenerateMissingReceipts(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/generate-missing-receipts")]
        HttpRequestData req)
    {
        _logger.LogInformation("GenerateMissingReceipts: request received");

        try
        {
            var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
                ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured");

            // Fetch order numbers synchronously — fast query, lets us return a real count in the 202
            List<string> allOrderNumbers;
            using (var connection = new SqlConnection(connectionString))
            {
                await connection.OpenAsync();
                var rows = await connection.QueryAsync<string>(
                    "SELECT SalesOrderNumber FROM Sales.SalesOrderHeader WHERE Status != 6");
                allOrderNumbers = rows.AsList();
            }

            _logger.LogInformation("GenerateMissingReceipts: {count} non-cancelled orders found", allOrderNumbers.Count);

            // Fire-and-forget — return 202 immediately, do the blob diff + enqueue in background
            _ = Task.Run(async () =>
            {
                try
                {
                    await EnqueueMissingReceiptsAsync(allOrderNumbers);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "GenerateMissingReceipts: background processing failed");
                }
            });

            var response = req.CreateResponse(HttpStatusCode.Accepted);
            await response.WriteAsJsonAsync(new
            {
                message = "Generating missing receipts in the background",
                estimatedTotal = allOrderNumbers.Count
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GenerateMissingReceipts: failed during request handling");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = ex.Message });
            return errorResponse;
        }
    }

    private async Task EnqueueMissingReceiptsAsync(List<string> allOrderNumbers)
    {
        var credential = new DefaultAzureCredential();

        var blobServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__blobServiceUri");
        var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");

        if (string.IsNullOrEmpty(blobServiceUri) || string.IsNullOrEmpty(queueServiceUri))
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
            blobServiceUri ??= $"https://{accountName}.blob.core.windows.net";
            queueServiceUri ??= $"https://{accountName}.queue.core.windows.net";
        }

        // One list call is far cheaper than ~31K individual ExistsAsync HEAD requests
        var blobServiceClient = new BlobServiceClient(new Uri(blobServiceUri), credential);
        var containerClient = blobServiceClient.GetBlobContainerClient(CONTAINER_NAME);

        var existingBlobs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        await foreach (var blob in containerClient.GetBlobsAsync(BlobTraits.None, BlobStates.None, "CustomerReceipts/", CancellationToken.None))
        {
            existingBlobs.Add(blob.Name);
        }

        _logger.LogInformation("GenerateMissingReceipts: {existing} receipts already exist in blob storage", existingBlobs.Count);

        var missing = allOrderNumbers
            .Where(n => !existingBlobs.Contains($"CustomerReceipts/{n}.pdf"))
            .ToList();

        _logger.LogInformation("GenerateMissingReceipts: {missing} receipts need to be generated", missing.Count);

        if (missing.Count == 0)
        {
            _logger.LogInformation("GenerateMissingReceipts: nothing to do, all receipts already exist");
            return;
        }

        var queueServiceClient = new QueueServiceClient(
            new Uri(queueServiceUri),
            credential,
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 }
        );

        var queueClient = queueServiceClient.GetQueueClient(QUEUE_NAME);

        foreach (var orderNumber in missing)
        {
            var message = JsonSerializer.Serialize(new { SalesOrderNumber = orderNumber });
            await queueClient.SendMessageAsync(message);
        }

        _logger.LogInformation("GenerateMissingReceipts: enqueued {count} receipt generation jobs", missing.Count);
    }
}
