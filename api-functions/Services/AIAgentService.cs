using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;

namespace api_functions.Services;

/// <summary>
/// Conversational AI service backed by Azure AI Foundry "kind: prompt" agents.
///
/// Multi-turn continuity is managed by Foundry via <c>previous_response_id</c>:
/// the caller passes back the <see cref="AgentResponse.ThreadId"/> (which holds the
/// Foundry response ID) from the previous message, and Foundry automatically resumes
/// the stored conversation — no client-side thread management needed.
///
/// MCP tool execution (product search, order lookup, etc.) runs server-side in
/// Foundry, so this service only processes the final text response.
///
/// Customer and culture context is supplied via Foundry structured inputs
/// (Handlebars {{customerId}} / {{cultureId}} templates in the agent instructions),
/// keeping the user message clean and avoiding inline string injection.
/// Memory is scoped per customer via the x-memory-user-id header so Foundry
/// can personalise responses using stored conversation history.
/// </summary>
public class AIAgentService
{
    private readonly ILogger<AIAgentService> _logger;
    private readonly FoundryAgentClient _foundryClient;
    private readonly TelemetryClient _telemetryClient;
    private readonly string _agentId;
    private readonly string? _adminAgentId;

    public AIAgentService(
        ILogger<AIAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        // Prefer the workflow agent when it has been deployed; fall back to the
        // plain chat agent so the app remains functional before the workflow agent
        // is created (e.g. first-time provision or local dev without it).
        var workflowAgentId = configuration["AI_AGENT_WORKFLOW_CHAT_ID"];
        var chatAgentId     = configuration["AI_AGENT_CHAT_ID"];

        _agentId = !string.IsNullOrWhiteSpace(workflowAgentId)
            ? workflowAgentId
            : chatAgentId ?? throw new InvalidOperationException(
                "Neither AI_AGENT_WORKFLOW_CHAT_ID nor AI_AGENT_CHAT_ID environment variable is set");

        // Admin chat agent — falls back to the customer chat agent if not configured
        var adminAgentId = configuration["AI_AGENT_ADMIN_CHAT_ID"];
        _adminAgentId = !string.IsNullOrWhiteSpace(adminAgentId) ? adminAgentId : null;

        _logger.LogInformation("AIAgentService configured with Foundry agent ID: {AgentId}, Admin agent ID: {AdminAgentId}",
            _agentId, _adminAgentId ?? "(using customer agent)");
    }

    /// <summary>
    /// Process a chat message using the Foundry Responses API.
    /// Pass <paramref name="threadId"/> (a previous Foundry response ID) to continue a stored conversation.
    /// Set <paramref name="isAdmin"/> to true to route to the admin analytics agent instead of the customer chat agent.
    /// </summary>
    public async Task<AgentResponse> ProcessMessageAsync(
        string message,
        List<AgentChatMessage> conversationHistory,
        int? customerId = null,
        string? userName = null,
        string? cultureId = null,
        string? threadId = null,
        bool isAdmin = false)
    {
        var resolvedAgentId = isAdmin && _adminAgentId != null ? _adminAgentId : _agentId;
        var sessionId = isAdmin ? "admin" : (customerId.HasValue ? $"customer-{customerId.Value}" : Guid.NewGuid().ToString());

        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("AgentChat");
        operation.Telemetry.Properties["SessionId"] = sessionId;
        operation.Telemetry.Properties["CustomerId"] = customerId?.ToString() ?? "anonymous";
        operation.Telemetry.Properties["CultureId"] = cultureId ?? "default";
        operation.Telemetry.Properties["MessageLength"] = message.Length.ToString();
        operation.Telemetry.Properties["HasPreviousResponse"] = (!string.IsNullOrEmpty(threadId)).ToString();
        operation.Telemetry.Properties["IsAdmin"] = isAdmin.ToString();
        operation.Telemetry.Properties["AgentId"] = resolvedAgentId;

        var startTime = DateTimeOffset.UtcNow;

        try
        {
            // Build structured inputs to resolve Handlebars templates in agent instructions.
            // Keys must match the structured_inputs schema declared in the Foundry agent definition:
            //   {{userId}}   → the customer's numeric ID (used automatically by tools)
            //   {{userName}} → the customer's first name (used for personalised greetings)
            //   {{cultureId}} → language/locale code (used by HelpMeChoose queries etc.)
            Dictionary<string, object>? structuredInputs = null;
            if (customerId.HasValue || !string.IsNullOrEmpty(userName) || !string.IsNullOrEmpty(cultureId))
            {
                structuredInputs = new Dictionary<string, object>();
                if (customerId.HasValue)
                    structuredInputs["userId"] = customerId.Value.ToString();
                if (!string.IsNullOrEmpty(userName))
                    structuredInputs["userName"] = userName;
                if (!string.IsNullOrEmpty(cultureId))
                    structuredInputs["cultureId"] = cultureId;
            }

            // On first turn, seed the Foundry conversation with any history from the client.
            IList<FoundryMessage>? historyToSeed = null;
            if (string.IsNullOrEmpty(threadId) && conversationHistory.Count > 0)
            {
                historyToSeed = conversationHistory.Select(h => new FoundryMessage
                {
                    Role = h.Role.ToLowerInvariant() == "assistant" ? "assistant" : "user",
                    Content = h.Content
                }).ToList();
            }

            // ── Invoke Foundry agent via Responses API ────────────────────────────
            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: resolvedAgentId,
                userMessage: message,
                conversationHistory: historyToSeed,
                previousResponseId: string.IsNullOrEmpty(threadId) ? null : threadId,
                userId: customerId.HasValue ? customerId.Value.ToString() : null,
                structuredInputs: structuredInputs);

            // ── Suggested follow-up questions ─────────────────────────────────────
            var suggestions = await GenerateSuggestedQuestionsAsync(message, agentResponse.ResponseText, customerId);

            var totalDuration = DateTimeOffset.UtcNow - startTime;

            _telemetryClient.TrackEvent("Agent.ConversationCompleted", new Dictionary<string, string>
            {
                ["SessionId"] = sessionId,
                ["CustomerId"] = customerId?.ToString() ?? "anonymous",
                ["ResponseId"] = agentResponse.ResponseId ?? string.Empty,
                ["ToolsUsedCount"] = agentResponse.ToolsUsed.Count.ToString(),
                ["ToolsUsed"] = string.Join(",", agentResponse.ToolsUsed.Distinct()),
                ["DurationMs"] = totalDuration.TotalMilliseconds.ToString("F0"),
                ["ResponseLength"] = agentResponse.ResponseText.Length.ToString()
            });

            operation.Telemetry.Success = true;

            return new AgentResponse
            {
                Response = agentResponse.ResponseText,
                SuggestedQuestions = suggestions,
                ToolsUsed = agentResponse.ToolsUsed.Distinct().ToList(),
                ThreadId = agentResponse.ResponseId  // Foundry response ID — pass back as threadId for next turn
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing agent message");
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"] = "AgentChat",
                ["SessionId"] = sessionId,
                ["CustomerId"] = customerId?.ToString() ?? "anonymous"
            });
            throw;
        }
    }

    /// <summary>
    /// Returns default suggested follow-up questions.
    /// TODO: Fold into the Foundry chat agent's response schema so the agent
    /// generates context-aware suggestions as part of its output.
    /// </summary>
    private Task<List<string>> GenerateSuggestedQuestionsAsync(
        string userMessage,
        string assistantResponse,
        int? customerId)
    {
        var defaults = new List<string> { "Show my orders", "Search products" };
        return Task.FromResult(defaults);
    }
}

/// <summary>Chat message for conversation history.</summary>
public class AgentChatMessage
{
    public string Role { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
}

/// <summary>Agent response returned to the caller.</summary>
public class AgentResponse
{
    public string Response { get; set; } = string.Empty;
    public List<string> SuggestedQuestions { get; set; } = new();
    public List<string> ToolsUsed { get; set; } = new();
    /// <summary>
    /// Holds the Foundry response ID (format: "resp_…").
    /// Pass this back as <c>threadId</c> on the next message to continue the conversation
    /// via Foundry’s native <c>previous_response_id</c> mechanism.
    /// </summary>
    public string? ThreadId { get; set; }
}
