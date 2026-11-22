---
title: Hosted Manufacturing agent (Foundry hosted agent)
summary: How the .NET Manufacturing agent runs as a Foundry hosted agent, how Functions invokes it, how it authenticates to api-mcp with a managed-identity grant, which MCP tools each autonomy mode allows, and how to deploy it.
audience: [developer, operator, architect, ai-agent]
components: [manufacturing-agent, api-functions, api-mcp, infra]
related:
  - docs/features/manufacturing/manufacturing-agent.md
  - docs/services/api-mcp.md
  - docs/architecture/ai-architecture.md
  - docs/features/ai/foundry-agents.md
---

# Hosted Manufacturing agent

The Manufacturing agent analyses each new sales order, checks inventory and production feasibility, and then reports, proposes or acts, depending on the configured autonomy mode. It is a .NET 10 app in [`manufacturing-agent/mcp-tools/src/mcp-tools/`](../../manufacturing-agent/mcp-tools/src/mcp-tools/) that runs as a **Foundry hosted agent** using the Responses protocol.

This page covers how the agent runs. For what it does from a user's point of view (modes, proposals and the manufacturing portal screens), see the [Manufacturing agent feature](../features/manufacturing/manufacturing-agent.md).

## How it is invoked

```mermaid
sequenceDiagram
    participant SQL as "Azure SQL"
    participant T as "OrderPlacedSqlTrigger"
    participant Q as "manufacturing-agent-queue"
    participant F as "ManufacturingAgentQueue_QueueTrigger"
    participant A as "Hosted Manufacturing agent"
    participant M as "api-mcp"
    SQL->>T: "New SalesOrderHeader row"
    T->>T: "Read mode (Off, ReadOnly, ProposePending, FullyAutonomous)"
    T->>Q: "Enqueue run (when mode is not Off)"
    Q->>F: "Dequeue"
    F->>A: "POST Responses request: order, mode, run ID"
    A->>M: "Managed-identity grant at /token"
    M-->>A: "MCP token with the mode's scopes"
    A->>M: "MCP tool calls (inventory, feasibility, supply)"
    A-->>F: "JSON: findingsSummary, toolsUsed, recommendedActions, actionsExecuted"
    F->>F: "Save run; in ProposePending create proposals; push manufacturing-agent events"
```

- The mode is stored in the `awManufacturingAgentConfig` table and defaults to Off. Runs are stored in `awManufacturingAgentRuns`.
- Functions calls `MANUFACTURING_AGENT_ENDPOINT` with an Entra token for `https://ai.azure.com`. If the call fails, the queue trigger re-enqueues the run with exponential backoff.
- In **ProposePending** mode, Functions (not the model) creates a proposal for each recommended action through `POST /api/manufacturing/proposals`. People approve or reject proposals in the manufacturing portal.
- Progress is pushed to the `manufacturing-agent` Web PubSub group. See [Web PubSub events](../reference/webpubsub-events.md).

## Authentication to api-mcp

On each request the agent exchanges its managed-identity token at api-mcp `/token`:

- Grant type `urn:adventureworks:params:oauth:grant-type:managed-identity`, client `adventureworks-agents`, resource `<api-mcp origin>/mcp`.
- It requests exactly the scopes for the current mode and rejects the response if api-mcp grants a different set.
- api-mcp accepts the grant only from principals in `MCP_TRUSTED_SERVICE_PRINCIPAL_IDS`. After each deployment, `postdeploy.sh` uses [`hosted-agent-mcp-trust.py`](../../scripts/utilities/hosted-agent-mcp-trust.py) to find the agent's principal and sets `MCP_TRUSTED_SERVICE_PRINCIPAL_IDS` and `MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID` on api-mcp.
- `ServicePrincipalPolicy` in api-mcp limits the agent to its allowed tools, and `ManufacturingAutonomyGuard` checks the current mode before the two action tools run.

The token is attached to a server-side MCP tool (`adventureworks_mcp`), so Foundry calls api-mcp on the agent's behalf without an approval step.

## Tools by mode

| Mode | Scopes | Tools |
|---|---|---|
| ReadOnly, ProposePending | `mcp.access`, `products.read`, `orders.read`, `inventory.read`, `manufacturing.read` | 18 read tools: `get_manufacturing_status`, `get_active_manufacturing_operations`, `get_production_feasibility`, `get_all_products_feasibility`, `get_manufacturing_catalog_snapshot`, `get_overstock_items`, `get_thin_margin_products`, `get_component_shortage_forecast`, `get_reorder_recommendations`, `get_supply_chain_vendors`, `get_vendor_details`, `get_supply_catalog`, `get_supply_quote`, `get_active_supply_orders`, `get_supply_order_history`, `get_order_details`, `check_inventory_availability`, `get_product_details` |
| FullyAutonomous | The above plus `manufacturing.write` | The 18 read tools plus `begin_manufacturing_run` and `place_supply_order` |

## Runtime

| Setting | Value |
|---|---|
| Framework | Microsoft Agent Framework (`Microsoft.Agents.AI.Foundry.Hosting` 1.12.0-preview), Responses protocol |
| azd service | `manufacturing-agent` in [`azure.yaml`](../../azure.yaml), `host: azure.ai.agent`, kind `hosted` |
| Size | 0.5 CPU, 1 Gi |
| Model | `AZURE_AI_MODEL_DEPLOYMENT_NAME`, set to `chatGptDeploymentName` (default `chat`) |
| Settings | `MCP_SERVICE_URL`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `OTEL_SERVICE_NAME=manufacturing-agent`; Foundry injects `FOUNDRY_PROJECT_ENDPOINT` |
| Endpoint | azd stores `AGENT_MANUFACTURING_AGENT_RESPONSES_ENDPOINT`; `postdeploy.sh` copies it to `MANUFACTURING_AGENT_ENDPOINT` for Functions, and keeps the earlier value when a service-scoped deploy doesn't republish it |

## Deploying

```bash
azd deploy manufacturing-agent --no-prompt
```

- `azd up` deploys the agent with the other services. If the endpoint is still missing afterwards, `postup.sh` runs the deploy command above.
- `postdeploy.sh` then refreshes the api-mcp trust settings and `api-functions-postdeploy.sh` writes `MANUFACTURING_AGENT_ENDPOINT` to the Function App.
- [`manufacturing-agent/mcp-tools/azure.yaml`](../../manufacturing-agent/mcp-tools/azure.yaml) is a standalone project file for working on the agent on its own. The root `azure.yaml` is the one used for the demo.

## Running locally

From `manufacturing-agent/mcp-tools/`, `azd ai agent run` starts the agent on `http://localhost:8088`, and `azd ai agent invoke --local "<message>"` sends it a request. Set `MCP_SERVICE_URL` and `AZURE_AI_MODEL_DEPLOYMENT_NAME`. The managed-identity grant only trusts the deployed agent's principal, so MCP tool calls from a local run are rejected unless that principal is trusted. Test end-to-end against the deployed agent.

If you build the image yourself on an ARM64 machine (for example Apple Silicon), build for `linux/amd64`; ARM64 images do not run on the hosted agent service.

See the project [README](../../manufacturing-agent/mcp-tools/README.md) for Foundry Toolkit and VS Code options.
