# MCP Server CustomerID Migration

## Overview

Migrated the MCP Server from email-based customer identification to CustomerID-based identification for proper data model alignment and security.

## Changes Made

### 1. OrderService.cs

**GetCustomerOrderStatusAsync:**

- Changed parameter from `string customerEmail` to `int customerId`
- Updated SQL query to filter by `cust.CustomerID = @CustomerId`
- Added LEFT JOIN to `Purchasing.ShipMethod` to get ship method name
- Updated result message to show "Customer ID" instead of email

**GetOrderDetailsAsync:**

- Changed parameter from `string? customerEmail` to `int? customerId`
- Made customerId optional for anonymous order lookups
- Updated SQL query with `@CustomerId IS NULL OR cust.CustomerID = @CustomerId` condition
- Added LEFT JOIN to `Purchasing.ShipMethod` to get ship method name
- Returns "not found" if order doesn't belong to specified customer

### 2. AdventureWorksMcpTools.cs

**Tool Definitions:**

**get_customer_orders:**

```json
{
  "name": "get_customer_orders",
  "description": "Get recent order history for a specific customer using their CustomerID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "customerId": {
        "type": "integer",
        "description": "The customer's ID to look up orders for"
      }
    },
    "required": ["customerId"]
  }
}
```

**get_order_details:**

```json
{
  "name": "get_order_details",
  "description": "Get detailed information about a specific order, optionally validating customer access",
  "inputSchema": {
    "type": "object",
    "properties": {
      "orderId": {
        "type": "integer",
        "description": "The order ID to get details for"
      },
      "customerId": {
        "type": "integer",
        "description": "Optional customer ID to validate order belongs to this customer"
      }
    },
    "required": ["orderId"]
  }
}
```

**ExecuteGetCustomerOrdersAsync:**

- Changed to extract `customerId` from arguments
- Validates customerId as integer
- Passes integer to OrderService

**ExecuteGetOrderDetailsAsync:**

- Extracts optional `customerId` from arguments
- Validates as integer if provided
- Passes as `int?` to OrderService

## Database Schema

**Sales.Customer table:**

- CustomerID (int, primary key)
- PersonID (references Person.Person)
- StoreID (nullable)
- AccountNumber
- TerritoryID

**Key relationships:**

- Customer → Person (via PersonID to BusinessEntityID)
- Person → EmailAddress (via BusinessEntityID, can be multiple emails)
- SalesOrderHeader → Customer (via CustomerID)
- SalesOrderHeader → ShipMethod (via ShipMethodID)

## Testing Results

### Test 1: Get Customer Orders

```bash
curl -X POST "https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{"name": "get_customer_orders", "arguments": {"customerId": 29825}}'
```

**Result:** ✅ Returns 10 orders for CustomerID 29825 (orders #67260, #61173, #55234, etc.)

### Test 2: Get Order Details (with customer validation)

```bash
curl -X POST "https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{"name": "get_order_details", "arguments": {"orderId": 67260, "customerId": 29825}}'
```

**Result:** ✅ Returns full order details (45 line items, total $44,393.22)

### Test 3: Customer Validation (access control)

```bash
curl -X POST "https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{"name": "get_order_details", "arguments": {"orderId": 43660, "customerId": 29825}}'
```

**Result:** ✅ Returns "Order #43660 not found." (order exists but belongs to CustomerID 29672)

### Test 4: Anonymous Order Lookup

```bash
curl -X POST "https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/mcp/call" \
  -H "Content-Type: application/json" \
  -d '{"name": "get_order_details", "arguments": {"orderId": 43660}}'
```

**Result:** ✅ Returns full order details without customer restriction

## Security Benefits

1. **Primary Key Usage:** CustomerID is the proper primary key, not email
2. **Multi-Email Support:** Customers can have multiple email addresses
3. **Access Control:** Optional customerId parameter enforces customer-specific data access
4. **Anonymous Access:** Order details can be looked up without customer restriction when customerId is omitted
5. **Integer IDs:** More efficient than string comparison for database queries

## Integration Notes

When integrating with the frontend:

1. **Logged-in users:** Pass the authenticated user's CustomerID from the frontend auth context
2. **Customer service agents:** Can use get_order_details without customerId for full access
3. **AI chatbot:** Should always include customerId when querying for logged-in users

Example frontend integration:

```typescript
// Get current user's orders
const customerOrders = await mcpClient.callTool({
  name: "get_customer_orders",
  arguments: {
    customerId: currentUser.customerId,
  },
});

// Get order details for current user (validated)
const orderDetails = await mcpClient.callTool({
  name: "get_order_details",
  arguments: {
    orderId: selectedOrderId,
    customerId: currentUser.customerId,
  },
});
```

## Next Steps

1. ✅ CustomerID migration complete
2. ✅ All tests passing
3. ⏳ Create AI agent in Microsoft Foundry
4. ⏳ Build frontend chat UI
5. ⏳ Integrate authenticated user's CustomerID in chat requests
