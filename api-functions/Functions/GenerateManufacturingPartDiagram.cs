using System.Net;
using System.Text.Json;
using api_functions.Models;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public sealed class GenerateManufacturingPartDiagram(
    ManufacturingDiagramService diagrams, ILogger<GenerateManufacturingPartDiagram> logger)
{
    [Function(nameof(GenerateManufacturingPartDiagram))]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/content/parts/diagrams/generate")] HttpRequestData req,
        CancellationToken cancellationToken)
    {
        try
        {
            var request = await JsonSerializer.DeserializeAsync<ManufacturingProductDiagramRequest>(
                req.Body, new JsonSerializerOptions(ManufacturingContentAgentService.JsonOptions)
                {
                    RespectRequiredConstructorParameters = true
                }, cancellationToken);
            if (request == null || request.ApprovedDraft == null || request.ApprovedDraft.Grounding == null ||
                request.ApprovedDraft.Draft == null || request.Slot is < 1 or > 3)
                return await Error(HttpStatusCode.BadRequest, "Supply the approved part sheet response and a diagram slot (1-3).");
            try
            {
                ManufacturingDiagramService.ValidateApprovedProductDraft(request.ApprovedDraft, request.Slot);
            }
            catch (InvalidDataException ex)
            {
                logger.LogWarning(ex, "Invalid approved manufacturing draft supplied for drawing");
                return await Error(HttpStatusCode.BadRequest, ex.Message);
            }
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(200));
            var result = await diagrams.GenerateProductAsync(request, timeout.Token);
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(result, cancellationToken);
            return response;
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "Invalid manufacturing diagram request JSON");
            return await Error(HttpStatusCode.BadRequest, "Invalid diagram request JSON.");
        }
        catch (ManufacturingEligibilityException ex)
        {
            logger.LogWarning(ex, "Manufacturing diagram grounding is stale or ineligible");
            return await Error(HttpStatusCode.Conflict, ex.Message);
        }
        catch (InvalidDataException ex)
        {
            logger.LogWarning(ex, "Manufacturing diagram validation failed");
            return await Error(HttpStatusCode.BadGateway, ex.Message);
        }
        catch (OperationCanceledException ex)
        {
            logger.LogWarning(ex, "Manufacturing diagram generation timed out or was cancelled");
            return await Error(HttpStatusCode.GatewayTimeout, "Drawing timed out or was cancelled; no asset was published.");
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Manufacturing diagram generation failed");
            return await Error(HttpStatusCode.InternalServerError, "Diagram generation failed. Check Application Insights using the request trace.");
        }

        async Task<HttpResponseData> Error(HttpStatusCode status, string message)
        {
            var response = req.CreateResponse(status);
            response.Headers.Add("Content-Type", "application/json");
            await response.WriteStringAsync(JsonSerializer.Serialize(new { error = message }));
            return response;
        }
    }
}
