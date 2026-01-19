using System.Text.Json;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;
using Azure.AI.OpenAI;
using OpenAI.Chat;

namespace api_functions.Services;

/// <summary>
/// AI Agent Service - Manages AI agent interactions using Microsoft Agent Framework with MCP tools
/// </summary>
public class AIAgentService
{
    private readonly ILogger<AIAgentService> _logger;
    private readonly IConfiguration _configuration;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly TelemetryClient _telemetryClient;
    private readonly string _endpoint;
    private readonly string _modelDeployment;
    private readonly string _mcpServerUrl;
    private AIAgent? _agent;
    private McpClient? _mcpClient;
    private readonly SemaphoreSlim _initLock = new(1, 1);

    public AIAgentService(
        ILogger<AIAgentService> logger,
        IConfiguration configuration,
        IHttpClientFactory httpClientFactory,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _configuration = configuration;
        _httpClientFactory = httpClientFactory;
        _telemetryClient = telemetryClient;

        // Get AI Foundry configuration
        _endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");
        _modelDeployment = configuration["chatGptDeploymentName"] ?? "chat";

        // Get MCP server URL (external api-mcp service)
        // URL should already include /mcp endpoint: https://av-mcp-xxx.azurecontainerapps.io/mcp
        var mcpServiceUrl = configuration["MCP_SERVICE_URL"];
        if (!string.IsNullOrEmpty(mcpServiceUrl))
        {
            _mcpServerUrl = mcpServiceUrl.TrimEnd('/');
        }
        else
        {
            // For local development, point to the api-mcp service
            _mcpServerUrl = "http://localhost:5000/mcp";
        }

        _logger.LogInformation($"AI Agent configured with endpoint: {_endpoint}, model: {_modelDeployment}, MCP: {_mcpServerUrl}");
    }


    /// <summary>
    /// Initialize the AI agent with MCP tools (lazy initialization)
    /// </summary>
    private async Task<AIAgent> GetOrCreateAgentAsync(int? customerId = null, string? cultureId = null)
    {
        if (_agent != null)
        {
            return _agent;
        }

        await _initLock.WaitAsync();
        try
        {
            if (_agent != null)
            {
                return _agent;
            }

            _logger.LogInformation("Initializing AI Agent with Microsoft Agent Framework...");

            // Initialize MCP client for AdventureWorks tools
            _mcpClient = await McpClient.CreateAsync(
                new HttpClientTransport(
                    new()
                    {
                        Name = "AdventureWorks MCP",
                        Endpoint = new Uri(_mcpServerUrl)
                    }
                )
            );

            // Get MCP tools
            var mcpTools = await _mcpClient.ListToolsAsync().ConfigureAwait(false);
            _logger.LogInformation($"Loaded {mcpTools.Count} MCP tools from {_mcpServerUrl}");

            // Create Azure OpenAI client using Agent Framework
            var credential = new DefaultAzureCredential();
            var client = new Azure.AI.OpenAI.AzureOpenAIClient(
                new Uri(_endpoint),
                credential
            );
            var chatClient = client.GetChatClient(_modelDeployment).AsIChatClient();

            // Build system instructions with context
            var systemInstructions = BuildSystemPrompt(customerId, cultureId);

            // Create the AI agent with MCP tools using ChatClientAgent
            _agent = new ChatClientAgent(
                chatClient,
                instructions: systemInstructions,
                name: "AdventureWorks Customer Service Agent",
                tools: mcpTools.ToArray()
            );

            _logger.LogInformation("AI Agent initialized successfully");

            return _agent;
        }
        finally
        {
            _initLock.Release();
        }
    }

    /// <summary>
    /// Process a chat message with the AI agent and MCP tools using Agent Framework
    /// </summary>
    public async Task<AgentResponse> ProcessMessageAsync(
        string message,
        List<AgentChatMessage> conversationHistory,
        int? customerId = null,
        string? cultureId = null)
    {
        // Generate conversation session ID for correlation
        var sessionId = customerId.HasValue ? $"customer-{customerId.Value}" : Guid.NewGuid().ToString();

        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("AgentChat");
        operation.Telemetry.Properties["SessionId"] = sessionId;
        operation.Telemetry.Properties["CustomerId"] = customerId?.ToString() ?? "anonymous";
        operation.Telemetry.Properties["CultureId"] = cultureId ?? "default";
        operation.Telemetry.Properties["MessageLength"] = message.Length.ToString();
        operation.Telemetry.Properties["HistoryLength"] = conversationHistory.Count.ToString();

        var startTime = DateTimeOffset.UtcNow;

        try
        {
            // Get or create the agent
            var agent = await GetOrCreateAgentAsync(customerId, cultureId);
            var chatAgent = (ChatClientAgent)agent; // Cast to access ChatClientAgent-specific methods

            // Create thread for conversation
            AgentThread thread = agent.GetNewThread();

            // Build all messages to send to agent (history + new user message)
            var allMessages = new List<Microsoft.Extensions.AI.ChatMessage>();

            // Add conversation history first
            foreach (var h in conversationHistory)
            {
                var role = h.Role.ToLowerInvariant() switch
                {
                    "user" => ChatRole.User,
                    "assistant" => ChatRole.Assistant,
                    "system" => ChatRole.System,
                    _ => ChatRole.User
                };
                allMessages.Add(new Microsoft.Extensions.AI.ChatMessage(role, h.Content));
            }

            // Add the new user message
            allMessages.Add(new Microsoft.Extensions.AI.ChatMessage(ChatRole.User, message));

            _logger.LogInformation("Processing message with {HistoryCount} historical messages for customer {CustomerId}",
                conversationHistory.Count, customerId);

            // Track which tools were used
            var toolsUsed = new List<string>();
            var totalTokens = 0;
            var responseBuilder = new System.Text.StringBuilder();

            // Run agent in streaming mode with ALL messages (history + new)
            // The Agent Framework processes all messages and maintains context
            await foreach (var update in agent.RunStreamingAsync(allMessages, thread))
            {
                if (!string.IsNullOrEmpty(update.Text))
                {
                    responseBuilder.Append(update.Text);
                }

                // Note: AgentRunResponseUpdate from Agent Framework may have different properties
                // Tracking will happen at completion level for now
            }

            var assistantMessage = responseBuilder.ToString();

            // Generate contextual follow-up questions
            var suggestions = await GenerateSuggestedQuestionsAsync(
                agent,
                conversationHistory,
                message,
                assistantMessage,
                customerId);

            var totalDuration = DateTimeOffset.UtcNow - startTime;

            // Track comprehensive agent metrics
            _telemetryClient.TrackEvent("Agent.ConversationCompleted", new Dictionary<string, string>
            {
                ["SessionId"] = sessionId,
                ["CustomerId"] = customerId?.ToString() ?? "anonymous",
                ["ToolsUsedCount"] = toolsUsed.Count.ToString(),
                ["ToolsUsed"] = string.Join(",", toolsUsed.Distinct()),
                ["TotalTokens"] = totalTokens.ToString(),
                ["DurationMs"] = totalDuration.TotalMilliseconds.ToString("F0"),
                ["ResponseLength"] = assistantMessage.Length.ToString()
            });

            _telemetryClient.TrackMetric("AI.Agent.TotalTokensPerConversation", totalTokens);
            _telemetryClient.TrackMetric("AI.Agent.ToolCallsPerConversation", toolsUsed.Count);
            _telemetryClient.TrackMetric("AI.Agent.ConversationDurationMs", totalDuration.TotalMilliseconds);

            operation.Telemetry.Success = true;

            return new AgentResponse
            {
                Response = assistantMessage,
                SuggestedQuestions = suggestions,
                ToolsUsed = toolsUsed.Distinct().ToList()
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

    private string BuildSystemPrompt(int? customerId, string? cultureId = null)
    {
        var cultureInfo = !string.IsNullOrEmpty(cultureId)
            ? $"\n\nIMPORTANT: The customer's preferred language/culture is '{cultureId}'. All responses and product information should be in this language when available. When calling MCP tools, pass the cultureId parameter to retrieve localized content."
            : "";

        return $@"You are a helpful customer service assistant for AdventureWorks, an outdoor and sporting goods retailer.

{(customerId.HasValue ? $"You are currently helping Customer ID: {customerId.Value}" : "You are helping a customer")}{cultureInfo}

You have access to MCP tools that allow you to:
- Retrieve customer order history and order details
- Search for products and get detailed product information
- Find complementary products and personalized recommendations
- Analyze product reviews and customer sentiment
- Check real-time inventory availability across warehouses

Guidelines:
- Be friendly, professional, and helpful
- When you need to use a tool, tell the customer what you're checking
- Provide clear, concise answers
- If you need more information (like order number or product ID), ask for it
- Suggest relevant products and help with purchase decisions
- Always maintain customer context throughout the conversation
- Use the MCP tools naturally when needed to answer customer questions";
    }

    private async Task<List<string>> GenerateSuggestedQuestionsAsync(
        AIAgent agent,
        List<AgentChatMessage> conversationHistory,
        string userMessage,
        string assistantResponse,
        int? customerId)
    {
        try
        {
            var suggestionPrompt = $@"Based on this customer service conversation, generate 2 relevant follow-up questions the customer might want to ask next.

Conversation context:
User: {userMessage}
Assistant: {assistantResponse}

{(customerId.HasValue ? $"Customer ID: {customerId.Value}" : "")}

Generate 2 short, natural follow-up questions (each under 50 characters) that would be helpful for this customer.
Return ONLY the questions as a JSON array of strings, no other text.

Example format: [""Track my order"", ""Find bike helmets""]";

            var thread = agent.GetNewThread();
            var response = await agent.RunAsync(suggestionPrompt);

            // Extract text from AgentRunResponse
            var responseText = response.ToString();

            // Parse JSON array of suggestions
            var suggestions = JsonSerializer.Deserialize<List<string>>(responseText);
            return suggestions ?? new List<string>
            {
                "Tell me more",
                "What else can you help with?"
            };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to generate suggestions, using defaults");
            return new List<string>
            {
                "Show my orders",
                "Search products"
            };
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_mcpClient != null)
        {
            await _mcpClient.DisposeAsync();
        }
    }
}

/// <summary>
/// Chat message for conversation history
/// </summary>
public class AgentChatMessage
{
    public string Role { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
}

/// <summary>
/// Agent response with message and suggestions
/// </summary>
public class AgentResponse
{
    public string Response { get; set; } = string.Empty;
    public List<string> SuggestedQuestions { get; set; } = new();
    public List<string> ToolsUsed { get; set; } = new();
}
