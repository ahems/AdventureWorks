using System.Net;
using ApiFunctions.Auth;
using api_functions.Services;
using Azure;
using Azure.Storage.Blobs;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public class ReceiptCheckFunction(
    ILogger<ReceiptCheckFunction> logger,
    IReceiptAccessService access,
    BlobContainerClient container)
{
    [Function("CheckOrderReceipt")]
    public async Task<HttpResponseData> CheckOrderReceipt(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/{salesOrderId:int}/receipt-status")]
        HttpRequestData req,
        int salesOrderId)
    {
        if (await AuthorizeAsync(req, salesOrderId) is { } denied)
            return denied;

        try
        {
            var exists = await container.GetBlobClient($"CustomerReceipts/SO{salesOrderId}.pdf")
                .ExistsAsync(req.FunctionContext.CancellationToken);
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new { exists = exists.Value });
            return response;
        }
        catch (RequestFailedException ex)
        {
            logger.LogError(ex, "Error checking authorized order receipt");
            return await ErrorAsync(req, HttpStatusCode.InternalServerError, "Receipt storage is unavailable.");
        }
    }

    [Function("DownloadOrderReceipt")]
    public async Task<HttpResponseData> DownloadOrderReceipt(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/{salesOrderId:int}/receipt")]
        HttpRequestData req,
        int salesOrderId)
    {
        if (await AuthorizeAsync(req, salesOrderId) is { } denied)
            return denied;

        try
        {
            var download = await container.GetBlobClient($"CustomerReceipts/SO{salesOrderId}.pdf")
                .DownloadContentAsync(cancellationToken: req.FunctionContext.CancellationToken);
            var response = req.CreateResponse(HttpStatusCode.OK);
            response.Headers.Add("Content-Type", "application/pdf");
            response.Headers.Add("Content-Disposition", $"attachment; filename=\"receipt-SO{salesOrderId}.pdf\"");
            await response.Body.WriteAsync(download.Value.Content.ToMemory(), req.FunctionContext.CancellationToken);
            return response;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return await ErrorAsync(req, HttpStatusCode.NotFound, "Receipt has not been generated yet.");
        }
        catch (RequestFailedException ex)
        {
            logger.LogError(ex, "Error downloading authorized order receipt");
            return await ErrorAsync(req, HttpStatusCode.InternalServerError, "Receipt storage is unavailable.");
        }
    }

    private async Task<HttpResponseData?> AuthorizeAsync(HttpRequestData req, int salesOrderId)
    {
        if (salesOrderId <= 0)
            return await ErrorAsync(req, HttpStatusCode.BadRequest, "A valid sales order id is required.");

        var user = FunctionUser.Current(req.FunctionContext);
        if (!user.IsAuthenticated || (!user.IsConsumer && !user.IsInternal) ||
            (user.IsConsumer && user.CustomerId is not > 0) ||
            !await access.CanReadAsync(salesOrderId, user.IsConsumer ? user.CustomerId : null))
        {
            logger.LogWarning("Denied order receipt access");
            return await ErrorAsync(req, HttpStatusCode.Forbidden, "Order access is not allowed.");
        }

        return null;
    }

    private static async Task<HttpResponseData> ErrorAsync(
        HttpRequestData req, HttpStatusCode status, string message)
    {
        var response = req.CreateResponse(status);
        await response.WriteAsJsonAsync(new { error = message });
        return response;
    }
}
