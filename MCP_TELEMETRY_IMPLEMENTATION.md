# MCP Server Telemetry Implementation

## Overview

This document describes the Application Insights telemetry implementation for the AdventureWorks MCP (Model Context Protocol) server, enabling full observability of AI agent tool calls and operations.

## Changes Made

### 1. Package References Added

#### AdventureWorks.csproj

- **Microsoft.ApplicationInsights.AspNetCore v2.23.0** - Core Application Insights SDK for ASP.NET Core

#### ServiceDefaults.csproj

- **Azure.Monitor.OpenTelemetry.AspNetCore v1.\*** - Azure Monitor exporter for OpenTelemetry

### 2. Configuration Updates

#### ServiceDefaults/Extensions.cs

- **Added using**: `using Azure.Monitor.OpenTelemetry.AspNetCore;`
- **Enabled Azure Monitor Exporter**: Uncommented and activated the UseAzureMonitor() configuration

```csharp
if (!string.IsNullOrEmpty(builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]))
{
    builder.Services.AddOpenTelemetry()
       .UseAzureMonitor();
}
```

#### Program.cs

- **Added Application Insights Registration**: `builder.Services.AddApplicationInsightsTelemetry();`
  - This registers TelemetryClient in the DI container, making it available for injection
  - **Critical**: Must be called before service registrations that require TelemetryClient
  - Without this, you'll get DI errors: "Unable to resolve service for type 'Microsoft.ApplicationInsights.TelemetryClient'"

### 3. Service Layer Telemetry

#### AIService.cs

Added comprehensive telemetry tracking to embedding generation:

- **TelemetryClient** field and constructor parameter injection
- **Dependency Tracking**: Wraps OpenAI embedding calls with `StartOperation<DependencyTelemetry>`
- **Properties Logged**:
  - `dimensions` - Number of embedding dimensions generated
  - `queryLength` - Length of the search query text
- **Exception Tracking**: Captures and tracks all errors during embedding generation

**Key Metrics**:

- Operation name: "Generate Query Embedding"
- Type: "OpenAI"
- Success/failure tracking

### 4. MCP Tools Telemetry

#### AdventureWorksMcpTools.cs

Added telemetry to all 8 MCP tool methods:

1. **GetCustomerOrders**
   - Operation: `MCP_GetCustomerOrders`
   - Tracks: customerId, cultureId, resultLength

2. **GetOrderDetails**
   - Operation: `MCP_GetOrderDetails`
   - Tracks: orderId, customerId (optional), cultureId, resultLength

3. **FindComplementaryProducts**
   - Operation: `MCP_FindComplementaryProducts`
   - Tracks: productId, limit, cultureId, resultLength

4. **SearchProducts**
   - Operation: `MCP_SearchProducts`
   - Tracks: searchTerm, cultureId, categoryId (optional), resultsCount, resultLength

5. **GetProductDetails**
   - Operation: `MCP_GetProductDetails`
   - Tracks: productId, found (true/false), resultLength

6. **GetPersonalizedRecommendations**
   - Operation: `MCP_GetPersonalizedRecommendations`
   - Tracks: customerId, limit, cultureId, resultLength

7. **AnalyzeProductReviews**
   - Operation: `MCP_AnalyzeProductReviews`
   - Tracks: productId, cultureId, resultLength

8. **CheckInventoryAvailability**
   - Operation: `MCP_CheckInventoryAvailability`
   - Tracks: productId, cultureId, resultLength

**Common Pattern**:

```csharp
using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_ToolName");
operation.Telemetry.Properties["paramName"] = paramValue;

try
{
    var result = await _service.MethodAsync(...);
    operation.Telemetry.Success = true;
    _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
    {
        { "tool", "ToolName" },
        { "resultLength", result.Length.ToString() }
    });
    return result;
}
catch (Exception ex)
{
    operation.Telemetry.Success = false;
    _telemetryClient.TrackException(ex, new Dictionary<string, string>
    {
        { "tool", "ToolName" }
    });
    throw;
}
```

### 5. Dependency Injection Updates

#### Program.cs

- **Added using**: `using Microsoft.ApplicationInsights;`
- **Updated AIService registration**:

```csharp
builder.Services.AddScoped<AIService>(sp =>
{
    var logger = sp.GetRequiredService<ILogger<AIService>>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();
    return new AIService(openAiEndpoint, logger, telemetryClient);
});
```

## Telemetry Data Captured

### Request Telemetry

- **Operation Name**: MCP tool method name (e.g., "MCP_GetCustomerOrders")
- **Duration**: Automatic tracking of execution time
- **Success**: Boolean indicating if operation completed successfully
- **Properties**: Method-specific parameters (customerId, productId, searchTerm, etc.)

### Dependency Telemetry

- **OpenAI Embedding Calls**: Tracked as "OpenAI" dependency type
- **Duration**: Time taken for embedding generation
- **Properties**: Query length, embedding dimensions

### Custom Events

- **Event Name**: "MCP_ToolExecuted"
- **Properties**:
  - `tool` - Name of the MCP tool that was called
  - `resultLength` - Size of the returned result
  - Additional tool-specific properties (resultsCount, found status, etc.)

### Exception Telemetry

- All exceptions automatically tracked with context
- Properties include the tool name and relevant parameters

## Monitoring with Application Insights

### Key Queries

#### 1. MCP Tool Call Volume

```kusto
requests
| where name startswith "MCP_"
| summarize count() by name, bin(timestamp, 5m)
| render timechart
```

#### 2. MCP Tool Performance

```kusto
requests
| where name startswith "MCP_"
| summarize avg(duration), percentiles(duration, 50, 90, 95, 99) by name
```

#### 3. Most Popular MCP Tools

```kusto
customEvents
| where name == "MCP_ToolExecuted"
| summarize count() by tostring(customDimensions.tool)
| order by count_ desc
```

#### 4. Search Query Analysis

```kusto
requests
| where name == "MCP_SearchProducts"
| extend searchTerm = tostring(customDimensions.searchTerm)
| extend resultsCount = toint(customDimensions.resultsCount)
| project timestamp, searchTerm, resultsCount, duration
| order by timestamp desc
```

#### 5. OpenAI Embedding Calls

```kusto
dependencies
| where type == "OpenAI"
| where name == "Generate Query Embedding"
| summarize count(), avg(duration), percentiles(duration, 95) by bin(timestamp, 5m)
| render timechart
```

#### 6. MCP Tool Failures

```kusto
requests
| where name startswith "MCP_"
| where success == false
| project timestamp, name, customDimensions, duration
| order by timestamp desc
```

#### 7. Product Search Effectiveness

```kusto
customEvents
| where name == "MCP_ToolExecuted"
| where customDimensions.tool == "SearchProducts"
| extend resultsCount = toint(customDimensions.resultsCount)
| summarize avg(resultsCount), percentiles(resultsCount, 50, 90, 95) by bin(timestamp, 1h)
```

### Workbook Suggestions

Create an Application Insights Workbook with the following sections:

1. **MCP Tool Overview**
   - Total calls per tool
   - Success rates
   - Average duration

2. **Search Analytics**
   - Popular search terms
   - Search result counts
   - Embedding performance

3. **Customer Insights**
   - Most active customers (by tool calls)
   - Customer journey patterns (order of tool calls)

4. **Performance Metrics**
   - P95/P99 latencies per tool
   - OpenAI dependency performance
   - Error rates by tool

5. **Alerts**
   - High failure rate (>5% for any tool)
   - Slow OpenAI responses (>2 seconds)
   - Unusual search patterns (no results frequently)

## Environment Configuration

The MCP server requires the `APPLICATIONINSIGHTS_CONNECTION_STRING` environment variable to send telemetry to Azure Monitor:

```bash
APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=...;IngestionEndpoint=..."
```

This is automatically configured when deploying via `azd` and reading from Azure resources.

## Testing Telemetry

### Local Testing

1. Set `APPLICATIONINSIGHTS_CONNECTION_STRING` in local environment
2. Start the MCP server: `cd api-mcp/AdventureWorks && dotnet run`
3. Call MCP tools via the frontend chat interface
4. Check Application Insights portal for telemetry data (may take 2-3 minutes to appear)

### Verification Queries

```kusto
// Check if telemetry is flowing
requests
| where timestamp > ago(10m)
| where name startswith "MCP_"
| take 20

// Verify all tools are instrumented
requests
| where timestamp > ago(1d)
| where name startswith "MCP_"
| distinct name
| order by name asc
```

## Build Status

✅ MCP server builds successfully with telemetry implementation
✅ All dependencies resolved
✅ Zero build warnings or errors

## Next Steps

1. Deploy updated MCP server to Azure: `azd deploy api-mcp`
2. Verify telemetry appears in Application Insights portal
3. Create custom workbook for MCP tool monitoring
4. Set up alerts for tool failures and performance degradation
5. Analyze search patterns to improve semantic search quality
