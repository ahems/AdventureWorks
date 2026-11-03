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
    private readonly ChatIdentityService _chatIdentity;

    public AIAgentFunctions(
        ILogger<AIAgentFunctions> logger,
        AIAgentService agentService,
        TelemetryClient telemetryClient,
        ChatIdentityService chatIdentity)
    {
        _logger = logger;
        _agentService = agentService;
        _telemetryClient = telemetryClient;
        _chatIdentity = chatIdentity;
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

            if (chatRequest.Message.Length > 4000)
            {
                _logger.LogWarning("Chat request exceeded the 4000-character input limit");
                var tooLong = req.CreateResponse(HttpStatusCode.BadRequest);
                await tooLong.WriteAsJsonAsync(new { error = "Please keep your shopping question under 4000 characters." });
                return tooLong;
            }

            // Track the incoming chat request
            _telemetryClient.TrackEvent("Agent.ChatRequest", new Dictionary<string, string>
            {
                ["CultureId"] = chatRequest.CultureId ?? "default",
                ["MessageLength"] = chatRequest.Message.Length.ToString(),
                ["HasHistory"] = (chatRequest.ConversationHistory?.Count > 0).ToString()
            });

            // This route validates the MCP-audience token explicitly before forwarding it.
            string? mcpAccessToken = null;
            if (req.Headers.TryGetValues("Authorization", out var authValues))
            {
                foreach (var raw in authValues)
                {
                    if (string.IsNullOrWhiteSpace(raw)) continue;
                    if (raw.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                    {
                        mcpAccessToken = raw["Bearer ".Length..].Trim();
                        break;
                    }
                }
            }
            if (string.IsNullOrWhiteSpace(mcpAccessToken))
            {
                _logger.LogWarning("AI Agent chat rejected: missing delegated MCP bearer token");
                var unauthorized = req.CreateResponse(HttpStatusCode.Unauthorized);
                await unauthorized.WriteAsJsonAsync(new { error = "Sign in again to use the AI assistant." });
                return unauthorized;
            }
            var caller = await _chatIdentity.ResolveAsync(mcpAccessToken, req.FunctionContext.CancellationToken);
            if (caller is null)
            {
                var unauthorized = req.CreateResponse(HttpStatusCode.Unauthorized);
                await unauthorized.WriteAsJsonAsync(new { error = "Please sign in again to use the AI assistant." });
                return unauthorized;
            }
            if (chatRequest.IsAdmin && (!caller.IsInternal || !caller.HasScope("sales.read")))
            {
                _logger.LogWarning("Chat admin routing denied for caller category {Category}", caller.Category);
                var forbidden = req.CreateResponse(HttpStatusCode.Forbidden);
                await forbidden.WriteAsJsonAsync(new { error = "I can help with shopping and your own orders, but not internal business data." });
                return forbidden;
            }

            // Process with AI agent
            var result = await _agentService.ProcessMessageAsync(
                chatRequest.Message,
                new List<AgentChatMessage>(),
                caller.CustomerId,
                caller.DisplayName,
                chatRequest.CultureId,
                chatRequest.ThreadId,
                isAdmin: chatRequest.IsAdmin,
                mcpAccessToken: mcpAccessToken,
                conversationOwner: caller.SubjectId);

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
                ["CustomerId"] = caller.CustomerId?.ToString() ?? "internal",
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
                error = "An error occurred processing your request. Please try again."
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
            version = "3.0",
            framework = "Azure.AI.Foundry",
            features = new[]
            {
                "conversational-ai",
                "foundry-responses-api",
                "structured-inputs",
                "memory-scoping",
                "tool-choice-required",
                "dual-mcp-servers",
                "contextual-suggestions",
                "order-tracking",
                "product-search",
                "recommendations",
                "multi-turn-persistence",
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
    public string? UserName { get; set; }
    public string? CultureId { get; set; }
    public string? ThreadId { get; set; }
    /// <summary>When true, routes the request to the admin analytics agent (AI_AGENT_ADMIN_CHAT_ID) instead of the customer chat agent.</summary>
    public bool IsAdmin { get; set; } = false;
}
