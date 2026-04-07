using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using System.Net;
using System.Text.Json;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// AI-driven order generation: persona → MCP research → create customer + order → generate receipt.
/// POST /api/GenerateOrderWithAI
/// Body: { "personaType": string, "customPersona"?: string, "seedCustomerId"?: int }
/// Returns: { success, salesOrderId, customerName, customerEmail, newCustomerCreated, totalDue, receiptPdfBase64, log: [...] }
/// </summary>
public class GenerateOrderWithAIFunction
{
    private readonly ILogger<GenerateOrderWithAIFunction> _logger;
    private readonly OrderGenerationAgentService _agentService;
    private readonly TelemetryClient _telemetryClient;

    public GenerateOrderWithAIFunction(
        ILogger<GenerateOrderWithAIFunction> logger,
        OrderGenerationAgentService agentService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _agentService = agentService;
        _telemetryClient = telemetryClient;
    }

    [Function("GenerateOrderWithAI")]
    public async Task<HttpResponseData> GenerateOrderWithAI(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "GenerateOrderWithAI")] HttpRequestData req)
    {
        _logger.LogInformation("GenerateOrderWithAI request received");
        var requestStartTime = DateTimeOffset.UtcNow;

        try
        {
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var request = JsonSerializer.Deserialize<GenerateOrderWithAIRequest>(requestBody,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (request == null || string.IsNullOrWhiteSpace(request.PersonaType))
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteStringAsync("personaType is required");
                return bad;
            }

            _logger.LogInformation("Generating order for personaType={PersonaType}", request.PersonaType);

            _telemetryClient.TrackEvent("GenerateOrderWithAI.Request", new Dictionary<string, string>
            {
                ["PersonaType"] = request.PersonaType,
                ["HasCustomPersona"] = (!string.IsNullOrEmpty(request.CustomPersona)).ToString(),
                ["SeedCustomerId"] = (request.SeedCustomerId?.ToString() ?? "none")
            });

            var result = await _agentService.GenerateOrderAsync(request.PersonaType, request.CustomPersona, seedCustomerId: request.SeedCustomerId);

            var duration = DateTimeOffset.UtcNow - requestStartTime;
            _telemetryClient.TrackRequest("GenerateOrderWithAI", requestStartTime, duration,
                result.Success ? "200" : "500", result.Success);

            var response = req.CreateResponse(result.Success ? HttpStatusCode.OK : HttpStatusCode.InternalServerError);
            await response.WriteAsJsonAsync(result);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GenerateOrderWithAI");
            var duration = DateTimeOffset.UtcNow - requestStartTime;
            _telemetryClient.TrackRequest("GenerateOrderWithAI", requestStartTime, duration, "500", false);
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { ["Endpoint"] = "GenerateOrderWithAI" });

            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new
            {
                success = false,
                errorMessage = ex.Message,
                log = new[] { new { message = $"Server error: {ex.Message}", type = "error" } }
            });
            return errorResponse;
        }
    }
}

public class GenerateOrderWithAIRequest
{
    public string PersonaType { get; set; } = string.Empty;
    public string? CustomPersona { get; set; }
    /// <summary>
    /// When personaType is "existing-customer", the specific customer to simulate.
    /// If null with personaType "existing-customer", a random customer is selected server-side.
    /// </summary>
    public int? SeedCustomerId { get; set; }
}
