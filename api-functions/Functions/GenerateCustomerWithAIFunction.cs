using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using api_functions.Services;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

/// <summary>
/// AI-driven customer generation: pick a locale → Azure AI Foundry agent invents a
/// realistic fictitious profile → create the customer in the database.
/// POST /api/customers/generate-with-ai
/// Body: { "locale": "fr" | "de" | "ja" | ... }
/// Returns: { success, salesCustomerId, firstName, lastName, email, phone, address,
///             city, stateCode, postalCode, country, locale }
/// </summary>
public class GenerateCustomerWithAIFunction
{
    private readonly ILogger<GenerateCustomerWithAIFunction> _logger;
    private readonly CustomerGenerationAgentService _customerGenService;
    private readonly TelemetryClient _telemetryClient;

    public GenerateCustomerWithAIFunction(
        ILogger<GenerateCustomerWithAIFunction> logger,
        CustomerGenerationAgentService customerGenService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _customerGenService = customerGenService;
        _telemetryClient = telemetryClient;
    }

    [Function("GenerateCustomerWithAI")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "customers/generate-with-ai")] HttpRequestData req)
    {
        _logger.LogInformation("GenerateCustomerWithAI request received");

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var input = JsonSerializer.Deserialize<GenerateCustomerRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            var locale = input?.Locale ?? "en";

            var result = await _customerGenService.GenerateCustomerAsync(locale);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new
            {
                success = true,
                salesCustomerId = result.SalesCustomerId,
                firstName   = result.FirstName,
                lastName    = result.LastName,
                email       = result.Email,
                phone       = result.Phone,
                address     = result.Address,
                city        = result.City,
                stateCode   = result.StateCode,
                postalCode  = result.PostalCode,
                country     = result.Country,
                locale      = result.Locale,
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GenerateCustomerWithAI");
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { ["Endpoint"] = "GenerateCustomerWithAI" });

            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { success = false, error = ex.Message });
            return errorResponse;
        }
    }
}

public class GenerateCustomerRequest
{
    public string Locale { get; set; } = "en";
}

