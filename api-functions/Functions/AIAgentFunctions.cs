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
/// AI Agent Functions - Exposes AI agent endpoints that integrate with the external api-mcp service
/// </summary>
public class AIAgentFunctions
{
    private readonly ILogger<AIAgentFunctions> _logger;
    private readonly AIAgentService _agentService;
    private readonly TelemetryClient _telemetryClient;

    public AIAgentFunctions(
        ILogger<AIAgentFunctions> logger,
        AIAgentService agentService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _agentService = agentService;
        _telemetryClient = telemetryClient;
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

        var requestStartTime = DateTimeOffset.UtcNow;

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
                _telemetryClient.TrackEvent("Agent.InvalidRequest", new Dictionary<string, string>
                {
                    ["Reason"] = "EmptyMessage"
                });

                var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequest.WriteStringAsync("Message is required");
                return badRequest;
            }

            _logger.LogInformation($"Processing message for customer {chatRequest.CustomerId}: {chatRequest.Message}");

            // Track the incoming chat request
            _telemetryClient.TrackEvent("Agent.ChatRequest", new Dictionary<string, string>
            {
                ["CustomerId"] = chatRequest.CustomerId?.ToString() ?? "anonymous",
                ["CultureId"] = chatRequest.CultureId ?? "default",
                ["MessageLength"] = chatRequest.Message.Length.ToString(),
                ["HasHistory"] = (chatRequest.ConversationHistory?.Count > 0).ToString()
            });

            // Process with AI agent
            var result = await _agentService.ProcessMessageAsync(
                chatRequest.Message,
                chatRequest.ConversationHistory ?? new List<AgentChatMessage>(),
                chatRequest.CustomerId,
                chatRequest.CultureId
            );

            var requestDuration = DateTimeOffset.UtcNow - requestStartTime;

            // Track successful completion
            _telemetryClient.TrackRequest(
                "AIAgentChat",
                requestStartTime,
                requestDuration,
                "200",
                true);

            _telemetryClient.TrackEvent("Agent.ChatSuccess", new Dictionary<string, string>
            {
                ["CustomerId"] = chatRequest.CustomerId?.ToString() ?? "anonymous",
                ["ResponseLength"] = result.Response.Length.ToString(),
                ["ToolsUsed"] = string.Join(",", result.ToolsUsed),
                ["SuggestionCount"] = result.SuggestedQuestions.Count.ToString(),
                ["DurationMs"] = requestDuration.TotalMilliseconds.ToString("F0")
            });

            // Return response
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(result);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing agent chat request");

            var requestDuration = DateTimeOffset.UtcNow - requestStartTime;

            _telemetryClient.TrackRequest(
                "AIAgentChat",
                requestStartTime,
                requestDuration,
                "500",
                false);

            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Endpoint"] = "AIAgentChat"
            });

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
            version = "2.0",
            framework = "Microsoft.Agents.AI",
            features = new[]
            {
                "conversational-ai",
                "mcp-tool-integration",
                "durable-agent-threads",
                "contextual-suggestions",
                "order-tracking",
                "product-search",
                "recommendations",
                "streaming-responses",
                "observability-telemetry"
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
    public string? CultureId { get; set; }
}
