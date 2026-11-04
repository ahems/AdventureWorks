using System.Net;
using System.Text.Json;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public sealed class GenerateManufacturingInstructions(
    ManufacturingContentAgentService content, ILogger<GenerateManufacturingInstructions> logger)
{
    [Function(nameof(GenerateManufacturingInstructions))]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/content/instructions/generate")] HttpRequestData req,
        CancellationToken cancellationToken)
    {
        try
        {
            var request = await JsonSerializer.DeserializeAsync<GenerationRequest>(req.Body,
                ManufacturingContentAgentService.JsonOptions, cancellationToken);
            if (request is null || request.ProductModelId is < 1 or > 1000000)
                return await Error(HttpStatusCode.BadRequest, "A productModelId between 1 and 1000000 is required.");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(200));
            var result = await content.GenerateAsync(request.ProductModelId, timeout.Token, request.SupplementExistingInstructions);
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(result, cancellationToken);
            return response;
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "Invalid manufacturing generation request");
            return await Error(HttpStatusCode.BadRequest, "Invalid generation request JSON.");
        }
        catch (ManufacturingEligibilityException ex)
        {
            logger.LogWarning(ex, "Manufacturing generation eligibility check failed");
            return await Error(HttpStatusCode.Conflict, ex.Message);
        }
        catch (InvalidDataException ex)
        {
            logger.LogWarning(ex, "Manufacturing generation output failed validation");
            return await Error(HttpStatusCode.BadGateway, ex.Message);
        }
        catch (OperationCanceledException ex)
        {
            logger.LogWarning(ex, "Manufacturing instruction generation timed out or was cancelled");
            return await Error(HttpStatusCode.GatewayTimeout, "Generation timed out or was cancelled; no draft was accepted or saved.");
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Manufacturing instruction generation failed");
            return await Error(HttpStatusCode.InternalServerError, "Generation failed. Check Application Insights using the request trace.");
        }

        async Task<HttpResponseData> Error(HttpStatusCode status, string message)
        {
            var response = req.CreateResponse(status);
            await response.WriteStringAsync(JsonSerializer.Serialize(new { error = message }));
            response.Headers.Add("Content-Type", "application/json");
            return response;
        }
    }

    public sealed record GenerationRequest(int ProductModelId, bool SupplementExistingInstructions = false);
}
