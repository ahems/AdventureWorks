using System.Text.Json;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using OpenAI.Chat;

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
/// </summary>
public class AIAgentService
{
    private readonly ILogger<AIAgentService> _logger;
    private readonly FoundryAgentClient _foundryClient;
    private readonly TelemetryClient _telemetryClient;
    private readonly string _agentId;
    private readonly string _openAiEndpoint;
    private readonly string _modelDeployment;

    public AIAgentService(
        ILogger<AIAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        _agentId = configuration["AI_AGENT_CHAT_ID"]
            ?? throw new InvalidOperationException("AI_AGENT_CHAT_ID environment variable is not set");
        _openAiEndpoint = configuration["AZURE_OPENAI_ENDPOINT"]
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT environment variable is not set");
        _modelDeployment = configuration["chatGptDeploymentName"] ?? "chat";

        _logger.LogInformation("AIAgentService configured with Foundry agent ID: {AgentId}", _agentId);
    }

    /// <summary>
    /// Process a chat message using the Foundry Responses API.
    /// Pass <paramref name="threadId"/> (a previous Foundry response ID) to continue a stored conversation.
    /// </summary>
    public async Task<AgentResponse> ProcessMessageAsync(
        string message,
        List<AgentChatMessage> conversationHistory,
        int? customerId = null,
        string? cultureId = null,
        string? threadId = null)
    {
        var sessionId = customerId.HasValue ? $"customer-{customerId.Value}" : Guid.NewGuid().ToString();

        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("AgentChat");
        operation.Telemetry.Properties["SessionId"] = sessionId;
        operation.Telemetry.Properties["CustomerId"] = customerId?.ToString() ?? "anonymous";
        operation.Telemetry.Properties["CultureId"] = cultureId ?? "default";
        operation.Telemetry.Properties["MessageLength"] = message.Length.ToString();
        operation.Telemetry.Properties["HasPreviousResponse"] = (!string.IsNullOrEmpty(threadId)).ToString();

        var startTime = DateTimeOffset.UtcNow;

        try
        {
            var userMessageText = BuildUserMessage(message, customerId, cultureId);

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
                agentId: _agentId,
                userMessage: userMessageText,
                conversationHistory: historyToSeed,
                previousResponseId: string.IsNullOrEmpty(threadId) ? null : threadId);

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
    /// Prepends customer/culture context to the user message so the agent has it inline.
    /// </summary>
    private static string BuildUserMessage(string message, int? customerId, string? cultureId)
    {
        if (customerId.HasValue || !string.IsNullOrEmpty(cultureId))
        {
            var parts = new List<string>();
            if (customerId.HasValue) parts.Add($"customer_id={customerId.Value}");
            if (!string.IsNullOrEmpty(cultureId)) parts.Add($"culture={cultureId}");
            return $"[{string.Join(", ", parts)}] {message}";
        }
        return message;
    }

    private async Task<List<string>> GenerateSuggestedQuestionsAsync(
        string userMessage,
        string assistantResponse,
        int? customerId)
    {
        try
        {
            var credential = new DefaultAzureCredential();
            var chatClient = new AzureOpenAIClient(new Uri(_openAiEndpoint), credential)
                .GetChatClient(_modelDeployment);

            var prompt = $"""
                Based on this customer service conversation, generate 2 relevant follow-up questions:
                User: {userMessage}
                Assistant: {assistantResponse}

                Generate 2 short questions (each under 50 characters) a customer might ask next.
                Return ONLY a JSON array of strings. Example: ["Track my order", "Find bike helmets"]
                """;

            var completion = await chatClient.CompleteChatAsync(
                [
                    new SystemChatMessage("You are a helpful assistant that generates follow-up questions."),
                    new UserChatMessage(prompt)
                ],
                new ChatCompletionOptions { MaxOutputTokenCount = 100 });

            var raw = completion.Value.Content[0].Text?.Trim() ?? "[]";
            return JsonSerializer.Deserialize<List<string>>(raw)
                ?? new List<string> { "Tell me more", "What else can you help with?" };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to generate suggestions, using defaults");
            return new List<string> { "Show my orders", "Search products" };
        }
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
