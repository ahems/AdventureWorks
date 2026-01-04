using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System.Net;
using System.Text.Json;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// AdventureWorks MCP Server - Exposes Model Context Protocol endpoints for AI agents
/// This enables AI agents to query AdventureWorks data for customer service and recommendations
/// </summary>
public class AdventureWorksMcpServer
{
    private readonly ILogger<AdventureWorksMcpServer> _logger;
    private readonly AdventureWorksMcpTools _mcpTools;

    public AdventureWorksMcpServer(
        ILogger<AdventureWorksMcpServer> logger,
        AdventureWorksMcpTools mcpTools)
    {
        _logger = logger;
        _mcpTools = mcpTools;
    }

    /// <summary>
    /// List all available MCP tools
    /// GET /api/mcp/tools
    /// </summary>
    [Function("ListMcpTools")]
    public async Task<HttpResponseData> ListTools(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "mcp/tools")] HttpRequestData req)
    {
        _logger.LogInformation("Listing available MCP tools");

        try
        {
            var tools = _mcpTools.GetToolDefinitions();

            var response = req.CreateResponse(HttpStatusCode.OK);
            // WriteAsJsonAsync automatically sets Content-Type header
            await response.WriteAsJsonAsync(tools);

            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error listing MCP tools");

            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error listing tools: {ex.Message}");
            return errorResponse;
        }
    }

    /// <summary>
    /// Execute an MCP tool
    /// POST /api/mcp/call
    /// Body: { "name": "tool_name", "arguments": { ... } }
    /// </summary>
    [Function("CallMcpTool")]
    public async Task<HttpResponseData> CallTool(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "mcp/call")] HttpRequestData req)
    {
        _logger.LogInformation("Executing MCP tool");

        try
        {
            // Parse request body
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var toolRequest = JsonSerializer.Deserialize<McpToolRequest>(requestBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (toolRequest == null || string.IsNullOrEmpty(toolRequest.Name))
            {
                var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequest.WriteStringAsync("Tool name is required");
                return badRequest;
            }

            _logger.LogInformation($"Calling tool: {toolRequest.Name}");

            // Execute the tool
            var result = await _mcpTools.ExecuteToolAsync(toolRequest);

            // Return response
            var response = req.CreateResponse(result.IsError ? HttpStatusCode.BadRequest : HttpStatusCode.OK);
            // WriteAsJsonAsync automatically sets Content-Type header
            await response.WriteAsJsonAsync(result);

            return response;
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "Invalid JSON in request body");

            var errorResponse = req.CreateResponse(HttpStatusCode.BadRequest);
            await errorResponse.WriteStringAsync($"Invalid JSON: {ex.Message}");
            return errorResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing MCP tool");

            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error executing tool: {ex.Message}");
            return errorResponse;
        }
    }

    /// <summary>
    /// Health check endpoint for the MCP server
    /// GET /api/mcp/health
    /// </summary>
    [Function("McpHealthCheck")]
    public async Task<HttpResponseData> HealthCheck(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "mcp/health")] HttpRequestData req)
    {
        _logger.LogInformation("MCP Server health check");

        var response = req.CreateResponse(HttpStatusCode.OK);
        // WriteAsJsonAsync automatically sets Content-Type header

        await response.WriteAsJsonAsync(new
        {
            status = "healthy",
            service = "AdventureWorks MCP Server",
            timestamp = DateTime.UtcNow,
            version = "1.0.0"
        });

        return response;
    }

    /// <summary>
    /// Get MCP server information and capabilities
    /// GET /api/mcp/info
    /// </summary>
    [Function("McpServerInfo")]
    public async Task<HttpResponseData> GetServerInfo(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "mcp/info")] HttpRequestData req)
    {
        _logger.LogInformation("Getting MCP server information");

        var tools = _mcpTools.GetToolDefinitions();

        var response = req.CreateResponse(HttpStatusCode.OK);
        // WriteAsJsonAsync automatically sets Content-Type header

        await response.WriteAsJsonAsync(new
        {
            name = "AdventureWorks MCP Server",
            version = "1.0.0",
            description = "Model Context Protocol server for querying AdventureWorks e-commerce data",
            capabilities = new
            {
                tools = new
                {
                    enabled = true,
                    count = tools.Tools.Count
                }
            },
            endpoints = new
            {
                listTools = "/api/mcp/tools",
                callTool = "/api/mcp/call",
                health = "/api/mcp/health",
                info = "/api/mcp/info"
            },
            toolCategories = new[]
            {
                "Order Management",
                "Product Search",
                "Product Recommendations",
                "Customer Service"
            }
        });

        return response;
    }
}
