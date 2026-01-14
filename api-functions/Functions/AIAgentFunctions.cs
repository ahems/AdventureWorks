using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System.Net;
using System.Text.Json;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// AI Agent Functions - Exposes AI agent endpoints that integrate with the external api-mcp service
/// </summary>
public class AIAgentFunctions
{
    private readonly ILogger<AIAgentFunctions> _logger;
    private readonly AIAgentService _agentService;

    public AIAgentFunctions(
        ILogger<AIAgentFunctions> logger,
        AIAgentService agentService)
    {
        _logger = logger;
        _agentService = agentService;
    }

    /// <summary>
    /// Chat with AI agent
    /// POST /api/agent/chat
    /// Body: { "message": "...", "conversationHistory": [...], "customerId": 123 }
    /// </summary>
    [Function("AIAgentChat")]
    public async Task<HttpResponseData> Chat(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "agent/chat")] HttpRequestData req)
    {
        _logger.LogInformation("AI Agent chat request received");

        try
        {
            // Parse request
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var chatRequest = JsonSerializer.Deserialize<AgentChatRequest>(requestBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (chatRequest == null || string.IsNullOrWhiteSpace(chatRequest.Message))
            {
                var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequest.WriteStringAsync("Message is required");
                return badRequest;
            }

            _logger.LogInformation($"Processing message for customer {chatRequest.CustomerId}: {chatRequest.Message}");

            // Process with AI agent
            var result = await _agentService.ProcessMessageAsync(
                chatRequest.Message,
                chatRequest.ConversationHistory ?? new List<AgentChatMessage>(),
                chatRequest.CustomerId
            );

            // Return response
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(result);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing agent chat request");

            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new
            {
                error = "An error occurred processing your request",
                message = ex.Message
            });
            return errorResponse;
        }
    }

    /// <summary>
    /// Get agent status and configuration
    /// GET /api/agent/status
    /// </summary>
    [Function("AIAgentStatus")]
    public async Task<HttpResponseData> Status(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "agent/status")] HttpRequestData req)
    {
        _logger.LogInformation("Agent status check");

        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(new
        {
            status = "operational",
            version = "1.0",
            features = new[]
            {
                "conversational-ai",
                "api-mcp-integration",
                "contextual-suggestions",
                "order-tracking",
                "product-search",
                "recommendations"
            }
        });
        return response;
    }
}

/// <summary>
/// Agent chat request model
/// </summary>
public class AgentChatRequest
{
    public string Message { get; set; } = string.Empty;
    public List<AgentChatMessage>? ConversationHistory { get; set; }
    public int? CustomerId { get; set; }
}
