# AI Chat and MCP Test Results - Issues Found

## Test Execution Summary

**Date:** January 15, 2026  
**Script:** `test-ai-and-mcp-complete.sh`  
**Total Tests:** 20  
**Passed:** 18  
**Failed:** 2

## Test Results by Section

### ✅ Part 1: DAB API Data Fetching (3/3 PASSED)

- Successfully fetches customer with completed orders
- Successfully retrieves product details
- Successfully fetches order with detail lines
- **Note:** Now properly handles DAB's 100-item pagination limit

### ✅ Part 2: AI Agent Functions API (4/4 PASSED)

- Agent status endpoint operational
- Simple chat requests work
- Product search intent handled
- Order inquiry handled
- **Note:** Basic API functionality works, but tool integration fails

### ✅ Part 3: MCP Server Tools Direct Testing (10/10 PASSED)

All MCP tools work correctly when called directly via JSON-RPC 2.0:

- ✅ get_customer_orders - Returns order history successfully
- ✅ get_order_details - Returns detailed order information
- ✅ find_complementary_products - Returns recommendations
- ✅ search_products - Successfully searches and returns products
- ✅ get_product_details - Returns product specifications
- ✅ get_personalized_recommendations - Returns AI-powered suggestions
- ✅ analyze_product_reviews - Returns review analysis with sentiment
- ✅ check_inventory_availability - Returns stock information

**Key Finding:** The MCP server itself is working perfectly!

### ❌ Part 4: AI Chat with MCP Integration (1/3 PASSED)

- ✅ Order query - Detects intent but fails to get data
- ❌ Product search - AI calls tools but receives errors
- ❌ Product details - AI calls tools but receives errors

## Root Cause Analysis

### The Problem

The AI Agent's chat feature (`AIAgentFunctions`) successfully:

1. Receives user requests ✓
2. Identifies which MCP tools to call ✓
3. Makes tool call requests ✓

BUT the tool calls fail because: 4. Wrong endpoint is being called ✗ 5. Wrong request format is being used ✗

### Technical Details

**Current Implementation (BROKEN):**

```csharp
// File: api-functions/Services/AIAgentService.cs
// Line: ~360

private async Task<string> CallMCPToolAsync(string toolName, string argumentsJson)
{
    var httpClient = _httpClientFactory.CreateClient();

    var mcpRequest = new
    {
        name = toolName,
        arguments = JsonSerializer.Deserialize<Dictionary<string, object>>(argumentsJson)
    };

    // ❌ PROBLEM: This endpoint doesn't exist
    var response = await httpClient.PostAsJsonAsync(_mcpServerUrl, mcpRequest);
    // ...
}
```

**Configuration Issue:**

```csharp
// Line: ~44
_mcpServerUrl = mcpServiceUrl.TrimEnd('/') + "/api/mcp/call";
```

Uses environment variable: `MCP_SERVICE_URL` → Points to OLD REST API endpoint

**What's Wrong:**

1. **Wrong Endpoint:**

   - Current: `/api/mcp/call` (REST API - no longer exists)
   - Should be: `/mcp` (JSON-RPC 2.0 SSE endpoint)

2. **Wrong Request Format:**

   - Current: `{ name, arguments }`
   - Should be: `{ jsonrpc: "2.0", method: "tools/call", params: { name, arguments }, id }`

3. **Wrong Environment Variable:**
   - Current: Uses `MCP_SERVICE_URL` (points to Functions, not MCP server)
   - Should use: `API_MCP_URL` (points to actual MCP Container App)

### Evidence from Tests

**Direct MCP Tool Call (WORKS):**

```bash
curl -X POST "https://av-mcp-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/mcp" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "get_customer_orders",
      "arguments": {"customerId": 29825}
    },
    "id": 1
  }'

# Response: Success with order data
```

**AI Agent Call (FAILS):**

```bash
curl -X POST "https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/agent/chat" \
  -d '{"message": "Show my orders", "customerId": 29825}'

# AI calls MCP tool but gets error
# Response: "I am having trouble retrieving your order information"
```

## Required Fixes

### Fix 1: Update AIAgentService.cs

**File:** `api-functions/Services/AIAgentService.cs`

**Change 1 - Configuration (Line ~44):**

```csharp
// OLD:
_mcpServerUrl = mcpServiceUrl.TrimEnd('/') + "/api/mcp/call";

// NEW:
_mcpServerUrl = mcpServiceUrl.TrimEnd('/') + "/mcp";
```

**Change 2 - Environment Variable (Line ~40):**

```csharp
// OLD:
var mcpServiceUrl = configuration["MCP_SERVICE_URL"];

// NEW:
var mcpServiceUrl = configuration["API_MCP_URL"];
```

**Change 3 - Request Format (Line ~360):**

```csharp
// OLD:
private async Task<string> CallMCPToolAsync(string toolName, string argumentsJson)
{
    var httpClient = _httpClientFactory.CreateClient();

    var mcpRequest = new
    {
        name = toolName,
        arguments = JsonSerializer.Deserialize<Dictionary<string, object>>(argumentsJson)
    };

    var response = await httpClient.PostAsJsonAsync(_mcpServerUrl, mcpRequest);
    response.EnsureSuccessStatusCode();

    var result = await response.Content.ReadAsStringAsync();
    return result;
}

// NEW:
private async Task<string> CallMCPToolAsync(string toolName, string argumentsJson)
{
    var httpClient = _httpClientFactory.CreateClient();

    var mcpRequest = new
    {
        jsonrpc = "2.0",
        method = "tools/call",
        @params = new
        {
            name = toolName,
            arguments = JsonSerializer.Deserialize<Dictionary<string, object>>(argumentsJson)
        },
        id = Guid.NewGuid().GetHashCode()
    };

    var response = await httpClient.PostAsJsonAsync(_mcpServerUrl, mcpRequest);
    response.EnsureSuccessStatusCode();

    var result = await response.Content.ReadAsStringAsync();

    // Parse SSE response (format: "event: message\ndata: {...}")
    var lines = result.Split('\n');
    var dataLine = lines.FirstOrDefault(l => l.StartsWith("data: "));
    if (dataLine != null)
    {
        var jsonData = dataLine.Substring(6); // Remove "data: " prefix
        var mcpResponse = JsonSerializer.Deserialize<JsonElement>(jsonData);

        // Extract the actual tool result text
        var content = mcpResponse.GetProperty("result")
            .GetProperty("content")[0]
            .GetProperty("text")
            .GetString();

        return content ?? "No response from tool";
    }

    return result;
}
```

### Fix 2: Update Environment Configuration

Ensure the Functions app has access to the correct environment variable:

```bash
# In Azure Container Apps or local.settings.json
API_MCP_URL=https://av-mcp-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io
```

### Fix 3: Update Deployment Configuration

**File:** `infra/modules/functions.bicep` or relevant infrastructure

Ensure the Functions Container App has the `API_MCP_URL` environment variable set to the MCP server's URL.

## Testing After Fixes

Once fixes are applied, re-run the test script:

```bash
./test-ai-and-mcp-complete.sh
```

**Expected Results:**

- All 20 tests should pass ✅
- Part 4 tests should show successful MCP tool integration
- AI chat responses should include actual data from MCP tools

## Impact Assessment

### Current State

- **Direct MCP Tool Access:** ✅ Working (API consumers can call MCP directly)
- **AI Chat Feature:** ⚠️ Partially Working (recognizes intent but can't execute tools)
- **User Experience:** ❌ Degraded (AI tells users it can't retrieve data)

### After Fixes

- **Direct MCP Tool Access:** ✅ Working
- **AI Chat Feature:** ✅ Fully Working (AI successfully uses all MCP tools)
- **User Experience:** ✅ Excellent (AI provides actual order/product data)

## Additional Recommendations

### 1. Error Handling Enhancement

Add better error logging in `CallMCPToolAsync` to catch and report MCP endpoint errors:

```csharp
catch (HttpRequestException ex)
{
    _logger.LogError(ex, $"Failed to call MCP tool {toolName} at {_mcpServerUrl}");
    throw new InvalidOperationException($"MCP tool call failed: {ex.Message}", ex);
}
```

### 2. Health Check Endpoint

Add a health check that verifies MCP server connectivity:

```csharp
[Function("MCPHealthCheck")]
public async Task<HttpResponseData> CheckMCPHealth([HttpTrigger(AuthorizationLevel.Anonymous, "get")] HttpRequestData req)
{
    var isHealthy = await _agentService.CheckMCPServerHealthAsync();
    var response = req.CreateResponse(isHealthy ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable);
    await response.WriteAsJsonAsync(new { mcpServerHealthy = isHealthy });
    return response;
}
```

### 3. Integration Testing

Add automated tests that verify AI Agent → MCP Server integration in CI/CD pipeline.

### 4. Monitoring

Set up Application Insights alerts for:

- MCP tool call failures
- High tool call latency
- Tool call error rates

## Next Steps

1. ✅ Identify issues (DONE - this document)
2. ⏳ Apply code fixes to AIAgentService.cs
3. ⏳ Update environment configuration
4. ⏳ Deploy updated Functions app
5. ⏳ Re-run test suite to verify
6. ⏳ Monitor production for any issues

## Related Files

- **Test Script:** `/workspaces/AdventureWorks/test-ai-and-mcp-complete.sh`
- **Service Code:** `/workspaces/AdventureWorks/api-functions/Services/AIAgentService.cs`
- **MCP Server:** `/workspaces/AdventureWorks/api-mcp/AdventureWorks/Tools/AdventureWorksMcpTools.cs`
- **Documentation:** `/workspaces/AdventureWorks/AI_AND_MCP_TESTING_GUIDE.md`
