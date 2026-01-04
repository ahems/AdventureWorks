# AdventureWorks MCP Server

## Overview

The AdventureWorks MCP (Model Context Protocol) Server enables AI agents to query and interact with AdventureWorks e-commerce data. This server provides tools for:

- **Order Management**: Check order status, view order details, and track shipments
- **Product Search**: Search products by name, category, or attributes
- **Product Recommendations**: Find complementary products based on purchase history
- **Customer Service**: Answer customer questions about their orders and products

## Architecture

The MCP Server is built as part of the Azure Functions project and exposes HTTP endpoints that AI agents can call. It follows the Model Context Protocol specification for tool definitions and execution.

### Components

1. **OrderService** - Data access layer for querying orders and sales data
2. **ProductService** - Data access layer for querying product information
3. **AdventureWorksMcpTools** - Tool definitions and execution logic
4. **AdventureWorksMcpServer** - HTTP endpoints for the MCP protocol

## Available Tools

### 1. get_customer_orders

Get order history and status for a customer by email address.

**Parameters:**

- `email` (string, required): Customer's email address

**Example:**

```json
{
  "name": "get_customer_orders",
  "arguments": {
    "email": "customer@example.com"
  }
}
```

**Use Cases:**

- "Has my order shipped yet?"
- "What's the status of my recent orders?"
- "Show me my order history"

---

### 2. get_order_details

Get detailed information about a specific order including items, pricing, and shipping.

**Parameters:**

- `orderId` (integer, required): Sales Order ID number

**Example:**

```json
{
  "name": "get_order_details",
  "arguments": {
    "orderId": 43659
  }
}
```

**Use Cases:**

- "What items are in order #43659?"
- "Show me the details of my order"
- "What's the total cost of order #43659?"

---

### 3. find_complementary_products

Find products frequently purchased together with a specific product.

**Parameters:**

- `productId` (integer, required): Product ID to find complementary products for
- `limit` (integer, optional): Maximum number of recommendations (default: 5)

**Example:**

```json
{
  "name": "find_complementary_products",
  "arguments": {
    "productId": 776,
    "limit": 5
  }
}
```

**Use Cases:**

- "What goes well with this bike?"
- "Recommend accessories for this product"
- "What do other customers buy with this?"

---

### 4. search_products

Search for products by name, category, or description.

**Parameters:**

- `searchTerm` (string, required): Text to search for in product names and descriptions
- `categoryId` (integer, optional): Filter by product category ID

**Example:**

```json
{
  "name": "search_products",
  "arguments": {
    "searchTerm": "mountain bike"
  }
}
```

**Use Cases:**

- "Find me a mountain bike"
- "Search for helmets"
- "Show me products in the bike category"

---

### 5. get_product_details

Get detailed information about a specific product including specifications and pricing.

**Parameters:**

- `productId` (integer, required): Product ID to retrieve details for

**Example:**

```json
{
  "name": "get_product_details",
  "arguments": {
    "productId": 776
  }
}
```

**Use Cases:**

- "Tell me about product #776"
- "What are the specifications of this bike?"
- "How much does product #776 cost?"

---

## API Endpoints

### List Available Tools

```http
GET /api/mcp/tools
Authorization: Function key
```

**Response:**

```json
{
  "tools": [
    {
      "name": "get_customer_orders",
      "description": "Get order history and status for a customer...",
      "inputSchema": { ... }
    },
    ...
  ]
}
```

---

### Execute a Tool

```http
POST /api/mcp/call
Authorization: Function key
Content-Type: application/json

{
  "name": "tool_name",
  "arguments": { ... }
}
```

**Response (Success):**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Result text here..."
    }
  ],
  "isError": false
}
```

**Response (Error):**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error message here..."
    }
  ],
  "isError": true
}
```

---

### Health Check

```http
GET /api/mcp/health
```

**Response:**

```json
{
  "status": "healthy",
  "service": "AdventureWorks MCP Server",
  "timestamp": "2026-01-04T10:30:00Z",
  "version": "1.0.0"
}
```

---

### Server Information

```http
GET /api/mcp/info
```

**Response:**

```json
{
  "name": "AdventureWorks MCP Server",
  "version": "1.0.0",
  "description": "Model Context Protocol server for querying AdventureWorks e-commerce data",
  "capabilities": {
    "tools": {
      "enabled": true,
      "count": 5
    }
  },
  "endpoints": { ... }
}
```

---

## Local Development

### Prerequisites

- .NET 8 SDK
- Azure Functions Core Tools v4
- Azure SQL Database connection (with AdventureWorks schema)
- Azure CLI (for authentication)

### Setup

1. **Restore packages** (including the new MCP packages with `--prerelease` flag):

   ```bash
   cd api-functions
   dotnet restore --prerelease
   ```

2. **Ensure SQL connection string is configured** in `local.settings.json`:

   ```json
   {
     "Values": {
       "SQL_CONNECTION_STRING": "Server=your-server.database.windows.net;Database=AdventureWorks;Authentication=Active Directory Default;"
     }
   }
   ```

3. **Authenticate with Azure** (for Managed Identity auth):

   ```bash
   az login
   ```

4. **Start the function app**:

   ```bash
   func start
   ```

   Or use the VS Code task: `func: host start`

5. **Test the MCP server**:

   ```bash
   # Health check
   curl http://localhost:7071/api/mcp/health

   # List tools
   curl http://localhost:7071/api/mcp/tools

   # Execute a tool
   curl -X POST http://localhost:7071/api/mcp/call \
     -H "Content-Type: application/json" \
     -d '{"name":"search_products","arguments":{"searchTerm":"bike"}}'
   ```

---

## Deployment to Azure

### Automated Deployment with azd

The entire deployment process, including AI Agent creation, is **fully automated**:

```bash
# Full deployment (infrastructure + code + AI agent)
azd up

# Or deploy incrementally:
azd provision  # Deploy infrastructure
azd deploy     # Deploy code
```

**What happens automatically:**

During `azd provision`, the `postprovision.ps1` script:

1. ✅ Deploys the MCP Server as part of the Functions Container App
2. ✅ Installs `agent-framework-azure-ai` Python package (if Python is available)
3. ✅ Creates an AI Agent with MCP Server tools integrated
4. ✅ Tests the agent with a sample query
5. ✅ Saves agent configuration to `AI_AGENT_CONFIG.json` in the workspace root
6. ✅ Stores agent details in azd environment variables

**Agent Configuration Created:**

- **Agent Name:** AdventureWorks Customer Service Agent
- **Model:** Uses the deployed chat model (e.g., `gpt-4.1-mini`)
- **MCP Tools:** All 5 tools (orders, products, recommendations)
- **Endpoint:** Your Azure Functions URL at `/api/mcp`

### Testing the Deployed Agent

After deployment, test the agent using the provided script in the workspace root:

```bash
# Test with default query
python3 test_agent.py

# Test with custom query
python3 test_agent.py "Show me mountain bikes under $500"

# Test customer service scenarios
python3 test_agent.py "I'm customer 29825, what's the status of my orders?"
```

### Get the MCP Server URL

The MCP Server URL is automatically saved to your azd environment:

### Get the MCP Server URL

The MCP Server URL is automatically saved to your azd environment:

```bash
# Get the MCP endpoint
azd env get-values | grep API_FUNCTIONS_URL

# Full MCP endpoint is:
# https://<your-functions-app>.azurecontainerapps.io/api/mcp
```

### Manual Function Deployment (Alternative)

If you need to deploy just the functions without azd:

```bash
# List functions
func azure functionapp list-functions <function-app-name>

# Or via Azure CLI
az functionapp function show \
  --resource-group <resource-group> \
  --name <function-app-name> \
  --function-name ListMcpTools
```

The MCP Server will be available at:

```
https://<function-app-name>.azurewebsites.net/api/mcp/
```

---

## Integration with AI Agents

### Using with Microsoft Agent Framework (.NET)

```csharp
using Azure.AI.Agents.Persistent;
using Azure.Identity;
using Microsoft.Agents.AI;

// Create an agent with MCP tools from the AdventureWorks server
var persistentAgentsClient = new PersistentAgentsClient(
    "<your-foundry-project-endpoint>",
    new DefaultAzureCredential()
);

// Connect to the AdventureWorks MCP Server
var mcpClient = await McpClient.CreateAsync(
    new HttpClientTransport(
        new() {
            Name = "AdventureWorks MCP",
            Endpoint = new Uri("https://<your-function-app>.azurewebsites.net/api/mcp")
        }
    )
);

// Get MCP tools
var mcpTools = await mcpClient.ListToolsAsync();

// Create agent with MCP tools
AIAgent agent = await persistentAgentsClient.CreateAIAgentAsync(
    model: "<your-foundry-model-deployment>",
    name: "AdventureWorks Assistant",
    instructions: "You are a helpful customer service assistant for AdventureWorks. Use the available tools to help customers with their orders and product questions.",
    new ChatOptions
    {
        Tools = mcpTools.ToList()
    }
);

// Use the agent
await foreach (var update in agent.RunStreamingAsync("Has my order shipped yet? My email is customer@example.com"))
{
    if (!string.IsNullOrEmpty(update.Text))
    {
        Console.Write(update.Text);
    }
}
```

### Using with Python Agent Framework

```python
from azure.ai.agents.persistent import PersistentAgentsClient
from azure.identity import DefaultAzureCredential
from modelcontextprotocol import McpClient

# Create MCP client
mcp_client = await McpClient.create(
    transport="http",
    endpoint="https://<your-function-app>.azurewebsites.net/api/mcp"
)

# Get tools
tools = await mcp_client.list_tools()

# Create agent with tools
client = PersistentAgentsClient(
    endpoint="<your-foundry-project-endpoint>",
    credential=DefaultAzureCredential()
)

agent = await client.create_agent(
    model="<your-foundry-model-deployment>",
    name="AdventureWorks Assistant",
    instructions="You are a helpful customer service assistant...",
    tools=tools
)

# Use the agent
async for update in agent.run_streaming("What mountain bikes do you have?"):
    if update.text:
        print(update.text, end="")
```

---

## Security Considerations

1. **Function Authorization**: The MCP endpoints use `AuthorizationLevel.Function`, requiring a function key
2. **Database Access**: Uses Azure AD authentication (Managed Identity) with minimal permissions
3. **Input Validation**: All tool arguments are validated before execution
4. **Error Handling**: Errors are caught and returned as structured responses
5. **CORS**: Configure CORS in production to allow only your frontend and agent endpoints

---

## Testing

### Unit Testing

Create tests for individual tools:

```csharp
[Fact]
public async Task GetCustomerOrders_ShouldReturnOrders()
{
    var orderService = new OrderService(connectionString);
    var result = await orderService.GetCustomerOrderStatusAsync("customer@example.com");
    Assert.Contains("Order #", result);
}
```

### Integration Testing

Test the full MCP flow:

```bash
# Test with curl
curl -X POST http://localhost:7071/api/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "name": "get_customer_orders",
    "arguments": {
      "email": "david8@adventure-works.com"
    }
  }'
```

---

## Monitoring

The MCP Server integrates with Application Insights for monitoring:

- **Request telemetry**: Track tool calls and response times
- **Custom events**: Log tool executions and results
- **Error tracking**: Monitor failures and exceptions
- **Dependencies**: Track SQL queries and external calls

View logs:

```bash
# Function app logs
func azure functionapp logstream <function-app-name>

# Application Insights queries
az monitor app-insights query \
  --app <app-insights-name> \
  --analytics-query "requests | where url contains 'mcp' | top 50 by timestamp desc"
```

---

## Extending the MCP Server

### Adding New Tools

1. **Add data access method** in appropriate service (e.g., `OrderService.cs`)
2. **Create tool definition** in `AdventureWorksMcpTools.GetToolDefinitions()`
3. **Add execution logic** in `AdventureWorksMcpTools.ExecuteToolAsync()`

Example - Adding a "get_product_reviews" tool:

```csharp
// In GetToolDefinitions()
new McpToolDefinition
{
    Name = "get_product_reviews",
    Description = "Get customer reviews for a specific product",
    InputSchema = new McpInputSchema
    {
        Properties = new Dictionary<string, McpProperty>
        {
            { "productId", new McpProperty { Type = "integer", Description = "Product ID" } }
        },
        Required = new List<string> { "productId" }
    }
}

// In ExecuteToolAsync()
"get_product_reviews" => await ExecuteGetProductReviewsAsync(request.Arguments),

// Add execution method
private async Task<string> ExecuteGetProductReviewsAsync(Dictionary<string, object>? arguments)
{
    // Implementation here
}
```

---

## Troubleshooting

### Common Issues

**Issue**: "SQL_CONNECTION_STRING environment variable is not set"

- **Solution**: Ensure connection string is configured in `local.settings.json` or Azure Function App Settings

**Issue**: "Authentication failed" when connecting to SQL

- **Solution**: Run `az login` to authenticate with Azure AD for local development

**Issue**: "Tool not found" error

- **Solution**: Check tool name spelling in the request matches the definition exactly

**Issue**: Function key required but not provided

- **Solution**: Add `?code=<function-key>` to the URL or include in the request header

---

## Resources

- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
- [Microsoft Agent Framework Documentation](https://github.com/microsoft/agent-framework)
- [Azure Functions Documentation](https://docs.microsoft.com/azure/azure-functions/)
- [Microsoft Foundry (Azure AI Foundry) Documentation](https://learn.microsoft.com/azure/ai-studio/)

---

## Next Steps

1. **Deploy to Azure**: Use `azd up` to deploy the complete application
2. **Create AI Agent**: Set up an agent in Microsoft Foundry that uses these MCP tools
3. **Build Chat UI**: Create a frontend chat interface for logged-in users
4. **Add Authentication**: Integrate with your existing user authentication system
5. **Monitor Usage**: Set up Application Insights dashboards to track tool usage
6. **Expand Tools**: Add more tools based on user needs (returns, wishlists, etc.)
