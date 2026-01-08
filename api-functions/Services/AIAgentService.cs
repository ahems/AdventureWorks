using System.Text.Json;
using System.Net.Http.Json;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using OpenAI.Chat;

namespace api_functions.Services;

/// <summary>
/// AI Agent Service - Manages AI agent interactions with MCP tools
/// </summary>
public class AIAgentService
{
    private readonly ILogger<AIAgentService> _logger;
    private readonly IConfiguration _configuration;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly string _endpoint;
    private readonly string _modelDeployment;
    private readonly string _mcpServerUrl;

    public AIAgentService(
        ILogger<AIAgentService> logger,
        IConfiguration configuration,
        IHttpClientFactory httpClientFactory)
    {
        _logger = logger;
        _configuration = configuration;
        _httpClientFactory = httpClientFactory;

        // Get AI Foundry configuration
        _endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");
        _modelDeployment = configuration["chatGptDeploymentName"] ?? "chat";

        // Get MCP server URL (self-reference)
        var websiteHostname = configuration["WEBSITE_HOSTNAME"];
        if (!string.IsNullOrEmpty(websiteHostname))
        {
            // WEBSITE_HOSTNAME may already include https://, so just append the path
            _mcpServerUrl = websiteHostname.TrimEnd('/') + "/api/mcp/call";
        }
        else
        {
            _mcpServerUrl = "http://localhost:7071/api/mcp/call";
        }

        _logger.LogInformation($"AI Agent configured with endpoint: {_endpoint}, model: {_modelDeployment}, MCP: {_mcpServerUrl}");
    }

    /// <summary>
    /// Process a chat message with the AI agent and MCP tools
    /// </summary>
    public async Task<AgentResponse> ProcessMessageAsync(
        string message,
        List<AgentChatMessage> conversationHistory,
        int? customerId = null)
    {
        try
        {
            var credential = new DefaultAzureCredential();
            var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
            var chatClient = client.GetChatClient(_modelDeployment);

            // Build system prompt with MCP tool descriptions
            var systemPrompt = BuildSystemPrompt(customerId);

            // Add system message and conversation history
            var messages = new List<ChatMessage>
            {
                new SystemChatMessage(systemPrompt)
            };

            // Add conversation history
            foreach (var msg in conversationHistory)
            {
                if (msg.Role == "user")
                {
                    messages.Add(new UserChatMessage(msg.Content));
                }
                else if (msg.Role == "assistant")
                {
                    messages.Add(new AssistantChatMessage(msg.Content));
                }
            }

            // Add current user message
            messages.Add(new UserChatMessage(message));

            // Define available MCP tools
            var tools = GetMCPToolDefinitions();
            var chatOptions = new ChatCompletionOptions
            {
                Temperature = 0.7f
            };
            foreach (var tool in tools)
            {
                chatOptions.Tools.Add(tool);
            }

            // Track which tools were used
            var toolsUsed = new List<string>();

            // Call the AI model (may require multiple rounds if tools are called)
            var completion = await chatClient.CompleteChatAsync(messages, chatOptions);
            var responseMessage = completion.Value;

            // Handle function/tool calls
            while (responseMessage.FinishReason == ChatFinishReason.ToolCalls)
            {
                _logger.LogInformation($"AI requested {responseMessage.ToolCalls.Count} tool calls");

                // Add assistant's tool call message to history
                messages.Add(new AssistantChatMessage(responseMessage));

                // Execute each tool call
                foreach (var toolCall in responseMessage.ToolCalls)
                {
                    var functionName = toolCall.FunctionName;
                    var functionArgs = toolCall.FunctionArguments;

                    _logger.LogInformation($"Calling MCP tool: {functionName} with args: {functionArgs}");
                    toolsUsed.Add(functionName);

                    try
                    {
                        // Call MCP server
                        var toolResult = await CallMCPToolAsync(functionName, functionArgs.ToString());

                        // Add tool result to conversation
                        messages.Add(new ToolChatMessage(toolCall.Id, toolResult));
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, $"Error calling MCP tool {functionName}");
                        messages.Add(new ToolChatMessage(toolCall.Id, $"Error: {ex.Message}"));
                    }
                }

                // Get next response from AI with tool results
                completion = await chatClient.CompleteChatAsync(messages, chatOptions);
                responseMessage = completion.Value;
            }

            var assistantMessage = responseMessage.Content[0].Text;

            // Generate contextual follow-up questions
            var suggestions = await GenerateSuggestedQuestionsAsync(
                chatClient,
                conversationHistory,
                message,
                assistantMessage,
                customerId);

            return new AgentResponse
            {
                Response = assistantMessage,
                SuggestedQuestions = suggestions,
                ToolsUsed = toolsUsed
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing agent message");
            throw;
        }
    }

    private string BuildSystemPrompt(int? customerId)
    {
        return $@"You are a helpful customer service assistant for AdventureWorks, an outdoor and sporting goods retailer.

{(customerId.HasValue ? $"You are currently helping Customer ID: {customerId.Value}" : "You are helping a customer")}

You have access to the following tools via MCP server at {_mcpServerUrl}:

1. **get_customer_orders** - Retrieve order history for a customer
   - Parameters: customerId (integer)
   - Use when: Customer asks about their orders, order history, or order status

2. **get_order_details** - Get detailed information about a specific order
   - Parameters: orderId (integer), customerId (integer, optional)
   - Use when: Customer asks about a specific order number

3. **search_products** - Search for products by name, category, or attributes
   - Parameters: searchTerm (string), categoryId (integer, optional)
   - Use when: Customer is looking for products, wants to browse, or needs product recommendations

4. **get_product_details** - Get detailed product information
   - Parameters: productId (integer)
   - Use when: Customer asks about a specific product

5. **find_complementary_products** - Find products frequently purchased together
   - Parameters: productId (integer), limit (integer, default 5)
   - Use when: Customer wants product recommendations or asks ""what goes well with...""

Guidelines:
- Be friendly, professional, and helpful
- When you need to use a tool, tell the customer what you're checking
- Provide clear, concise answers
- If you need more information (like order number or product ID), ask for it
- Suggest relevant products and help with purchase decisions
- Always maintain customer context throughout the conversation";
    }

    /// <summary>
    /// Get MCP tool definitions for function calling
    /// </summary>
    private List<ChatTool> GetMCPToolDefinitions()
    {
        return new List<ChatTool>
        {
            ChatTool.CreateFunctionTool(
                functionName: "get_customer_orders",
                functionDescription: "Get a list of all orders for a specific customer. Returns order IDs, dates, totals, and status.",
                functionParameters: BinaryData.FromString("""
                {
                    "type": "object",
                    "properties": {
                        "customerId": {
                            "type": "integer",
                            "description": "The customer's ID number"
                        }
                    },
                    "required": ["customerId"]
                }
                """)
            ),
            ChatTool.CreateFunctionTool(
                functionName: "get_order_details",
                functionDescription: "Get detailed information about a specific order including line items, products, quantities, and prices.",
                functionParameters: BinaryData.FromString("""
                {
                    "type": "object",
                    "properties": {
                        "orderId": {
                            "type": "integer",
                            "description": "The order ID number"
                        },
                        "customerId": {
                            "type": "integer",
                            "description": "The customer's ID for authorization"
                        }
                    },
                    "required": ["orderId", "customerId"]
                }
                """)
            ),
            ChatTool.CreateFunctionTool(
                functionName: "search_products",
                functionDescription: "Search for products by name or description. Returns matching products with IDs, names, prices, and descriptions.",
                functionParameters: BinaryData.FromString("""
                {
                    "type": "object",
                    "properties": {
                        "searchTerm": {
                            "type": "string",
                            "description": "The search term to find products (e.g., 'bike', 'helmet', 'tent')"
                        }
                    },
                    "required": ["searchTerm"]
                }
                """)
            ),
            ChatTool.CreateFunctionTool(
                functionName: "get_product_details",
                functionDescription: "Get detailed information about a specific product including full description, price, colors, sizes, and availability.",
                functionParameters: BinaryData.FromString("""
                {
                    "type": "object",
                    "properties": {
                        "productId": {
                            "type": "integer",
                            "description": "The product ID number"
                        }
                    },
                    "required": ["productId"]
                }
                """)
            ),
            ChatTool.CreateFunctionTool(
                functionName: "find_complementary_products",
                functionDescription: "Find products that complement or go well with a specific product. Useful for recommendations.",
                functionParameters: BinaryData.FromString("""
                {
                    "type": "object",
                    "properties": {
                        "productId": {
                            "type": "integer",
                            "description": "The product ID to find complementary items for"
                        }
                    },
                    "required": ["productId"]
                }
                """)
            ),
            ChatTool.CreateFunctionTool(
                functionName: "get_personalized_recommendations",
                functionDescription: "Get personalized product recommendations for a customer based on their purchase history, preferences, and buying patterns.",
                functionParameters: BinaryData.FromString("""
                {
                    "type": "object",
                    "properties": {
                        "customerId": {
                            "type": "integer",
                            "description": "Customer ID to generate recommendations for"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of recommendations to return (default: 5)"
                        }
                    },
                    "required": ["customerId"]
                }
                """)
            ),
            ChatTool.CreateFunctionTool(
                functionName: "analyze_product_reviews",
                functionDescription: "Analyze and summarize customer reviews for a product. Returns average rating, review count, sentiment analysis, and common themes.",
                functionParameters: BinaryData.FromString("""
                {
                    "type": "object",
                    "properties": {
                        "productId": {
                            "type": "integer",
                            "description": "Product ID to analyze reviews for"
                        }
                    },
                    "required": ["productId"]
                }
                """)
            ),
            ChatTool.CreateFunctionTool(
                functionName: "check_inventory_availability",
                functionDescription: "Check real-time inventory availability for a product across all warehouse locations. Returns stock levels, locations, and availability status.",
                functionParameters: BinaryData.FromString("""
                {
                    "type": "object",
                    "properties": {
                        "productId": {
                            "type": "integer",
                            "description": "Product ID to check inventory for"
                        }
                    },
                    "required": ["productId"]
                }
                """)
            )
        };
    }

    /// <summary>
    /// Call the MCP server to execute a tool
    /// </summary>
    private async Task<string> CallMCPToolAsync(string toolName, string argumentsJson)
    {
        var httpClient = _httpClientFactory.CreateClient();

        var mcpRequest = new
        {
            name = toolName,  // MCP server expects "name", not "tool"
            arguments = JsonSerializer.Deserialize<Dictionary<string, object>>(argumentsJson)
        };

        var response = await httpClient.PostAsJsonAsync(_mcpServerUrl, mcpRequest);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadAsStringAsync();
        return result;
    }

    private async Task<List<string>> GenerateSuggestedQuestionsAsync(
        ChatClient chatClient,
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

            var messages = new List<ChatMessage>
            {
                new UserChatMessage(suggestionPrompt)
            };

            var completion = await chatClient.CompleteChatAsync(messages);
            var content = completion.Value.Content[0].Text;

            // Parse JSON array of suggestions
            var suggestions = JsonSerializer.Deserialize<List<string>>(content);
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
