# AI Agent Migration to Microsoft Agents Framework

## Summary

Successfully migrated the chat agent in the `api-functions` project from manual Azure OpenAI integration to the **Microsoft Agents Framework (Microsoft.Agents.AI)** with durable agent capabilities and comprehensive observability.

## Changes Made

### 1. **NuGet Package Updates** ([api-functions.csproj](api-functions/api-functions.csproj))

Added Microsoft Agents Framework packages:

```xml
<PackageReference Include="Microsoft.Agents.AI" Version="*-*" />
<PackageReference Include="Microsoft.Agents.AI.AzureAI" Version="*-*" />
<PackageReference Include="Microsoft.Agents.AI.Hosting.AzureFunctions" Version="*-*" />
<PackageReference Include="Microsoft.Agents.AI.Workflows" Version="*-*" />
```

Updated DurableTask packages for compatibility:

```xml
<PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.DurableTask" Version="1.11.0" />
<PackageReference Include="Microsoft.DurableTask.Client" Version="1.18.0" />
```

### 2. **AIAgentService Migration** ([Services/AIAgentService.cs](api-functions/Services/AIAgentService.cs))

**Key Changes:**

- Replaced manual OpenAI SDK usage with **Microsoft Agents Framework**
- Integrated **Model Context Protocol (MCP)** using native `McpClient` from `ModelContextProtocol` package
- Implemented **lazy initialization** pattern for agent and MCP client
- Added **thread-based conversation management** for durability
- Streaming responses via `RunStreamingAsync()`

**Before:**

```csharp
var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
var chatClient = client.GetChatClient(_modelDeployment);
var completion = await chatClient.CompleteChatAsync(messages, chatOptions);
// Manual tool call handling loop...
```

**After:**

```csharp
var chatClient = client.GetChatClient(_modelDeployment).AsIChatClient();
_agent = new ChatClientAgent(
    chatClient,
    instructions: systemInstructions,
    name: "AdventureWorks Customer Service Agent",
    tools: mcpTools.ToArray()
);
await foreach (var update in agent.RunStreamingAsync(message, thread))
{
    // Framework handles tool calls automatically
}
```

**MCP Integration:**

- Replaces custom JSON-RPC implementation with native `McpClient`
- MCP tools are automatically discovered from the external api-mcp service via HTTP
- Framework handles tool execution and result marshalling

### 3. **Program.cs Configuration** ([Program.cs](api-functions/Program.cs))

Added OpenTelemetry sources for Agent Framework:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddHttpClientInstrumentation()
            .AddSqlClientInstrumentation(options =>
            {
                options.SetDbStatementForText = true;
            })
            .AddSource("Microsoft.Agents.*")  // Agent Framework tracing
            .AddSource("AIAgentService");      // Custom agent service tracing
    });
```

Updated service registration:

```csharp
builder.Services.AddScoped<AIAgentService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<AIAgentService>>();
    var httpClientFactory = sp.GetRequiredService<IHttpClientFactory>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();

    return new AIAgentService(
        logger,
        configuration,
        httpClientFactory,
        telemetryClient);
});
```

### 4. **Function Endpoint Updates** ([Functions/AIAgentFunctions.cs](api-functions/Functions/AIAgentFunctions.cs))

Updated status endpoint to reflect new capabilities:

```json
{
  "status": "operational",
  "version": "2.0",
  "framework": "Microsoft.Agents.AI",
  "features": [
    "conversational-ai",
    "mcp-tool-integration",
    "durable-agent-threads",
    "contextual-suggestions",
    "order-tracking",
    "product-search",
    "recommendations",
    "streaming-responses",
    "observability-telemetry"
  ]
}
```

## Architecture

### Agent Lifecycle

```
User Request → AIAgentFunctions.Chat()
    ↓
AIAgentService.ProcessMessageAsync()
    ↓
GetOrCreateAgentAsync() (lazy init)
    ├── Initialize McpClient (HTTP transport to api-mcp)
    ├── List available MCP tools
    └── Create ChatClientAgent with tools
    ↓
agent.RunStreamingAsync() → Streaming responses
    └── Framework handles tool calls automatically
```

### Key Features

1. **Durable Agent Threads**
   - Thread-based conversation persistence
   - Session correlation via customer ID
   - Context maintained across multiple turns

2. **Native MCP Tool Integration**
   - Automatic tool discovery from api-mcp service
   - Framework-managed tool execution
   - No manual JSON-RPC handling required

3. **Streaming Responses**
   - Real-time response generation
   - Reduced latency for users
   - Production-grade pattern

4. **Comprehensive Observability**
   - Application Insights integration
   - OpenTelemetry distributed tracing
   - Custom metrics for tokens, duration, tool usage
   - Session correlation

## Benefits

### Developer Experience

- ✅ Simplified code - no manual tool call loops
- ✅ Type-safe MCP tool integration
- ✅ Built-in thread management
- ✅ Streaming-first design

### Performance

- ✅ Lazy agent initialization
- ✅ Thread reuse for conversation context
- ✅ Streaming reduces perceived latency

### Observability

- ✅ Automatic OpenTelemetry spans
- ✅ Tool usage tracking
- ✅ Token consumption metrics
- ✅ Session correlation

### Maintainability

- ✅ Framework handles protocol details
- ✅ Clear separation of concerns
- ✅ Extensible tool integration

## Local Development Setup

### Prerequisites

The Azure Functions require connection to the MCP (Model Context Protocol) server for AI agent tool integration.

**Use Azure-Hosted MCP Server (Recommended for Local Dev):**

1. Get the Azure MCP service URL:

   ```bash
   azd env get-values | grep MCP_SERVICE_URL
   ```

2. Add to `api-functions/local.settings.json`:
   ```json
   {
     "Values": {
       "MCP_SERVICE_URL": "https://av-mcp-xxxxx.azurecontainerapps.io/mcp"
     }
   }
   ```

**Run Local MCP Server (Optional - for MCP Development):**

Only needed if you're developing the MCP server itself:

```bash
cd api-mcp && dotnet run
# Then set: "MCP_SERVICE_URL": "http://localhost:5000/mcp"
```

## Testing

Build verification:

```bash
cd api-functions
dotnet restore
dotnet build
```

Run locally:

```bash
# Terminal 1: Start MCP server
cd api-mcp && npm start

# Terminal 2: Start Functions
cd api-functions && func host start
```

Test endpoint:

```bash
curl -X POST http://localhost:7071/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Find me bike helmets",
    "customerId": 123
  }'
```

## Migration Notes

## Related docs

- AI agent automation and deployment: [AI_AGENT_AUTOMATION.md](AI_AGENT_AUTOMATION.md), [AI_AGENT_DEPLOYMENT_SUMMARY.md](AI_AGENT_DEPLOYMENT_SUMMARY.md)
- AI agent telemetry and monitoring: [AI_AGENT_TELEMETRY_IMPLEMENTATION.md](AI_AGENT_TELEMETRY_IMPLEMENTATION.md), [APP_INSIGHTS_INTEGRATION.md](APP_INSIGHTS_INTEGRATION.md), [APP_INSIGHTS_CONNECTION_STRING_FLOW.md](APP_INSIGHTS_CONNECTION_STRING_FLOW.md)
- MCP server and tools surface: [../api-mcp/README.md](../api-mcp/README.md)
- Functions project and chat endpoint: [../api-functions/README.md](../api-functions/README.md)
- AI agent and MCP testing flows: [AI_AND_MCP_TESTING_GUIDE.md](AI_AND_MCP_TESTING_GUIDE.md), [AI_CHAT_MCP_TESTING.md](AI_CHAT_MCP_TESTING.md)

**Breaking Changes:**

- None - external API contract remains unchanged
- Internal implementation completely rewritten

**Compatibility:**

- Requires Microsoft.Agents.AI preview packages (`*-*` version)
- Compatible with .NET 8 and Azure Functions V4
- MCP server must be running and accessible

**Configuration:**

- Same environment variables required:
  - `AZURE_OPENAI_ENDPOINT`
  - `chatGptDeploymentName`
  - `MCP_SERVICE_URL`

## Future Enhancements

- [ ] Add multi-agent orchestration patterns
- [ ] Implement workflow-based agent chaining
- [ ] Add agent state persistence to durable storage
- [ ] Enable human-in-the-loop approval flows
- [ ] Add more granular OpenTelemetry metrics

## References

- [Microsoft Agents Framework GitHub](https://github.com/microsoft/agent-framework)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Azure Functions Durable](https://learn.microsoft.com/azure/azure-functions/durable/)
- [OpenTelemetry .NET](https://opentelemetry.io/docs/languages/net/)
