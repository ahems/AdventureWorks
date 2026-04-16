# AI Agent Migration to Azure AI Foundry Agents

## Summary

Migrated all four AI agent services in the `api-functions` project from **Microsoft.Agents.AI** (with local `McpClient` tool execution) to **Azure AI Foundry Persistent Agents** (`Azure.AI.Agents.Persistent`). Agents are now defined and managed in Azure AI Foundry; MCP tool execution happens server-side inside Foundry — no client-side MCP wiring is needed.

## Changes Made

### 1. **NuGet Package Updates** ([api-functions.csproj](api-functions/api-functions.csproj))

Removed Microsoft Agents Framework packages:

```xml
<!-- REMOVED -->
<PackageReference Include="Microsoft.Agents.AI" />
<PackageReference Include="Microsoft.Agents.AI.AzureAI" />
<PackageReference Include="Microsoft.Agents.AI.Hosting.AzureFunctions" />
<PackageReference Include="Microsoft.Agents.AI.Workflows" />
<PackageReference Include="ModelContextProtocol" />
```

Added Azure AI Foundry SDK:

```xml
<PackageReference Include="Azure.AI.Agents.Persistent" Version="1.0.0-beta.2" />
<!-- Azure.AI.Projects was already present -->
```

### 2. **Foundry Agent Creation** ([scripts/utilities/create-foundry-agents.sh](scripts/utilities/create-foundry-agents.sh))

New standalone script (called from `postprovision.sh`) that creates all four agents as data-plane resources via `az rest --method PUT`. Each agent definition includes two MCP tool servers:

- **api-mcp** – semantic search / product tools
- **DAB /mcp** – raw entity data tools

Agent IDs are written back to the azd environment (`AI_AGENT_CHAT_ID`, `AI_AGENT_ORDER_ID`, `AI_AGENT_PROMOTION_ID`, `AI_AGENT_HELP_ME_CHOOSE_ID`).

### 3. **Container App Patching** ([scripts/hooks/api-functions-postdeploy.sh](scripts/hooks/api-functions-postdeploy.sh))

New post-deploy hook that reads the four agent IDs from `azd env` and patches the Container App environment variables so the running Functions app can resolve `AI_AGENT_*_ID`.

### 4. **AIAgentService.cs** ([Services/AIAgentService.cs](api-functions/Services/AIAgentService.cs))

**Key Changes:**

- Injected `PersistentAgentsClient` (singleton registered in Program.cs)
- Thread persistence: if `threadId` is supplied the existing Foundry thread is reused; otherwise a new one is created and history bootstrapped
- Polls `RunStatus` until `Completed`; extracts assistant message via `GetMessagesAsync`
- Tool usage collected from `GetRunStepsAsync` → `RunStepFunctionToolCall.Name`
- Returns `AgentResponse { Response, SuggestedQuestions, ToolsUsed, ThreadId }`

**Before:**

```csharp
var mcpClient = await McpClient.CreateAsync(...);
var mcpTools  = await mcpClient.ListToolsAsync();
var chatClient = new AzureOpenAIClient(...).GetChatClient(_modelDeployment).AsIChatClient();
_agent = new ChatClientAgent(chatClient, instructions: ..., tools: mcpTools);
await foreach (var update in agent.RunStreamingAsync(messages)) { ... }
```

**After:**

```csharp
// Thread reuse or creation
var threadId = existing ?? (await _agentsClient.Threads.CreateThreadAsync()).Value.Id;
await _agentsClient.Messages.CreateMessageAsync(threadId, MessageRole.User, message);
var run = await _agentsClient.Runs.CreateRunAsync(threadId, _agentId);
while (run.Value.Status == RunStatus.Queued || run.Value.Status == RunStatus.InProgress)
{
    await Task.Delay(1000);
    run = await _agentsClient.Runs.GetRunAsync(threadId, run.Value.Id);
}
// Extract response and tool names from steps
```

### 5. **PromotionAgentService / OrderGenerationAgentService / HelpMeChooseService**

Same pattern applied to all three services:
- Removed `IHttpClientFactory`, `McpClient`, `ChatClientAgent`, `SemaphoreSlim _initLock`, `AIAgent _agent` fields
- Injected `PersistentAgentsClient` + `_agentId` from config
- Fresh thread per call (stateless); poll to completion; extract last assistant message

### 6. **Thread Persistence in the Frontend**

- `app/src/lib/mcpService.ts`: `threadId?` added to `AgentChatRequest` and `AgentChatResponse`
- `app/src/components/AIChatOverlay.tsx`: `useState<string | undefined>` tracks `threadId`; passed on each request and stored from each response; cleared when the overlay is closed or language changes

## Architecture After Migration

```
Browser → AIChatOverlay     → POST /api/agent/chat { message, threadId? }
                            ← { response, suggestedQuestions, toolsUsed, threadId }

api-functions/AIAgentFunctions.cs
  → AIAgentService.ProcessMessageAsync(message, history, customerId, cultureId, threadId?)
    → PersistentAgentsClient.Runs.CreateRunAsync(threadId, agentId)
    → Foundry Runs the agent on-platform:
        ↳ Calls api-mcp MCP tools
        ↳ Calls DAB /mcp MCP tools
    → Poll RunStatus → Completed
    → GetMessagesAsync → response text
    → GetRunStepsAsync → tool names used
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
