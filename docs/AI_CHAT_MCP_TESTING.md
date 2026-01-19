# AI Chat & MCP Server Testing Guide

This document describes the comprehensive test script for validating the AI Chat Feature and MCP Server functionality.

## Overview

The test script `test-ai-chat-and-mcp.sh` validates:

1. **MCP Server Tools** - Direct testing of all 8 MCP tools
2. **AI Agent Functions** - Testing the AI Chat API endpoints
3. **End-to-End Integration** - Verifying AI Chat correctly invokes MCP tools

## Prerequisites

- Application deployed to Azure (`azd up` completed)
- `jq` installed for JSON parsing
- Active Azure credentials (`azd auth login`)

## Running the Tests

```bash
./test-ai-chat-and-mcp.sh
```

The script will automatically:

1. Load Azure environment variables from `azd env get-values`
2. Fetch a test CustomerID from the DAB API (most recent customer)
3. Fetch a test ProductID from the DAB API
4. Execute all test scenarios
5. Report pass/fail status with summary

## Test Coverage

### Part 1: MCP Server Tools (Direct Testing)

Tests all 8 MCP tools by calling the MCP server endpoint directly:

| Test | MCP Tool                         | Description                                              |
| ---- | -------------------------------- | -------------------------------------------------------- |
| 1    | `GetCustomerOrders`              | Retrieves order history for a customer                   |
| 2    | `SearchProducts`                 | Searches products by keyword (e.g., "bike")              |
| 3    | `GetProductDetails`              | Gets detailed info for a specific product                |
| 4    | `FindComplementaryProducts`      | Finds products frequently bought together                |
| 5    | `GetPersonalizedRecommendations` | Gets personalized recommendations for customer           |
| 6    | `AnalyzeProductReviews`          | Analyzes customer reviews for a product                  |
| 7    | `CheckInventoryAvailability`     | Checks inventory across warehouses                       |
| 8    | `GetOrderDetails`                | Gets detailed order information (if customer has orders) |

**MCP Endpoint Format:**

```bash
POST https://<mcp-url>/api/mcp/call
Content-Type: application/json

{
  "name": "GetCustomerOrders",
  "arguments": {
    "customerId": 30119
  }
}
```

### Part 2: AI Agent Functions

Tests the AI Chat API endpoints:

| Test  | Endpoint                | Description                           |
| ----- | ----------------------- | ------------------------------------- |
| 9     | `GET /api/agent/status` | Checks agent health and configuration |
| 10-18 | `POST /api/agent/chat`  | Various chat scenarios (see below)    |

### Part 3: AI Chat Integration Tests

Tests AI Chat with various prompts that should trigger specific MCP tools:

| Test | User Message                                | Expected Tool(s)                   | Validation                     |
| ---- | ------------------------------------------- | ---------------------------------- | ------------------------------ |
| 10   | "Hello! I need help."                       | None                               | Basic greeting response        |
| 11   | "Show me my recent orders"                  | `get_customer_orders`              | Returns order list             |
| 12   | "Find me some mountain bikes"               | `search_products`                  | Returns matching products      |
| 13   | "Tell me about product ID X"                | `get_product_details`              | Returns product details        |
| 14   | "What products would you recommend for me?" | `get_personalized_recommendations` | Returns recommendations        |
| 15   | "Is product X in stock?"                    | `check_inventory_availability`     | Returns inventory status       |
| 16   | Multi-turn conversation                     | Context-aware                      | Maintains conversation context |
| 17   | "What do customers say about product X?"    | `analyze_product_reviews`          | Returns review analysis        |
| 18   | "What goes well with product X?"            | `find_complementary_products`      | Returns complementary items    |

**Chat Request Format:**

```bash
POST https://<functions-url>/api/agent/chat
Content-Type: application/json

{
  "message": "Show me my recent orders",
  "customerId": 30119,
  "conversationHistory": [
    {"role": "user", "content": "previous message"},
    {"role": "assistant", "content": "previous response"}
  ]
}
```

**Chat Response Format:**

```json
{
  "response": "Here are your recent orders...",
  "suggestedQuestions": ["Track my order", "Find products"],
  "toolsUsed": ["get_customer_orders"]
}
```

## Data Sources

The script uses the **DAB API** (GraphQL) to fetch test data:

1. **Customer ID**: Queries for most recently added customer

   ```graphql
   query {
     customers(orderBy: { CustomerID: DESC }, first: 1) {
       items {
         CustomerID
         PersonID
       }
     }
   }
   ```

2. **Product ID**: Queries for a finished goods product

   ```graphql
   query {
     products(first: 1, filter: { FinishedGoodsFlag: { eq: true } }) {
       items {
         ProductID
         Name
         ListPrice
       }
     }
   }
   ```

3. **Order ID**: Queries for customer's most recent order (if exists)
   ```graphql
   query {
     salesOrderHeaders(
       filter: { CustomerID: { eq: $customerId } }
       orderBy: { OrderDate: DESC }
       first: 1
     ) {
       items {
         SalesOrderID
         OrderDate
         TotalDue
       }
     }
   }
   ```

## Expected Output

The script provides colored output:

- 🔵 **Blue**: Test in progress
- ✅ **Green**: Test passed
- ❌ **Red**: Test failed
- 🟡 **Yellow**: Section headers

Example output:

```
=====================================
STEP 1: Get Test CustomerID from DAB
=====================================

Fetching most recent customer from DAB API...
✓ Retrieved Customer ID: 30119 (Person ID: 20777)
✓ Retrieved Product: ML Mountain Seat Assembly (ID: 717, Price: $133.34)

=====================================
STEP 2: Test MCP Server Tools
=====================================

Testing: MCP Tool: GetCustomerOrders
✓ PASSED: MCP Tool: GetCustomerOrders

Testing: MCP Tool: SearchProducts
✓ PASSED: MCP Tool: SearchProducts

... (more tests)

=====================================
Test Summary
=====================================

Total Tests: 18
Passed: 18
Failed: 0

🎉 All tests passed!
```

## Troubleshooting

### Test Failures

If tests fail, check:

1. **Azure Services Running**: Ensure all services are deployed

   ```bash
   az containerapp list -g $AZURE_RESOURCE_GROUP --query "[].{Name:name, Status:properties.provisioningState}"
   ```

2. **Environment Variables**: Verify URLs are set

   ```bash
   azd env get-values | grep -E "API_URL|API_FUNCTIONS_URL|API_MCP_URL"
   ```

3. **Service Health**: Check individual service endpoints

   ```bash
   curl https://<functions-url>/api/agent/status
   ```

4. **Database Connection**: Ensure DAB API can query database
   ```bash
   curl -X POST https://<dab-url> -H "Content-Type: application/json" \
     -d '{"query": "{ customers(first: 1) { items { CustomerID } } }"}'
   ```

### Common Issues

| Issue                           | Cause                          | Solution                          |
| ------------------------------- | ------------------------------ | --------------------------------- |
| "Required Azure URLs not found" | Not deployed or env not loaded | Run `azd up` or `azd env refresh` |
| "Failed to retrieve CustomerID" | Database empty or DAB down     | Check database has data           |
| MCP tool returns empty          | MCP server down                | Check `$API_MCP_URL/health`       |
| AI Chat timeout                 | OpenAI quota exceeded          | Check Azure OpenAI deployment     |
| JSON parse error                | Invalid response format        | Enable verbose mode: `set -x`     |

### Verbose Mode

For detailed debugging, enable verbose output:

```bash
bash -x ./test-ai-chat-and-mcp.sh
```

## Integration with CI/CD

The script returns appropriate exit codes:

- **0**: All tests passed
- **1**: One or more tests failed

Use in Azure Pipelines:

```yaml
- script: ./test-ai-chat-and-mcp.sh
  displayName: "Test AI Chat & MCP Server"
  continueOnError: false
```

Use in GitHub Actions:

```yaml
- name: Test AI Chat & MCP Server
  run: ./test-ai-chat-and-mcp.sh
```

## Architecture Flow

The test validates this complete flow:

```
User Message (HTTP)
    ↓
Functions API (/api/agent/chat)
    ↓
AIAgentService (with Azure OpenAI)
    ↓
Function Calling Decision
    ↓
MCP Server (/api/mcp/call)
    ↓
MCP Tool Execution (AdventureWorksMcpTools)
    ↓
Database Queries (via Services)
    ↓
Response Flow (reverse)
    ↓
AI-Generated Response + Suggestions
```

## Related Documentation

- [AI_AGENT_AUTOMATION.md](AI_AGENT_AUTOMATION.md) - AI Agent implementation details
- [api-mcp/AdventureWorks/README.md](api-mcp/AdventureWorks/README.md) - MCP Server documentation
- [api-functions/README.md](api-functions/README.md) - Functions API documentation
- [MCP_SERVER_TESTING.md](MCP_SERVER_TESTING.md) - Manual MCP testing guide

## Tool Mapping Reference

| AI Function Name                   | MCP Tool Name                    | MCP Method                                         |
| ---------------------------------- | -------------------------------- | -------------------------------------------------- |
| `get_customer_orders`              | `GetCustomerOrders`              | `OrderService.GetCustomerOrderStatusAsync`         |
| `get_order_details`                | `GetOrderDetails`                | `OrderService.GetOrderDetailsAsync`                |
| `search_products`                  | `SearchProducts`                 | `ProductService.GetFinishedGoodsProductsAsync`     |
| `get_product_details`              | `GetProductDetails`              | `ProductService.GetFinishedGoodsProductsAsync`     |
| `find_complementary_products`      | `FindComplementaryProducts`      | `OrderService.FindComplementaryProductsAsync`      |
| `get_personalized_recommendations` | `GetPersonalizedRecommendations` | `OrderService.GetPersonalizedRecommendationsAsync` |
| `analyze_product_reviews`          | `AnalyzeProductReviews`          | `ReviewService.AnalyzeProductReviewsAsync`         |
| `check_inventory_availability`     | `CheckInventoryAvailability`     | `ProductService.CheckInventoryAvailabilityAsync`   |
