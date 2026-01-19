# AI Agent Telemetry Implementation

## Overview

Full Application Insights observability has been added to all AI operations in the AdventureWorks API Functions, enabling comprehensive monitoring of the chat agent experience and other AI-powered features.

## Implementation Summary

### Changes Made

#### 1. **AIService.cs** - Core AI Service Telemetry

Added comprehensive telemetry tracking for all AI operations:

- **Constructor**: Injected `TelemetryClient` dependency
- **EnhanceProductsAsync**:
  - Request telemetry with operation tracking
  - Custom events for completion
  - Exception tracking
  - Token usage metrics
- **TranslateProductAsync**:
  - Operation tracking with product model ID
  - Translation completion events
  - Exception tracking with context
- **GenerateEmbeddingsAsync**:
  - Operation tracking for batch embedding generation
  - Dependency tracking for individual embedding calls
  - Average duration metrics
  - Completion events
- **ProcessBatchAsync**:
  - Dependency tracking for OpenAI chat completion calls
  - Token usage metrics (input, output, total)

#### 2. **AIAgentService.cs** - Chat Agent Telemetry

Already had comprehensive telemetry for chat agent interactions:

- Request operation tracking for chat completions
- Custom events for agent responses
- Tool call tracking
- MCP server interaction monitoring
- Exception tracking with full context

#### 3. **AIAgentFunctions.cs** - HTTP Endpoint Telemetry

Already had telemetry for the chat endpoint:

- Request timing
- Custom events for chat requests
- Exception tracking

#### 4. **Program.cs** - Dependency Injection Setup

- Added `using Microsoft.ApplicationInsights;`
- TelemetryClient automatically available via `AddApplicationInsightsTelemetryWorkerService()`
- Updated AIService registration to inject TelemetryClient

#### 5. **Function Files** - Activity Telemetry

Updated the following Durable Functions to inject TelemetryClient:

- `TranslateProductDescriptions.cs`
- `GenerateProductReviewsUsingAI.cs`
- `EmbellishProductsUsingAI.cs`

Each now:

- Injects `IServiceProvider` in constructor
- Retrieves `TelemetryClient` when creating AIService instances
- Passes telemetry client to AIService for operation tracking

## Telemetry Data Captured

### Request Telemetry

All AI operations are tracked as requests with:

- Operation name (e.g., "EnhanceProducts", "TranslateProduct", "GenerateEmbeddings")
- Duration
- Success/failure status
- Custom properties (product count, culture count, etc.)

### Dependency Telemetry

External calls are tracked as dependencies:

- **OpenAI Chat Completions**: Tracked with operation name, start time, duration
- **OpenAI Embedding Generation**: Tracked per embedding request
- Target: "OpenAI"
- Type: "ChatCompletion" or "EmbeddingGeneration"
- Data: Operation context (e.g., "EnhanceProducts", "ProductDescription")

### Custom Events

Key milestones tracked as custom events:

- `ProductEnhancementCompleted`: Total products, batch count, enhanced count
- `ProductTranslated`: Product model ID, culture count, translations generated
- `EmbeddingsGenerated`: Count, duration in milliseconds
- `AIAgentResponse`: Response time, message counts, tool calls, token usage

### Metrics

Custom metrics for performance monitoring:

- `AI.ProductEnhancement.InputTokens`
- `AI.ProductEnhancement.OutputTokens`
- `AI.ProductEnhancement.TotalTokens`
- `AI.Embeddings.AverageDurationMs`
- `AI.ChatAgent.ResponseTimeMs`
- `AI.ChatAgent.TokenUsage`

### Exception Tracking

All exceptions tracked with:

- Operation context
- Custom properties (e.g., product count, product model ID)
- Full stack trace

## Application Insights Queries

### Quick Reference: Operation Names

**Request Operations** (tracked in `requests` table):

- `AgentChat` - AI agent chat endpoint
- `EnhanceProducts` - Product enhancement operations
- `TranslateProduct` - Product translation operations
- `GenerateEmbeddings` - Embedding generation operations

**Dependencies** (tracked in `dependencies` table):

- Target: `OpenAI`
- Type: `ChatCompletion` or `EmbeddingGeneration`
- Names: `AgentInitialCall`, `AgentToolCallResponse`, `EnhanceProducts`, etc.

**Custom Events**:

- `ProductEnhancementCompleted`
- `ProductTranslated`
- `EmbeddingsGenerated`
- `AIAgentResponse`
- `Agent.ToolCallsRequested`

### Monitor Chat Agent Performance

```kusto
requests
| where name == "AgentChat"
| summarize
    AvgDuration = avg(duration),
    P95Duration = percentile(duration, 95),
    SuccessRate = countif(success == true) * 100.0 / count()
    by bin(timestamp, 5m)
| render timechart
```

### Track AI Token Usage

```kusto
customMetrics
| where name startswith "AI."
| where name contains "Token"
| summarize TotalTokens = sum(value) by name, bin(timestamp, 1h)
| render timechart
```

### Monitor OpenAI Dependencies

```kusto
dependencies
| where target == "OpenAI"
| summarize
    CallCount = count(),
    AvgDuration = avg(duration),
    P95Duration = percentile(duration, 95)
    by type, name, bin(timestamp, 5m)
| render timechart
```

### Analyze Chat Agent Tool Calls

```kusto
customEvents
| where name == "AIAgentResponse"
| extend ToolCallCount = toint(customDimensions.ToolCallCount)
| where ToolCallCount > 0
| summarize ToolCallTotal = sum(ToolCallCount) by bin(timestamp, 1h)
| render timechart
```

### Exception Analysis

```kusto
exceptions
| where outerMessage contains "AI" or operation_Name contains "AI"
| summarize Count = count() by problemId, outerMessage, operation_Name
| order by Count desc
```

### End-to-End Transaction Tracing

```kusto
requests
| where name == "AgentChat"
| project operation_Id, timestamp, name, duration, success
| join kind=inner (
    dependencies
    | where target == "OpenAI"
    | project operation_Id, dep_timestamp=timestamp, dep_name=name, dep_duration=duration
) on operation_Id
| project timestamp, name, duration, dep_name, dep_duration, success
| order by timestamp desc
```

### View All AI Operations

```kusto
requests
| where name in ("AgentChat", "EnhanceProducts", "TranslateProduct", "GenerateEmbeddings")
| summarize Count = count(), AvgDuration = avg(duration) by name, bin(timestamp, 1h)
| render timechart
```

### Agent Session Details

```kusto
requests
| where name == "AgentChat"
| extend SessionId = tostring(customDimensions.SessionId)
| extend CustomerId = tostring(customDimensions.CustomerId)
| extend MessageLength = toint(customDimensions.MessageLength)
| project timestamp, SessionId, CustomerId, MessageLength, duration, success
| order by timestamp desc
```

### Tool Call Success Rate

```kusto
customEvents
| where name == "Agent.ToolCallsRequested"
| extend ToolCount = toint(customDimensions.ToolCount)
| summarize TotalToolCalls = sum(ToolCount) by bin(timestamp, 1h)
| render timechart
```

### OpenAI Call Distribution

```kusto
dependencies
| where target == "OpenAI"
| summarize Count = count() by name, type
| order by Count desc
```

## Troubleshooting Queries

### Check if AgentChat requests exist

```kusto
requests
| where timestamp > ago(1h)
| where name == "AgentChat"
| take 20
```

### Check if OpenAI dependencies exist

```kusto
dependencies
| where timestamp > ago(1h)
| where target == "OpenAI"
| take 20
```

### Check operation_Id correlation

```kusto
// First, get some AgentChat operation IDs
let chatOps = requests
| where timestamp > ago(1h)
| where name == "AgentChat"
| project operation_Id
| take 10;
// Then check if dependencies have matching operation IDs
dependencies
| where operation_Id in (chatOps)
| project operation_Id, timestamp, target, name, type, duration
```

### Verify operation_Id exists in both tables

```kusto
requests
| where timestamp > ago(1h)
| where name == "AgentChat"
| project req_operation_Id = operation_Id, req_timestamp = timestamp
| join kind=leftouter (
    dependencies
    | where target == "OpenAI"
    | distinct operation_Id
) on $left.req_operation_Id == $right.operation_Id
| project req_timestamp, req_operation_Id, HasDependencies = isnotnull(operation_Id)
| order by req_timestamp desc
```

### Alternative: Use operation_ParentId if operation_Id doesn't match

```kusto
requests
| where timestamp > ago(1h)
| where name == "AgentChat"
| project operation_Id, id, timestamp, name, duration, success
| join kind=inner (
    dependencies
    | where target == "OpenAI"
    | project operation_ParentId, operation_Id, dep_timestamp=timestamp, dep_name=name, dep_duration=duration
) on $left.id == $right.operation_ParentId
| project timestamp, name, duration, dep_name, dep_duration, success
| order by timestamp desc
```

## Accessing Telemetry in Azure Portal

### Application Insights Resource

The telemetry is sent to the Application Insights resource configured during deployment:

```bash
# Get Application Insights connection string
azd env get-values | grep APPLICATIONINSIGHTS_CONNECTION_STRING
```

### Key Features to Use

1. **Application Map**: Visualize dependencies between services and OpenAI
2. **Performance**: Analyze operation durations and identify bottlenecks
3. **Failures**: Track exceptions and failed requests
4. **Metrics**: View custom metrics for token usage and performance
5. **Live Metrics**: Real-time monitoring of active requests

### Agent Feature in Application Insights

The telemetry structure supports the Application Insights "Agent" experience:

- Agent conversations tracked as request operations
- Tool calls visible in dependency tracking
- Token usage tracked as custom metrics
- Full conversation context in custom dimensions

## Benefits

### Observability

- Complete visibility into AI agent behavior
- Track performance of individual AI operations
- Monitor token usage for cost management

### Debugging

- Exception tracking with full context
- Operation correlation across distributed calls
- Detailed logging of AI responses

### Performance Monitoring

- Identify slow operations
- Track response times for user experience
- Monitor OpenAI API performance

### Cost Optimization

- Track token usage per operation
- Identify expensive operations
- Optimize batch sizes and prompts

## Next Steps

### Recommended Dashboards

1. **AI Operations Dashboard**: Key metrics, success rates, duration trends
2. **Token Usage Dashboard**: Track costs and usage patterns
3. **Chat Agent Dashboard**: Conversation metrics, tool usage, response times

### Alerts to Configure

1. High exception rate in AI operations
2. Elevated response times for chat agent
3. Token usage exceeding thresholds
4. OpenAI dependency failures

### Additional Enhancements

1. Add custom dimensions for user context (if applicable)
2. Implement sampling for high-volume operations
3. Add business metrics (products enhanced, translations generated)
4. Create Application Insights workbooks for detailed analysis

## Deployment

The implementation has been deployed to Azure:

```bash
azd deploy api-functions
```

All telemetry is now flowing to Application Insights and available for monitoring in the Azure Portal.
