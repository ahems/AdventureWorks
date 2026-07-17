# AI Agent Migration to Azure AI Foundry Agents

## Summary

All four AI agent services in `api-functions` have been fully migrated to the **Azure AI Foundry Responses API** (`FoundryAgentClient` / `Azure.AI.Projects`). Agents are defined and managed in Azure AI Foundry; MCP tool execution happens server-side inside Foundry — no client-side MCP wiring is needed.

Every agent now uses the complete Foundry platform feature set:

- **Named memory stores** — long-term context retained per user/persona across sessions
- **Structured inputs** — Handlebars `{{variable}}` placeholders resolved by Foundry at invocation time (prevents prompt injection)
- **MCP tools** — live catalog/inventory data access; `tool_choice: "required"` on three agents to prevent hallucinations
- **Multi-turn** — `previous_response_id` chains turns so admins and customers can refine results in follow-up messages
- **Workflow routing agents** — three new workflow YAMLs route conversational intent to the correct base agent

### Phase 1 (completed earlier): Chat agent

Migrated the chat agent from **Microsoft.Agents.AI** (with local `McpClient` tool execution) to the Foundry Responses API.

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

## Architecture After Full Migration

All four agents now share the same `FoundryAgentClient` pattern:

```
Customer app (eshop)
  Browser → AIChatOverlay         → POST /api/agent/chat { message, threadId? }
                                  ← { response, suggestedQuestions, toolsUsed, threadId }

  Browser → HelpMeChooseWizard    → POST /api/helpme/questions { profile, ... }
                                  ← { questions, threadId }         ← NEW: threadId
                                  → POST /api/helpme/recommend  { answers, previousThreadId }
                                  ← { recommendations, threadId }   ← NEW: chained turn

Admin app
  Browser → GeneratePromotionDialog → POST /api/GeneratePromotion { type, ... }
                                    ← { suggestion, threadId }       ← NEW: threadId
                                    → POST /api/GeneratePromotion { refinement, previousThreadId }
                                    ← { refined suggestion, threadId }

  Browser → GenerateOrdersDialog    → POST /api/GenerateOrderWithAI { persona, ... }
                                    ← { order, threadId }             ← NEW: threadId
                                    → POST /api/GenerateOrderWithAI  { refinement, previousThreadId }
                                    ← { refined order, threadId }

Autonomous (no UI)
  Queue message { customerId: 0|N }
    → SimulationOrderQueueTrigger
    → OrderGenerationAgentService.GenerateOrderAsync()
    → FoundryAgentClient.InvokeAsync()
```

**Common invocation pattern** (`FoundryAgentClient.InvokeAsync`):

```csharp
var response = await _foundryClient.InvokeAsync(
    agentId:            _agentId,              // or workflow agent ID
    userMessage:        message,
    previousResponseId: threadId,              // null on first turn; chains multi-turn
    userId:             memoryUserId,          // → x-memory-user-id header for Foundry memory
    structuredInputs:   inputs,                // Handlebars {{variable}} resolution
    toolChoice:         "required" | "auto");  // required on 3 agents; auto on chat
```

## Phase 2 Changes: Help-Me-Choose, Promotion, Order

### 1. **HelpMeChooseService.cs** — Migrate questions phase + two-phase chaining

**Before:** `GetQuestionsAsync` called Azure OpenAI directly (stateless, no agent context).

**After:**

- `GetQuestionsAsync` invokes `FoundryAgentClient.InvokeAsync()` using the Help-Me-Choose agent with `profileContext` structured input; returns a `threadId`
- `GetRecommendationsAsync` accepts `previousThreadId` and passes it as `previousResponseId` so the recommendations turn sees the full questions context in one stored Foundry conversation

### 2. **PromotionAgentService.cs** — Multi-turn refinement

`GeneratePromotionAsync` accepts an optional `previousResponseId`. When present, Foundry continues the stored conversation — the admin can say "change the discount to 25%" and get a refined suggestion without repeating all inputs.

### 3. **OrderGenerationAgentService.cs** — Multi-turn refinement

Same pattern as Promotion. `GenerateOrderAsync` accepts `previousResponseId`. Admins can refine persona constraints in follow-up turns.

### 4. **Agent creation scripts** — Memory stores, structured inputs, MCP tools

| Script                              | New additions                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `eshop-help-me-choose-agent.sh`     | Added `userId` + `profileContext` to `structured_inputs`                      |
| `admin-promotion-agent.sh`          | Added `admin-promotion-memory` store, `structured_inputs`, MCP tool allowlist |
| `admin-order-agent.sh`              | Added `admin-order-memory` store, `structured_inputs`, MCP tool allowlist     |
| `admin-promotion-workflow-agent.sh` | NEW — creates workflow agent referencing `admin-promotion-advisor.yaml`       |
| `admin-order-workflow-agent.sh`     | NEW — creates workflow agent referencing `admin-order-advisor.yaml`           |

### 5. **Workflow YAMLs** (`workflows/` directory)

| File                           | Purpose                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `chat-product-advisor.yaml`    | Routes chat vs product-advisor intent                                       |
| `admin-promotion-advisor.yaml` | NEW — gathers promo type + category, then invokes promotion agent           |
| `admin-order-advisor.yaml`     | NEW — identifies persona/customer, gathers constraints, invokes order agent |

### 6. **Frontend — Multi-Turn Refinement UI**

- `app/src/lib/helpMeService.ts` — `threadId?` on questions response; `previousThreadId?` on recommendations request
- `app/src/components/HelpMeChooseWizard.tsx` — stores `questionsThreadId`; passes as `previousThreadId` to recommendations
- `app-admin/src/services/utilityService.ts` — `threadId?` / `previousThreadId?` on promotion + order API calls
- `app-admin/src/components/GeneratePromotionWizardDialog.tsx` — added **Refine** step after Review
- `app-admin/src/components/GenerateOrdersWizardDialog.tsx` — added **Refine** step after results

### 7. **Autonomous Order Simulation** — Phase 8

New queue-driven entry point for the manufacturing simulator:

- `api-functions/Models/SimulationOrderMessage.cs` — `{ customerId: int, personaHint?: string }`
- `api-functions/Functions/SimulationOrderQueueTrigger.cs` — queue trigger on `simulation-order-queue`; also exposes `POST /api/simulation/orders/start` for batch enqueue with pace control
- `infra/modules/storage.bicep` — added `simulation-order-queue`
- `infra/modules/aca-api-functions.bicep` — KEDA rule scales 0→N on queue depth ≥ 5

The Order agent is invoked identically whether triggered from the admin UI, the bulk endpoint, or the simulation queue.

## Architecture Diagram (after all phases)

```
scripts/utilities/agents/
  eshop-chat-agent.sh               → AI_AGENT_CHAT_ID
  eshop-help-me-choose-agent.sh     → AI_AGENT_HELP_ME_CHOOSE_ID
  admin-promotion-agent.sh          → AI_AGENT_PROMOTION_ID
  admin-order-agent.sh              → AI_AGENT_ORDER_ID
  eshop-workflow-agent.sh           → AI_AGENT_WORKFLOW_CHAT_ID
  admin-promotion-workflow-agent.sh → AI_AGENT_WORKFLOW_PROMOTION_ID
  admin-order-workflow-agent.sh     → AI_AGENT_WORKFLOW_ORDER_ID

workflows/
  chat-product-advisor.yaml         (referenced by eshop-workflow-agent)
  admin-promotion-advisor.yaml      (referenced by admin-promotion-workflow-agent)
  admin-order-advisor.yaml          (referenced by admin-order-workflow-agent)

api-functions/Services/
  FoundryAgentClient.cs             (shared singleton — Responses API, approval loop)
  AIAgentService.cs                 → AI_AGENT_WORKFLOW_CHAT_ID (prefers) / AI_AGENT_CHAT_ID
  HelpMeChooseService.cs            → AI_AGENT_WORKFLOW_HELP_ME_CHOOSE_ID / AI_AGENT_HELP_ME_CHOOSE_ID
  PromotionAgentService.cs          → AI_AGENT_WORKFLOW_PROMOTION_ID / AI_AGENT_PROMOTION_ID
  OrderGenerationAgentService.cs    → AI_AGENT_WORKFLOW_ORDER_ID / AI_AGENT_ORDER_ID
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
- Compatible with .NET 10 and Azure Functions V4
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
