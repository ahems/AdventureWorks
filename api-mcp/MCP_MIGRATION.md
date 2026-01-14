# AdventureWorks MCP Server Migration

## Overview

This document describes the migration of MCP (Model Context Protocol) capabilities from Azure Functions to Azure Container Apps with full SSE (Server-Sent Events) transport support.

## Architecture

### Previous Implementation (api-functions)

- **Platform**: Azure Functions (.NET 8)
- **Transport**: Simple REST API (stateless HTTP)
- **Endpoints**:
  - `GET /api/mcp/tools` - List tools
  - `POST /api/mcp/call` - Execute tool
  - `GET /api/mcp/health` - Health check
  - `GET /api/mcp/info` - Server info
- **Use Case**: Direct HTTP calls from AI agents, testing with cURL/Postman

### New Implementation (api-mcp)

- **Platform**: Azure Container Apps (.NET 8 ASP.NET Core)
- **Transport**: Standard MCP SSE transport (stateful, bidirectional)
- **SDK**: `ModelContextProtocol.AspNetCore`
- **Endpoint**: `POST /mcp` (handles SSE + JSON-RPC 2.0)
- **Use Case**: Full MCP protocol compliance, compatible with MCP Inspector

## Migrated Components

### Project Structure

- `AdventureWorks/` - Main MCP server application (.NET 8)
- `ServiceDefaults/` - Shared Aspire service defaults
- `Dockerfile` - Multi-stage Docker build

### Models

- `ProductData.cs` - Product entity model
- `ReviewData.cs` - Review entity models

### Services

- `OrderService.cs` - Order and sales data queries
- `ProductService.cs` - Product catalog queries
- `ReviewService.cs` - Product review analysis

### Tools (MCP)

All 8 AdventureWorks tools in `AdventureWorksMcpTools.cs`:

1. **GetCustomerOrders** - Get customer order history by CustomerID
2. **GetOrderDetails** - Get detailed order information
3. **FindComplementaryProducts** - Product recommendation engine
4. **SearchProducts** - Search products by name/category
5. **GetProductDetails** - Get detailed product specifications
6. **GetPersonalizedRecommendations** - AI-powered customer recommendations
7. **AnalyzeProductReviews** - Review sentiment analysis
8. **CheckInventoryAvailability** - Real-time inventory checks

## Key Differences

### Transport Protocol

**REST API (Functions)**:

```bash
# List tools
curl https://func.azurecontainerapps.io/api/mcp/tools

# Call tool
curl -X POST https://func.azurecontainerapps.io/api/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"name": "GetCustomerOrders", "arguments": {"customerId": 123}}'
```

**SSE Transport (Container Apps)**:

```bash
# SSE endpoint handles both tool discovery and execution via JSON-RPC 2.0
# Compatible with MCP Inspector and official MCP clients
curl -X POST https://mcp.azurecontainerapps.io/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "tools/list", "id": 1}'
```

### Configuration

**Program.cs**:

```csharp
// Stateful SSE transport for full MCP protocol
.WithHttpTransport(o => o.Stateless = false)

// Register AdventureWorks MCP tools
.WithTools<AdventureWorksMcpTools>()
```

**appsettings.json**:

```json
{
  "ConnectionStrings": {
    "AdventureWorks": "Server=tcp:...;Authentication=Active Directory Default;"
  }
}
```

## SSE Transport Benefits

1. **Stateful Sessions**: Maintains connection state for complex interactions
2. **Bidirectional Communication**: Server can push updates to client
3. **Standard Compliance**: Works with official MCP Inspector tool
4. **Tool Discovery**: Automatic tool schema generation from attributes
5. **Progress Updates**: Can stream long-running operation progress

## Testing with MCP Inspector

The new implementation supports the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
# Run MCP Inspector pointing to the Container Apps endpoint
npx @modelcontextprotocol/inspector https://mcp.azurecontainerapps.io/mcp
```

## Deployment

The api-mcp service is configured in `azure.yaml`:

```yaml
services:
  api-mcp:
    language: dotnet
    project: ./api-mcp/AppHost/AppHost.csproj
    host: containerapp
```

Deploy with:

```bash
azd deploy api-mcp
```

## Local Development

```bash
cd api-mcp/AdventureWorks
dotnet run
```

The server will start on `http://localhost:5000` with the MCP endpoint at `/mcp`.

## Comparison: When to Use Which?

### Use Azure Functions REST API (api-functions/AdventureWorksMcpServer)

- ✅ Simple HTTP-based integrations
- ✅ Stateless tool execution
- ✅ Cost-effective for low-traffic scenarios
- ✅ Easy testing with cURL/Postman
- ✅ Direct AI agent integration without MCP client library

### Use Container Apps SSE (api-mcp/AdventureWorks)

- ✅ Full MCP protocol compliance
- ✅ MCP Inspector compatibility
- ✅ Stateful multi-turn conversations
- ✅ Progressive tool execution
- ✅ Standards-based AI agent integration
- ✅ Better for demo/showcase purposes

## Migration Checklist

- [x] Create Models directory and migrate data models
- [x] Create Services directory and migrate OrderService, ProductService, ReviewService
- [x] Create AdventureWorksMcpTools with MCP SDK attributes
- [x] Update Program.cs with service registration and SSE transport
- [x] Add NuGet packages (Dapper, Microsoft.Data.SqlClient, Azure.Identity)
- [x] Configure database connection string
- [x] Build and test compilation
- [ ] Deploy to Azure Container Apps
- [ ] Test with MCP Inspector
- [ ] Update documentation

## Next Steps

1. Deploy the api-mcp service to Azure Container Apps
2. Configure infrastructure (Bicep) if needed
3. Test SSE transport with MCP Inspector
4. Update root config.json to use new endpoint
5. Document differences for team

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io)
- [MCP .NET SDK](https://github.com/modelcontextprotocol/dotnet-sdk)
- [MCP Inspector Tool](https://github.com/modelcontextprotocol/inspector)
