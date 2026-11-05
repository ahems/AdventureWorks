using System.Net;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public sealed class GetManufacturingPartDocuments(
    ManufacturingContentGroundingService grounding, ILogger<GetManufacturingPartDocuments> logger)
{
    [Function(nameof(GetManufacturingPartDocuments))]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/parts/{productId:int}/documents")] HttpRequestData req,
        int productId, CancellationToken cancellationToken)
    {
        if (productId is < 1 or > 99999)
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new { error = "A productId between 1 and 99999 is required." }, cancellationToken);
            bad.StatusCode = HttpStatusCode.BadRequest;
            return bad;
        }
        try
        {
            var documents = await grounding.GetProductDocumentsAsync(productId, cancellationToken);
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(documents, cancellationToken);
            return response;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Failed to read documents for part {ProductId}", productId);
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "Part documents could not be loaded." }, cancellationToken);
            error.StatusCode = HttpStatusCode.InternalServerError;
            return error;
        }
    }
}
