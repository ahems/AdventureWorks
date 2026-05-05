# AI Agent Automation

This document describes the automated AI Agent creation process integrated into the Azure deployment pipeline.

## Overview

During `azd provision`, the deployment automatically creates **seven Azure AI Foundry Agents** (four base agents + three workflow routing agents) that integrate with the AdventureWorks MCP servers. This eliminates the need for manual agent setup and ensures agents are always configured correctly with the latest deployment.

## Automated Process

### What Gets Created

When you run `azd up` or `azd provision`, the system automatically:

1. **Deploys Infrastructure** (via Bicep templates)
   - Azure AI Foundry Hub + Project
   - Azure OpenAI with GPT model deployments
   - Azure Container Apps (api-functions, api-mcp, DAB)
   - All supporting Azure resources

2. **Creates Foundry Agents** (`scripts/utilities/create-foundry-agents.sh`, called from `postprovision.sh`)

   **Base agents** (invoked directly for business logic):
   - **Chat Agent** (`AI_AGENT_CHAT_ID`) — customer service chat, product recommendations, order tracking
   - **Help Me Choose Agent** (`AI_AGENT_HELP_ME_CHOOSE_ID`) — multi-phase product advisor wizard
   - **Promotion Agent** (`AI_AGENT_PROMOTION_ID`) — promotion strategy generation with live catalog data
   - **Order Generation Agent** (`AI_AGENT_ORDER_ID`) — autonomous order simulation for any persona

   **Workflow routing agents** (created last; each references a base agent via a workflow YAML):
   - **Chat Workflow Agent** (`AI_AGENT_WORKFLOW_CHAT_ID`) — routes between chat and product advisor
   - **Promotion Workflow Agent** (`AI_AGENT_WORKFLOW_PROMOTION_ID`) — gathers promo parameters, invokes promotion agent
   - **Order Workflow Agent** (`AI_AGENT_WORKFLOW_ORDER_ID`) — identifies persona, gathers constraints, invokes order agent

   Each base agent is registered with two MCP tool servers:
   - `api-mcp` service (semantic product/catalog tools)
   - DAB `/mcp` endpoint (raw entity data tools)

3. **Injects Agent IDs** (`scripts/hooks/api-functions-postdeploy.sh`)
   - After `azd deploy`, patches the `api-functions` Container App with all agent IDs as environment variables

4. **Environment Variables** (available in azd environment)
   - `AI_FOUNDRY_PROJECT_ENDPOINT`: Azure AI Foundry project endpoint
   - `AI_AGENT_CHAT_ID`: Foundry agent ID for chat
   - `AI_AGENT_ORDER_ID`: Foundry agent ID for order generation
   - `AI_AGENT_PROMOTION_ID`: Foundry agent ID for promotions
   - `AI_AGENT_HELP_ME_CHOOSE_ID`: Foundry agent ID for the wizard
   - `AI_AGENT_WORKFLOW_CHAT_ID`: Workflow agent that routes chat vs product-advisor
   - `AI_AGENT_WORKFLOW_PROMOTION_ID`: Workflow agent for promotion campaign generation
   - `AI_AGENT_WORKFLOW_ORDER_ID`: Workflow agent for autonomous order simulation
   - `MCP_SERVICE_URL`: api-mcp service endpoint

## Agent Configuration

### Agent Details

Each agent is created via `az rest --method PUT` to the Foundry data plane API with:

- **Model:** Auto-selected from `chatGptDeploymentName` env var (e.g., `gpt-4.1-mini`)
- **Authentication:** Azure Managed Identity (passwordless)
- **Tool Servers:** Two MCP servers registered per agent
  - `api-mcp` — custom semantic tools (SearchProducts, GetCustomerOrders, etc.)
  - DAB `/mcp` — GraphQL entity tools (Product, Customer, SalesOrder, etc.)

### re-running Agent Creation

The creation script is idempotent — re-running `postprovision.sh` will recreate agents. To update an agent's instructions or tool configuration, edit `scripts/utilities/create-foundry-agents.sh` and re-run:

```bash
bash scripts/utilities/create-foundry-agents.sh
```

## Thread Persistence

Each conversation uses a Foundry-managed `previous_response_id` that persists across requests. The frontend stores the `threadId` (which holds the Foundry response ID) and sends it with each subsequent request; the C# service chains responses via `previous_response_id` for full context continuity — no client-side thread management is needed.

## Structured Inputs

Each agent's Foundry portal definition must declare a `structured_inputs` schema listing the Handlebars variables used in its instructions. The `api-functions` code passes runtime values for these at invocation time, and Foundry resolves `{{variable}}` placeholders before the model sees the instructions.

> **Prerequisite**: If you recreate or modify an agent via `create-foundry-agents.sh`, re-add the `structured_inputs` schema block in the Foundry portal for that agent. Without it, Handlebars placeholders remain unresolved and context is lost.

### Variables per agent

| Agent                | Variables declared in portal `structured_inputs` schema                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat                 | `customerId` (string), `cultureId` (string), `userName` (string)                                                                           |
| Help-Me-Choose       | `cultureId` (string, default `"en"`), `profileContext` (string — JSON catalog/shopper hint), `userId` (string — for memory scoping)        |
| Order Generation     | `todayDate`, `personaDescription`, `isExistingCustomer` (bool), `customerName`, `customerId`, `orderCount`, `totalSpend`, `recentProducts` |
| Promotion Generation | `promotionType`, `offerCategory`, `todayDate`, `categoryName`, `subcategoryName`, `categoryId`, `subcategoryId`                            |

> `isExistingCustomer`, `categoryName`, `subcategoryName`, `categoryId`, `subcategoryId`, `customerName`, `customerId`, `orderCount`, `totalSpend`, `recentProducts`, and `profileContext` should be marked **optional** in the portal schema so Handlebars `{{#if}}` branches work correctly when those values are absent.

## Memory Stores

Each agent maintains a named Foundry memory store for long-term context. Memory is scoped per user/context via the `x-memory-user-id` header set by `FoundryAgentClient`.

| Agent                | Memory Store Name             | What Is Retained                                                                                | What Is Excluded                      |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| Chat                 | `eshop-chat-memory`           | Preferred bike category, activity level, budgets, clothing/shoe sizes, brand preferences        | Payment details, passwords, addresses |
| Help-Me-Choose       | `eshop-help-me-choose-memory` | Sport/activity preferences, skill level, budget constraints, past recommendations               | Sensitive personal or financial data  |
| Promotion Generation | `admin-promotion-memory`      | Promotion type patterns, category performance insights, seasonal timing, discount effectiveness | Individual customer PII, payment data |
| Order Generation     | `admin-order-memory`          | Persona order patterns, product performance by persona type, successful order compositions      | Customer PII, financial data          |

Memory scoping headers set by `FoundryAgentClient`:

- Chat: `customer-{customerId}`
- Help-Me-Choose: `customer-{customerId}` (anonymous if no login)
- Promotion: `promotion-gen-{promotionType}`
- Order: `order-gen-customer-{customerId}` or `order-gen-persona-{personaType}`

The `isExistingCustomer`, `categoryName`, `subcategoryName`, `categoryId`, and `subcategoryId` variables should be declared as optional in the schema so agents handle both the `{{#if ...}}` and `{{else}}` branches of Handlebars conditionals correctly.

## Agent Configuration

The created agent has the following characteristics:

### Agent Details

- **Name:** AdventureWorks Customer Service Agent
- **Model:** Auto-selected based on availability (e.g., `gpt-4.1-mini`, `gpt-4o-mini`)
- **Endpoint:** Your Azure AI Foundry instance
- **Authentication:** Azure Managed Identity (passwordless)

### MCP Tools Available

1. **get_customer_orders** - Retrieve customer order history by CustomerID
2. **get_order_details** - Get detailed order information with optional customer validation
3. **find_complementary_products** - AI-powered product recommendations
4. **search_products** - Search product catalog
5. **get_product_details** - Get detailed product information

### Agent Instructions

The agent is pre-configured with instructions for:

- Order tracking and status inquiries
- Product searches and recommendations
- Finding complementary products
- Customer order history queries

## Using the Agent

### Quick Test

After deployment completes, test the agent immediately:

```bash
# Test with default query
python3 test_agent.py

# Expected output:
# 🤖 Loading AdventureWorks Customer Service Agent...
#    Model: gpt-4.1-mini
#    MCP Server: https://av-func-xxx.azurecontainerapps.io/api/mcp
#
# 👤 User: What tools do you have access to help customers?
#
# 🤖 Agent: I have access to several tools to help customers:
# 1. get_customer_orders - Retrieve order history using Customer ID
# 2. get_order_details - Get detailed information about specific orders
# ...
```

### Custom Queries

Test customer service scenarios:

```bash
# Order tracking
python3 test_agent.py "I'm customer 29825, show me my recent orders"

# Product search
python3 test_agent.py "What mountain bikes do you have under $1000?"

# Recommendations
python3 test_agent.py "I just bought a Mountain-200 bike, what accessories should I get?"

# Order details
python3 test_agent.py "Can you tell me about order 67260?"
```

### Integration in Code

Use the saved configuration in your own applications:

```python
import json
from pathlib import Path
from agent_framework import ChatAgent, MCPStreamableHTTPTool
from agent_framework_azure_ai import AzureAIAgentClient
from azure.identity.aio import DefaultAzureCredential

# Load the auto-generated configuration
with open("AI_AGENT_CONFIG.json") as f:
    config = json.load(f)

# Create MCP tool
mcp_tool = MCPStreamableHTTPTool(
    name="AdventureWorks MCP",
    description="AdventureWorks customer service tools",
    url=config['mcp_server'],
)

# Create agent
async with DefaultAzureCredential() as credential:
    chat_client = AzureAIAgentClient(
        project_endpoint=config['endpoint'],
        model_deployment_name=config['model'],
        async_credential=credential,
        agent_name=config['agent_name'],
    )

    async with ChatAgent(
        chat_client=chat_client,
        instructions="Your custom instructions here",
        tools=[mcp_tool],
    ) as agent:
        # Use the agent
        async for chunk in agent.run_stream("Your query here"):
            if chunk.text:
                print(chunk.text, end="")
```

## Configuration File Format

The `AI_AGENT_CONFIG.json` file contains:

```json
{
  "agent_name": "AdventureWorks Customer Service Agent",
  "model": "gpt-4.1-mini",
  "endpoint": "https://av-openai-xxx.cognitiveservices.azure.com/",
  "mcp_server": "https://av-func-xxx.azurecontainerapps.io/api/mcp",
  "tools": [
    "get_customer_orders",
    "get_order_details",
    "find_complementary_products",
    "search_products",
    "get_product_details"
  ]
}
```

## Troubleshooting

### Agent Not Created

If the agent creation fails during `azd provision`, check:

1. **Python 3.8+ installed:**

   ```bash
   python3 --version
   ```

2. **Package installation:**

   ```bash
   pip install agent-framework-azure-ai --pre
   ```

3. **Azure authentication:**
   ```bash
   az login
   ```

### Manual Agent Creation

If automatic creation fails, you can create the agent manually:

```bash
# Get required values
azd env get-values | grep -E "(AZURE_OPENAI_ENDPOINT|chatGptModelName|API_FUNCTIONS_URL)"

# Create the agent using the values from above
python3 << 'EOF'
import asyncio
from agent_framework import ChatAgent, MCPStreamableHTTPTool
from agent_framework_azure_ai import AzureAIAgentClient
from azure.identity.aio import DefaultAzureCredential

async def create():
    mcp_tool = MCPStreamableHTTPTool(
        name="AdventureWorks MCP",
        description="AdventureWorks customer service tools",
        url="<API_FUNCTIONS_URL>/api/mcp",
    )

    async with DefaultAzureCredential() as cred:
        client = AzureAIAgentClient(
            project_endpoint="<AZURE_OPENAI_ENDPOINT>",
            model_deployment_name="<chatGptModelName>",
            async_credential=cred,
            agent_name="AdventureWorks Customer Service Agent",
        )

        async with ChatAgent(
            chat_client=client,
            instructions="You are a helpful customer service assistant...",
            tools=[mcp_tool],
        ) as agent:
            response = await agent.run("Hello!")
            print(f"Agent created: {response.text}")

asyncio.run(create())
EOF
```

## Re-running After Changes

If you update the MCP Server tools or want to recreate the agent:

```bash
# Redeploy functions
azd deploy api-functions

# Then manually configure the agent using your preferred method
```

## Security Considerations

- **Authentication:** Agent uses Azure Managed Identity (no API keys)
- **Authorization:** MCP Server endpoints use Anonymous auth (suitable for demo)
- **Customer Data:** Tools validate CustomerID for data isolation
- **Production:** Add authentication to MCP endpoints before production use

## Next Steps

1. **Configure Agent:** Set up the AI Agent manually with desired instructions
2. **Add More Tools:** Extend the MCP Server with additional functions
3. **Build UI:** Create a chat interface that uses the agent
4. **Add Auth:** Implement user authentication to pass CustomerID from logged-in users
5. **Monitor:** Use Application Insights to track agent usage and performance

## Related docs

- High-level overview of automation: [AI_AGENT_DEPLOYMENT_SUMMARY.md](AI_AGENT_DEPLOYMENT_SUMMARY.md)
- Migration to Microsoft Agents Framework: [AGENT_FRAMEWORK_MIGRATION.md](AGENT_FRAMEWORK_MIGRATION.md)
- Telemetry implementation and Kusto queries: [AI_AGENT_TELEMETRY_IMPLEMENTATION.md](AI_AGENT_TELEMETRY_IMPLEMENTATION.md), [APP_INSIGHTS_INTEGRATION.md](APP_INSIGHTS_INTEGRATION.md), [APP_INSIGHTS_CONNECTION_STRING_FLOW.md](APP_INSIGHTS_CONNECTION_STRING_FLOW.md)
- MCP server and tools: [../api-mcp/README.md](../api-mcp/README.md)
- Functions that host the agent endpoints: [../api-functions/README.md](../api-functions/README.md)
- Testing the AI agent and MCP flows: [AI_AND_MCP_TESTING_GUIDE.md](AI_AND_MCP_TESTING_GUIDE.md), [AI_CHAT_MCP_TESTING.md](AI_CHAT_MCP_TESTING.md)

## Related Documentation

- [MCP Server Documentation](api-functions/MCP_SERVER.md)
- [MCP Server Testing](api-functions/MCP_SERVER_TESTING.md)
- [CustomerID Migration](MCP_CUSTOMERID_MIGRATION.md)
- [Deployment Scripts](scripts/README.md)
