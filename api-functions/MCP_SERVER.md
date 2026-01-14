# AdventureWorks MCP Server

## ⚠️ MCP Server Has Moved

The MCP (Model Context Protocol) Server has been moved to a dedicated project for better separation of concerns.

**New Location:** [`/api-mcp`](../api-mcp/)

## Quick Links

- **MCP Server Documentation**: [api-mcp/MCP_MIGRATION.md](../api-mcp/MCP_MIGRATION.md)
- **MCP Server Tools**: See `api-mcp/AdventureWorks/Tools/AdventureWorksMcpTools.cs`
- **MCP Server Endpoints**: See `api-mcp/AdventureWorks/Program.cs`

## What Remains in api-functions

The `api-functions` project now contains:

- **AIAgentFunctions** - Chat endpoint that calls the external api-mcp service
- **AIAgentService** - Orchestrates AI conversations with MCP tool integration

The AI Agent in api-functions acts as a client that calls the MCP server in the api-mcp project via HTTP.

## Architecture

```
User → AIAgentFunctions (api-functions) → AIAgentService → HTTP → api-mcp MCP Server → Database
```

The AIAgentService in api-functions makes HTTP requests to the MCP server endpoints in api-mcp to execute tools and retrieve data.
