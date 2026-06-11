using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System.Net;
using Azure.Storage.Blobs;
using Azure.Identity;

namespace api_functions.Functions;

/// <summary>
/// Functions for checking receipt existence and downloading receipts from blob storage
/// </summary>
public class ReceiptCheckFunction
{
    private readonly ILogger<ReceiptCheckFunction> _logger;
    private const string CONTAINER_NAME = "adventureworks-receipts";

    public ReceiptCheckFunction(ILogger<ReceiptCheckFunction> logger)
    {
        _logger = logger;
    }

    private BlobContainerClient GetContainerClient()
    {
        var blobServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__blobServiceUri");
        if (string.IsNullOrEmpty(blobServiceUri))
        {
            var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
            blobServiceUri = $"https://{storageAccountName}.blob.core.windows.net";
        }

        var blobServiceClient = new BlobServiceClient(
            new Uri(blobServiceUri),
            new DefaultAzureCredential()
        );

        return blobServiceClient.GetBlobContainerClient(CONTAINER_NAME);
    }

    /// <summary>
    /// Checks whether a PDF receipt exists in blob storage for the given order.
    /// GET /api/orders/{salesOrderId}/receipt-status
    /// Returns: { "exists": true|false }
    /// </summary>
    [Function("CheckOrderReceipt")]
    public async Task<HttpResponseData> CheckOrderReceipt(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/{salesOrderId:int}/receipt-status")]
        HttpRequestData req,
        int salesOrderId)
    {
        _logger.LogInformation("Checking receipt status for order {salesOrderId}", salesOrderId);

        try
        {
            var blobName = $"CustomerReceipts/SO{salesOrderId}.pdf";
            var containerClient = GetContainerClient();
            var blobClient = containerClient.GetBlobClient(blobName);

            var exists = await blobClient.ExistsAsync();

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new { exists = exists.Value });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error checking receipt for order {salesOrderId}", salesOrderId);
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = ex.Message });
            return errorResponse;
        }
    }

    /// <summary>
    /// Downloads the PDF receipt for the given order directly from blob storage.
    /// GET /api/orders/{salesOrderId}/receipt
    /// Returns the PDF as an inline/attachment response, or 404 if not found.
    /// </summary>
    [Function("DownloadOrderReceipt")]
    public async Task<HttpResponseData> DownloadOrderReceipt(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/{salesOrderId:int}/receipt")]
        HttpRequestData req,
        int salesOrderId)
    {
        _logger.LogInformation("Downloading receipt for order {salesOrderId}", salesOrderId);

        try
        {
            var blobName = $"CustomerReceipts/SO{salesOrderId}.pdf";
            var containerClient = GetContainerClient();
            var blobClient = containerClient.GetBlobClient(blobName);

            var exists = await blobClient.ExistsAsync();
            if (!exists.Value)
            {
                var notFoundResponse = req.CreateResponse(HttpStatusCode.NotFound);
                await notFoundResponse.WriteAsJsonAsync(new { error = $"Receipt for order SO{salesOrderId} has not been generated yet." });
                return notFoundResponse;
            }

            var download = await blobClient.DownloadContentAsync();
            var pdfBytes = download.Value.Content.ToArray();

            var response = req.CreateResponse(HttpStatusCode.OK);
            response.Headers.Add("Content-Type", "application/pdf");
            response.Headers.Add("Content-Disposition", $"attachment; filename=\"receipt-SO{salesOrderId}.pdf\"");
            await response.Body.WriteAsync(pdfBytes);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error downloading receipt for order {salesOrderId}", salesOrderId);
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = ex.Message });
            return errorResponse;
        }
    }
}
