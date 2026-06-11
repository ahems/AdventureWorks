# AI Chat and MCP Server Complete Testing Guide

## Overview

This guide describes the comprehensive test script `test-ai-and-mcp-complete.sh` that validates all functionality of the AI Chat Feature and MCP Server tools deployed in Azure.

## What This Script Tests

### Part 1: Data Preparation (DAB API)

Uses the Data API Builder (DAB) GraphQL API to fetch real test data:

- **Customer ID**: Fetches the most recently added customer (currently ID 30119)
- **Product ID**: Fetches a finished goods product for testing
- **Order ID**: Fetches a recent order for the customer

### Part 2: AI Agent Functions API

Tests the AI chat endpoints in the Functions API:

#### 2.1: Agent Status

- **Endpoint**: `GET /api/agent/status`
- **Validates**: Service is operational, `framework` equals `"Azure.AI.Foundry"`, and features include `"foundry-agent-threads"`, `"dual-mcp-servers"`, `"thread-persistence"`

#### 2.2: Simple Chat

- **Endpoint**: `POST /api/agent/chat`
- **Test**: Basic greeting message
- **Validates**: AI responds to simple conversational input; response contains `threadId`

#### 2.3: Multi-turn Thread Continuation

- **Test**: Second message using the `threadId` returned from 2.2
- **Validates**: The agent resumes the same Foundry thread (contextual continuation)

### Part 3: MCP Server Tools (Direct)

Tests all 8 MCP tools directly via SSE protocol:

#### 3.1: GetCustomerOrders

```json
{
  "customerId": 30119
}
```

Fetches order history and status for the customer.

#### 3.2-3.3: GetOrderDetails

```json
{
  "orderId": <orderID>
}
```

```json
{
  "orderId": <orderID>,
  "customerId": 30119
}
```

Tests both with and without customer validation.

#### 3.4: FindComplementaryProducts

```json
{
  "productId": <productID>,
  "limit": 5
}
```

Finds products frequently purchased together.

#### 3.5-3.6: SearchProducts

```json
{
  "searchTerm": "bike"
}
```

```json
{
  "searchTerm": "helmet",
  "categoryId": 1
}
```

Tests search with and without category filter.

#### 3.7: GetProductDetails

```json
{
  "productId": <productID>
}
```

Retrieves detailed product information.

#### 3.8: GetPersonalizedRecommendations

```json
{
  "customerId": 30119,
  "limit": 5
}
```

Gets AI-powered product recommendations based on purchase history.

#### 3.9: AnalyzeProductReviews

```json
{
  "productId": <productID>
}
```

Analyzes customer reviews with sentiment analysis.

#### 3.10: CheckInventoryAvailability

```json
{
  "productId": <productID>
}
```

Checks real-time inventory across warehouses.

### Part 4: AI Chat with MCP Integration

Tests that the AI Agent correctly uses MCP tools:

#### 4.1: Order Query Tool Integration

- **Test**: "What orders have I placed recently?"
- **Expected Tool**: `GetCustomerOrders`
- **Validates**: AI detects order intent and calls correct tool

#### 4.2: Product Search Tool Integration

- **Test**: "Show me some mountain bikes"
- **Expected Tool**: `SearchProducts`
- **Validates**: AI detects product search intent

#### 4.3: Product Details Tool Integration

- **Test**: "Tell me more about product {id}"
- **Expected Tool**: `GetProductDetails`
- **Validates**: AI detects product detail intent

## Prerequisites

- Azure services must be deployed (`azd up`)
- The following services must be running:
  - DAB API (GraphQL)
  - Functions API (AI Agent)
  - MCP Server (SSE)
- Azure CLI must be authenticated (`az login`)
- `jq` must be installed (for JSON parsing)
- `curl` must be available

## Running the Tests

```bash
# From workspace root
./test-ai-and-mcp-complete.sh
```

The script will:

1. Load Azure environment configuration automatically
2. Fetch real test data from the database
3. Run all tests sequentially
4. Display color-coded results
5. Provide a summary at the end

## Understanding the Output

### Color Coding

- 🔵 **Blue**: Test section headers and info
- 🟢 **Green**: Passed tests and success messages
- 🟡 **Yellow**: Test descriptions and warnings
- 🔴 **Red**: Failed tests and errors

### Test Results

Each test shows:

- Test description
- Request/response details (truncated for readability)
- Pass/fail status
- Reason for failure (if applicable)

### Final Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEST SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Tests: 20
Passed: 18
Failed: 2
```

## Expected Results

When everything is working correctly:

- All 20+ tests should pass
- AI chat should respond coherently
- MCP tools should return structured data
- Tool integration should show the AI using appropriate tools

## Common Issues and Troubleshooting

### Issue: "Failed to get customer ID"

**Cause**: DAB API not responding or database connectivity issue  
**Solution**:

- Check `API_URL` is correct: `azd env get-values | grep API_URL`
- Verify DAB API is running: `curl $API_URL`

### Issue: "Agent status failed (HTTP 500)"

**Cause**: Functions API or MCP server configuration issue  
**Solution**:

- Check Application Insights for errors
- Verify MCP server URL in Functions configuration
- Check connection strings are set

### Issue: "MCP tool failed"

**Cause**: MCP server SSE endpoint issue or SQL connectivity  
**Solution**:

- Test MCP server directly: `curl $API_MCP_URL/sse`
- Check MCP server logs in Container Apps
- Verify SQL connection string uses Managed Identity

### Issue: "Chat succeeded but didn't return order information"

**Cause**: AI may not have called the correct tool or tool returned no data  
**Note**: This is a soft failure - the chat worked but may not have used the expected tool  
**Solution**:

- Check if customer has orders in database
- Review AI agent logs to see which tools were called

## Architecture Context

### Service Flow

```
Test Script
    ↓
    ├─→ DAB API (GraphQL) ──→ Azure SQL
    │                          (Test Data)
    ↓
    ├─→ Functions API (/api/agent/chat)
    │       ↓
    │       └─→ Azure AI Foundry (PersistentAgentsClient)
    │               ↓ (server-side in Foundry)
    │               ├─→ api-mcp MCP server
    │               └─→ DAB /mcp endpoint
    │                       ↓
    │                       └─→ Azure SQL
    │                           (Business Data)
    ↓
    └─→ MCP Server (/sse)
            ↓
            └─→ Azure SQL
                (Direct Tool Calls)
```

### Authentication

- **DAB API**: No authentication (configured in `dab-config.prod.json`)
- **Functions API**: Anonymous access for testing
- **MCP Server**: Internal communication via managed identity
- **Azure SQL**: Passwordless authentication via managed identity

## Test Coverage Matrix

| Feature                | Endpoint        | Tool                           | Status |
| ---------------------- | --------------- | ------------------------------ | ------ |
| Data Fetch             | DAB GraphQL     | -                              | ✓      |
| Agent Status           | Functions API   | -                              | ✓      |
| Simple Chat            | Functions API   | -                              | ✓      |
| Product Search Chat    | Functions API   | SearchProducts                 | ✓      |
| Order Chat             | Functions API   | GetCustomerOrders              | ✓      |
| Customer Orders        | MCP Direct      | GetCustomerOrders              | ✓      |
| Order Details          | MCP Direct      | GetOrderDetails                | ✓      |
| Complementary Products | MCP Direct      | FindComplementaryProducts      | ✓      |
| Product Search         | MCP Direct      | SearchProducts                 | ✓      |
| Product Details        | MCP Direct      | GetProductDetails              | ✓      |
| Recommendations        | MCP Direct      | GetPersonalizedRecommendations | ✓      |
| Review Analysis        | MCP Direct      | AnalyzeProductReviews          | ✓      |
| Inventory Check        | MCP Direct      | CheckInventoryAvailability     | ✓      |
| Chat Tool Integration  | Functions + MCP | All Tools                      | ✓      |

## Testing AI Foundry Features

The following scenarios verify the Foundry-specific features added across all four agents.

### Structured Inputs Resolution

Verify that `{{customerId}}` and `{{cultureId}}` placeholders in the Chat agent's instructions are resolved, not passed literally to the model:

```bash
# POST /api/agent/chat with customerId set — the agent should greet the customer by name
# (it looks them up via MCP tools using the resolved customerId, not the raw string)
curl -s -X POST "$API_FUNCTIONS_URL/api/agent/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"Who am I?","customerId":29825}' | jq '{response:.response, threadId:.threadId}'
```

The response should reference customer 29825's name — not contain literal `{{customerId}}` text.

### Memory Scoping (`x-memory-user-id`)

Verify that memory is scoped per user by checking that two different customers do not share conversation state:

```bash
# Customer A — ask about orders
curl -s -X POST "$API_FUNCTIONS_URL/api/agent/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"What was my last order?","customerId":29825}' | jq '.response'

# Customer B — ask about orders; should NOT reference Customer A's data
curl -s -X POST "$API_FUNCTIONS_URL/api/agent/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"What was my last order?","customerId":30119}' | jq '.response'
```

### `tool_choice: "required"` Enforcement

Verify that agents with `tool_choice: "required"` always invoke at least one MCP tool:

```bash
# Order Generation — check that ToolsUsed is populated
curl -s -X POST "$API_FUNCTIONS_URL/api/admin/generate-order" \
  -H "Content-Type: application/json" \
  -d '{"personaType":"weekend-warrior"}' | jq '.log[] | select(.type=="dim") | .message | select(contains("tools"))'

# Help-Me-Choose — check that tool calls appear in the response
curl -s -X POST "$API_FUNCTIONS_URL/api/help-me-choose/recommendations" \
  -H "Content-Type: application/json" \
  -d '{"budget":500,"activityType":"mountain biking"}' | jq '.toolsUsed'
```

Expect at least one tool name in `toolsUsed`/log for each call. An empty `toolsUsed` for these agents indicates a misconfiguration.

### PII Absence in Logs

Verify that customer email addresses do not appear in Application Insights traces from Order Generation:

```bash
# In Azure Portal → App Insights → Logs:
traces
| where message contains "Loaded profile:"
| project timestamp, message
| order by timestamp desc
| take 20
```

The `message` field should contain `CustomerID=` and order count stats but **not** an email address (e.g. `@adventure-works.com`).

### Agent Status Feature Flags

```bash
curl -s "$API_FUNCTIONS_URL/api/agent/status" | jq '.features'
```

Expected output includes: `"foundry-responses-api"`, `"structured-inputs"`, `"memory-scoping"`, `"tool-choice-required"`, `"dual-mcp-servers"`, `"multi-turn-persistence"`.

## Related Documentation

- [AI Agent Automation](AI_AGENT_AUTOMATION.md) - AI agent implementation details
- [MCP Server Documentation](api-functions/MCP_SERVER.md) - MCP server architecture
- [AI Chat MCP Testing](AI_CHAT_MCP_TESTING.md) - Initial testing approach
- [DAB API README](api/README.md) - DAB configuration and deployment

## Continuous Testing

This script can be integrated into CI/CD pipelines:

```yaml
# Example Azure DevOps pipeline step
- script: |
    chmod +x test-ai-and-mcp-complete.sh
    ./test-ai-and-mcp-complete.sh
  displayName: "Validate AI and MCP functionality"
  continueOnError: false
```

## Exit Codes

- `0`: All tests passed
- `1`: One or more tests failed

## Related Documentation

- AI agent automation and deployment: [AI_AGENT_AUTOMATION.md](AI_AGENT_AUTOMATION.md), [AI_AGENT_DEPLOYMENT_SUMMARY.md](AI_AGENT_DEPLOYMENT_SUMMARY.md)
- Agent migration to Microsoft Agents Framework: [AGENT_FRAMEWORK_MIGRATION.md](AGENT_FRAMEWORK_MIGRATION.md)
- Detailed telemetry implementation and queries: [AI_AGENT_TELEMETRY_IMPLEMENTATION.md](AI_AGENT_TELEMETRY_IMPLEMENTATION.md), [APP_INSIGHTS_INTEGRATION.md](APP_INSIGHTS_INTEGRATION.md), [APP_INSIGHTS_CONNECTION_STRING_FLOW.md](APP_INSIGHTS_CONNECTION_STRING_FLOW.md)
- MCP server implementation and tools: [../api-mcp/README.md](../api-mcp/README.md)
- Functions hosting the agent endpoints: [../api-functions/README.md](../api-functions/README.md)
- Focused chat/MCP test script guide: [AI_CHAT_MCP_TESTING.md](AI_CHAT_MCP_TESTING.md)

Use this in scripts:

```bash
if ./test-ai-and-mcp-complete.sh; then
    echo "Deployment validated successfully"
else
    echo "Validation failed - check logs"
    exit 1
fi
```
