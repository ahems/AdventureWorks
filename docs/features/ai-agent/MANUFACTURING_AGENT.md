# Manufacturing Agent

## Overview

The **Manufacturing Agent** is an autonomous AI agent that fires when a new order is placed in the AdventureWorks eshop. Unlike the other agents (which are conversational and invoked by a user), this agent runs programmatically with no human in the loop.

The agent is a **Foundry Hosted Agent** (`kind: hosted`) running .NET 10 code. It is controlled by a four-state autonomy mode that users configure from the Manufacturing app's Agent Control page.

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
       └── [mode check]
            │  Off  → skip (no queue message, zero token consumption)
            └► manufacturing-agent-queue
                  │  ManufacturingAgentQueueTrigger
                  ▼
         Foundry Hosted Agent (manufacturing-agent)
                  │  uses MCP tools (server-side via HostedMcpServerTool)
                  ├── ManufacturingMcpTools
                  └── SupplyChainMcpTools
```

## Autonomy modes

The agent supports four modes, configurable at runtime from the Agent Control page (`/manufacturing-agent`) in the manufacturing app:

| Mode                  | Value | Behaviour                                                                                                      | Token cost         |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Off**               | 0     | Agent is disabled. No queue messages enqueued, no AI tokens consumed. **Default.**                             | None               |
| **Read-Only**         | 1     | Agent analyses inventory for each order and logs findings. No actions taken.                                   | ~1–3k tokens/order |
| **Propose + Approve** | 2     | Agent proposes manufacturing runs and supply orders. Each proposal requires human approval before it executes. | ~2–5k tokens/order |
| **Fully Autonomous**  | 3     | Agent executes manufacturing runs and supply orders directly. No human approval required.                      | ~2–5k tokens/order |

### Switching modes

1. Navigate to **Agent Control** in the manufacturing app sidebar.
2. Select the desired mode from the four-option selector.
3. Switching to Fully Autonomous requires confirmation.
4. The mode takes effect immediately — the next order placed will use the new mode.

> **Note:** Switching to Off clears the queue gate at the SQL trigger level. Any messages already in the queue will be discarded by the queue trigger without calling the hosted agent.

## How it works

1. **SQL Change Tracking** watches `Sales.SalesOrderHeader` for INSERTs. Azure Functions polls for changes and fires `OrderPlacedSqlTrigger`.
2. The trigger enqueues receipt generation and order status processing.
3. If the agent mode is **Off**, the trigger returns immediately — no queue message is created and no tokens are consumed.
4. Otherwise, a pending run record is created in Azure Table Storage and a message is enqueued on `manufacturing-agent-queue`.
5. `ManufacturingAgentQueueTrigger` dequeues one message at a time (`batchSize: 1`), reads the current mode, and calls the Foundry Hosted Agent via the Responses protocol.
6. The agent uses `ManufacturingMcpTools` and `SupplyChainMcpTools` to inspect inventory, assess manufacturing feasibility, and (in Propose/Autonomous modes) take or propose actions.
7. Results are written to the run record and visible in the Agent Control activity feed.

## Bottleneck model

The queue trigger processes one order at a time. When the shopping simulator runs at high volume, orders back up in `manufacturing-agent-queue` — exactly like work orders backing up at an understaffed shop floor location. The Agent Control page shows:

- **Queue depth** with a colour-coded bar (green → amber → red)
- **Estimated drain time** at the current processing rate
- **Retrying** entries when the agent hits token rate limits (exponential backoff: 10s → 20s → 40s → 80s → … → poison queue after 8 attempts)

## Configuration

| Environment variable           | Description                                                       |
| ------------------------------ | ----------------------------------------------------------------- |
| `MANUFACTURING_AGENT_ENDPOINT` | Foundry hosted agent responses endpoint (set by postdeploy.sh)    |
| `API_FUNCTIONS_URL`            | Functions base URL for step callbacks (set by Bicep + postdeploy) |
| `AI_FOUNDRY_PROJECT_ENDPOINT`  | Azure AI Foundry project endpoint                                 |
| `SQL_CONNECTION_STRING`        | Azure SQL connection string (Active Directory Default auth)       |
| `AzureWebJobsStorage__*`       | Storage account connection (Table Storage for run records, Queue) |

## Table Storage

Three tables are used (all in the `AzureWebJobsStorage` account):

| Table                        | Content                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `awManufacturingAgentConfig` | Single row: current mode                                                   |
| `awManufacturingAgentRuns`   | One row per agent invocation — status, findings, tools used, step progress |
| `awManufacturingProposals`   | Proposals created in ProposePending mode, with approve/reject status       |

## Deploying the hosted agent

The agent lives in `manufacturing-agent/mcp-tools/` and is deployed independently from the main `azd` project:

```bash
cd manufacturing-agent/mcp-tools
azd env set AZURE_AI_MODEL_DEPLOYMENT_NAME chat
azd env set MCP_SERVICE_URL $(azd env get-value MCP_SERVICE_URL --cwd ../..)
azd deploy
```

After deploy, set the endpoint in the main environment:

```bash
cd ../..
azd env set MANUFACTURING_AGENT_ENDPOINT \
  "https://<account>.services.ai.azure.com/api/projects/<project>/agents/manufacturing-agent/endpoint/protocols/openai/responses?api-version=v1"
bash scripts/hooks/api-functions-postdeploy.sh
```

## Local development

The SQL trigger does not fire locally unless you have a direct connection to Azure SQL with Change Tracking enabled. To test the queue pipeline locally:

1. Start the hosted agent: `cd manufacturing-agent/mcp-tools && azd ai agent run --no-client`
2. Start Azure Functions: `cd api-functions && func host start`
3. Manually enqueue a base64-encoded message:

```bash
MSG=$(echo -n '{"salesOrderId":71774,"customerId":29825,"runId":"test-001","retryCount":0}' | base64)
az storage message put --account-name <storage> --queue-name manufacturing-agent-queue --content "$MSG" --auth-mode login
```

Alternatively run the existing end-to-end test script:

```bash
bash tests/scripts/test-manufacturing-trigger.sh
```

## Telemetry

Each queue trigger invocation logs to Application Insights:

- `[AgentQueue] Invoking hosted agent for RunId=..., SalesOrderId=..., Mode=...`
- `[AgentQueue] RunId=... completed. Findings: ...`
- `[AgentQueue] Agent is Off — discarding RunId=...` (when mode is Off)

Query recent activity:

```kusto
traces
| where timestamp > ago(1h)
| where message contains "[AgentQueue]"
| order by timestamp desc
```

| `AzureWebJobsStorage` | Azure Storage connection for queue output bindings |

## Creating the agent

The manufacturing agent is created **automatically** during `azd up` as part of `postprovision.sh`. No manual step is required.

To recreate or update the agent after deployment, re-run the agent creation script:

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
