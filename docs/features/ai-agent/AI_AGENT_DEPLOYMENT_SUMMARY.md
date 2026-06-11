# AI Agent Deployment Automation - Summary

## What Was Implemented

Automated Azure AI Foundry Agent creation has been fully integrated into the Azure deployment pipeline. All **eight agents** (five base agents + three workflow routing agents) are created automatically during `azd provision` with zero manual configuration required. Every agent uses the full set of Foundry platform features: named memory stores, structured inputs (Handlebars), MCP tools, and multi-turn conversation via `previous_response_id`.

## Files Created/Modified

### New Files

1. **`scripts/utilities/create-foundry-agents.sh`**
   - Creates all four base agents and three workflow routing agents via `az rest --method PUT`
   - Base agents: chat, order, promotion, help-me-choose, customer
   - Workflow agents: chat-workflow, promotion-workflow, order-workflow (created last; reference base agents)
   - Reads `AI_FOUNDRY_PROJECT_ENDPOINT`, `MCP_SERVICE_URL`, `API_URL` from azd env
   - Registers two MCP tool servers per base agent (api-mcp + DAB /mcp)
   - Stores all returned agent IDs back to azd environment

2. **`scripts/hooks/api-functions-postdeploy.sh`**
   - Post-deploy hook for `api-functions` service
   - Reads all seven agent IDs from azd env
   - Patches the Container App with `AI_AGENT_*_ID` and `AI_AGENT_WORKFLOW_*_ID` environment variables

### Modified Files

1. **`scripts/hooks/postprovision.sh`**
   - Calls `create-foundry-agents.sh` at the end of provisioning

2. **`azure.yaml`**
   - Added `postdeploy` hook for `api-functions` service → `api-functions-postdeploy.sh`

3. **`infra/modules/aca-api-functions.bicep`**
   - Added `AI_FOUNDRY_PROJECT_ENDPOINT` env var
   - Added `AI_AGENT_WORKFLOW_PROMOTION_ID`, `AI_AGENT_WORKFLOW_ORDER_ID`, `AI_AGENT_WORKFLOW_HELP_ME_CHOOSE_ID` parameter bindings
   - Added KEDA scaling rule for `simulation-order-queue` (queue-length threshold: 5)

4. **`infra/modules/storage.bicep`**
   - Added `simulation-order-queue` for autonomous AI-driven order simulation

5. **`workflows/`** directory — new intent-routing workflow YAMLs
   - `chat-product-advisor.yaml` — routes between chat and help-me-choose agents
   - `admin-promotion-advisor.yaml` — gathers promo parameters then invokes promotion agent
   - `admin-order-advisor.yaml` — identifies persona/customer then invokes order agent

6. **`api-functions/api-functions.csproj`**
   - Removed `Microsoft.Agents.AI.*` packages and `ModelContextProtocol`
   - Added `Azure.AI.Agents.Persistent`

## How It Works

### Deployment Flow

```
azd up
  ↓
azd provision (Bicep templates)
  ↓
postprovision.sh hook
  ↓
┌────────────────────────────────────────────────┐
│ 1. Configure database roles                     │
│ 2. Deploy seed-job for data import              │
│ 3. Run create-foundry-agents.sh                 │
│    → Creates 4 Foundry agents with MCP servers │
│    → Stores AI_AGENT_*_ID in azd env           │
└────────────────────────────────────────────────┘
  ↓
azd deploy (application code)
  ↓
api-functions-postdeploy.sh hook
  ↓
┌────────────────────────────────────────────────┐
│ Patches Container App with AI_AGENT_*_ID vars  │
└────────────────────────────────────────────────┘
  ↓
✅ Ready to use!
```

## Runtime Features

The seven deployed agents use the following Azure AI Foundry Responses API features at runtime. These are applied by `FoundryAgentClient` in `api-functions`:

| Agent                    | Memory store                  | `x-memory-user-id` scope                                | `tool_choice` | Multi-turn | Structured inputs                                                                                                                   |
| ------------------------ | ----------------------------- | ------------------------------------------------------- | ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**                 | `eshop-chat-memory`           | `customer-{customerId}`                                 | `auto`        | ✅ Yes     | `customerId`, `cultureId`, `userName`                                                                                               |
| **Help-Me-Choose**       | `eshop-help-me-choose-memory` | `customer-{customerId}` (or anonymous)                  | `required`    | ✅ Yes     | `cultureId`, `profileContext`, `userId`                                                                                             |
| **Order Generation**     | `admin-order-memory`          | `order-gen-customer-{id}` or `order-gen-persona-{type}` | `required`    | ✅ Yes     | `todayDate`, `personaDescription`, `isExistingCustomer`, `customerName`, `customerId`, `orderCount`, `totalSpend`, `recentProducts` |
| **Promotion Generation** | `admin-promotion-memory`      | `promotion-gen-{type}`                                  | `required`    | ✅ Yes     | `promotionType`, `offerCategory`, `todayDate`, `categoryName`, `subcategoryName`, `categoryId`, `subcategoryId`                     |
| **Customer Generation**  | `admin-customer-memory`       | `customer-gen-locale-{locale}`                          | `auto`        | ❌ No      | `locale`, `todayDate`                                                                                                               |
| **Chat Workflow**        | — (delegates to base agents)  | —                                                       | —             | —          | Routes between chat and help-me-choose based on user intent                                                                         |
| **Promotion Workflow**   | — (delegates to Promotion)    | —                                                       | —             | —          | Gathers `promotionType`, `offerCategory`, category filters before invoking Promotion agent                                          |
| **Order Workflow**       | — (delegates to Order)        | —                                                       | —             | —          | Identifies persona/customer, gathers constraints before invoking Order agent                                                        |

**Why `tool_choice: "required"` on three agents?** Order Generation, Promotion Generation, and Help-Me-Choose must call MCP tools to retrieve live catalog/inventory data. Without enforcement, the model may answer from training knowledge — producing hallucinated product IDs or prices that get written to the database as real orders or promotions.

**Why multi-turn on all base agents?** Admins and customers can refine results in follow-up messages. The Foundry `previous_response_id` chains responses so context (catalog choices, past answers) is retained across turns without the frontend managing conversation history.

## Autonomous Order Simulation

The Order Generation agent also runs fully autonomously via the `simulation-order-queue` queue, without any UI interaction:

```
POST /api/simulation/orders/start  { "count": 50, "customerId": 0 }
  ↓
Enqueues N SimulationOrderMessage objects  { customerId: 0|N, personaHint?: string }
  ↓
SimulationOrderQueueTrigger (queue trigger, batchSize=1)
  ↓
Maps customerId==0 → random persona  |  customerId>0 → existing-customer
  ↓
OrderGenerationAgentService.GenerateOrderAsync()  (same path as admin UI)
  ↓
Azure AI Foundry agent → MCP tools (search products, check inventory) → create order in SQL
```

KEDA auto-scales the Container App from 0 to N replicas based on `simulation-order-queue` depth (threshold: 5 messages). The manufacturing simulator uses `POST /api/simulation/orders/start` to drive realistic e-shop load at a controlled pace.

**Why structured inputs?** Dynamic context (customer ID, persona description, today's date, category filters) used to be embedded directly in the user message string in C#. Moving these to Foundry structured inputs (`{{variable}}` Handlebars templates in each agent's portal instructions) keeps user messages short and constant, avoids prompt injection via user-controlled strings, and lets the portal instructions be the single source of truth for agent behaviour.

> **Portal prerequisite**: Each agent's Foundry portal definition must declare a `structured_inputs` schema before these variable values will resolve. See [AI_AGENT_AUTOMATION.md](AI_AGENT_AUTOMATION.md#structured-inputs) for the full variable list per agent.

## Usage Examples

### Test After Deployment

```bash
# Default test
python3 test_agent.py

# Custom queries
python3 test_agent.py "What mountain bikes do you have?"
python3 test_agent.py "I'm customer 29825, show my orders"
```

### Integration in Code

```python
import json
from agent_framework import ChatAgent, MCPStreamableHTTPTool
from agent_framework_azure_ai import AzureAIAgentClient
from azure.identity.aio import DefaultAzureCredential

# Load auto-generated config
with open("AI_AGENT_CONFIG.json") as f:
    config = json.load(f)

# Use the agent (see AI_AGENT_AUTOMATION.md for full example)
```

## Prerequisites

The automation requires:

- ✅ Python 3.8+ (already in dev container)
- ✅ Azure CLI logged in (handled by azd)
- ✅ Azure AI Foundry deployed (done by Bicep)
- ✅ MCP Server deployed (done by azd deploy)

If Python is not available, the script gracefully skips agent creation with a warning.

## Error Handling

The postprovision script:

- ✅ Checks for Python availability
- ✅ Verifies required packages
- ✅ Validates configuration values
- ✅ Tests agent before saving config
- ✅ Provides clear error messages
- ✅ Continues deployment even if agent creation fails

## Benefits

1. **Zero Manual Setup** - Agent created automatically
2. **Always Up-to-Date** - Uses latest deployment URLs
3. **Tested on Creation** - Verifies agent works
4. **Ready to Use** - Test script provided
5. **Easy Integration** - Config file for custom code
6. **Idempotent** - Can re-run safely
7. **Documented** - Comprehensive docs included

## Next Steps

After deployment:

1. ✅ Test the agent: `python3 test_agent.py`
2. ⏳ Build chat UI that uses the agent
3. ⏳ Add user authentication to pass CustomerID
4. ⏳ Customize agent instructions
5. ⏳ Add more MCP tools as needed
6. ⏳ Monitor usage in Application Insights

## Related docs

- End-to-end automation details: [AI_AGENT_AUTOMATION.md](AI_AGENT_AUTOMATION.md)
- Migration to Microsoft Agents Framework: [AGENT_FRAMEWORK_MIGRATION.md](AGENT_FRAMEWORK_MIGRATION.md)
- Telemetry implementation and Kusto queries: [AI_AGENT_TELEMETRY_IMPLEMENTATION.md](AI_AGENT_TELEMETRY_IMPLEMENTATION.md), [APP_INSIGHTS_INTEGRATION.md](APP_INSIGHTS_INTEGRATION.md), [APP_INSIGHTS_CONNECTION_STRING_FLOW.md](APP_INSIGHTS_CONNECTION_STRING_FLOW.md)
- MCP server and tools surface: [../api-mcp/README.md](../api-mcp/README.md)
- Functions that expose the chat endpoints: [../api-functions/README.md](../api-functions/README.md)
- AI agent and MCP testing scripts: [AI_AND_MCP_TESTING_GUIDE.md](AI_AND_MCP_TESTING_GUIDE.md), [AI_CHAT_MCP_TESTING.md](AI_CHAT_MCP_TESTING.md)

## Related Documentation

- [AI_AGENT_AUTOMATION.md](AI_AGENT_AUTOMATION.md) - Full automation guide
- [api-functions/MCP_SERVER.md](api-functions/MCP_SERVER.md) - MCP Server docs
- [MCP_CUSTOMERID_MIGRATION.md](MCP_CUSTOMERID_MIGRATION.md) - CustomerID changes
- [scripts/README.md](scripts/README.md) - Deployment scripts
