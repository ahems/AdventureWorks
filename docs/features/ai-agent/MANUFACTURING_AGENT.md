# Manufacturing Agent

## Overview

The **Manufacturing Agent** is an autonomous AI agent that fires when a new order is placed in the AdventureWorks eshop. Unlike the other agents (which are conversational and invoked by a user), this agent runs programmatically with no human in the loop.

## Architecture

```
Customer places order
       │
       ▼
Sales.SalesOrderHeader (INSERT)
       │  SQL Change Tracking
       ▼
OrderPlacedSqlTrigger (Azure Function)
       ├── order-receipt-generation queue  ──► GenerateAndSendReceiptFunction
       ├── sales-order-status queue        ──► ProcessSalesOrderStatus_QueueTrigger
       └── ManufacturingAgentService.InvokeFireAndForget()
                  │
                  ▼
         Azure AI Foundry (Responses API)
                  │  uses MCP tools
                  ├── ManufacturingMcpTools
                  └── SupplyChainMcpTools
```

## How it works

1. **SQL Change Tracking** watches `Sales.SalesOrderHeader` for INSERTs. Azure Functions polls for changes and fires `OrderPlacedSqlTrigger`.
2. The trigger enqueues receipt generation and order status processing — replacing the two HTTP calls that `OrderConfirmationPage.tsx` used to make client-side.
3. The trigger calls `ManufacturingAgentService.InvokeFireAndForget()` which posts a message to the Azure AI Foundry Responses API and returns immediately. The agent run continues asynchronously.
4. The agent uses `ManufacturingMcpTools` and `SupplyChainMcpTools` exposed by the MCP server to inspect inventory levels, check manufacturing feasibility, and review supply chain options.

## Current behaviour (stub phase)

The agent:

- Acknowledges the order trigger
- Calls `GetOrderDetails` and `CheckInventoryAvailability` for ordered products
- Logs findings and any concerns about stock levels
- **Does not** place supply orders or start manufacturing runs yet

## Configuration

| Environment variable          | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `AI_AGENT_MANUFACTURING_ID`   | Foundry agent ID (set by `manufacturing-agent.sh`)          |
| `AI_FOUNDRY_PROJECT_ENDPOINT` | Azure AI Foundry project endpoint                           |
| `SQL_CONNECTION_STRING`       | Azure SQL connection string (Active Directory Default auth) |
| `AzureWebJobsStorage`         | Azure Storage connection for queue output bindings          |

## Creating the agent

Run after `azd provision` to create or update the agent in Azure AI Foundry:

```bash
bash scripts/utilities/agents/manufacturing-agent.sh
```

Or run all agents at once:

```bash
bash scripts/utilities/create-foundry-agents.sh
```

The script writes `AI_AGENT_MANUFACTURING_ID` to the azd environment automatically.

## SQL Change Tracking prerequisite

SQL Change Tracking is enabled on `Sales.SalesOrderHeader` by `scripts/hooks/postprovision.sh`:

```sql
ALTER DATABASE [AdventureWorks]
    SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);

ALTER TABLE [Sales].[SalesOrderHeader]
    ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF);
```

To enable manually:

```bash
# Get SQL credentials
SQL_SERVER=$(azd env get-value SQL_SERVER_NAME)
SQL_DB=$(azd env get-value SQL_DATABASE_NAME)

# Run via sqlcmd (requires az login)
az sql db query \
  --server "$SQL_SERVER" --database "$SQL_DB" \
  --query "ALTER TABLE [Sales].[SalesOrderHeader] ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF)"
```

## Local development

The SQL trigger does not fire locally unless you have a direct connection to Azure SQL with Change Tracking enabled. To test locally:

1. Run the functions host:
   ```bash
   cd api-functions && func host start
   ```
2. The SQL trigger requires `SQL_CONNECTION_STRING` pointing to Azure SQL.
3. Insert a test order via DAB to trigger the function.

Alternatively use the test script:

```bash
bash tests/scripts/test-manufacturing-trigger.sh
```

## Telemetry

Each agent invocation creates a `RequestTelemetry` operation in Application Insights named `ManufacturingAgent.Invoke` with properties:

- `SalesOrderId`
- `CustomerId`
- `ResponseId` (from Foundry)

## Future extension points

- Enable `BeginManufacturingRun` when stock falls below a threshold
- Enable `PlaceSupplyOrder` to automatically reorder from preferred vendors
- Add structured output schema for the agent to return a typed manufacturing plan
- Add a human-approval gate before placing expensive supply orders
