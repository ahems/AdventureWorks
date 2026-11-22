---
title: Manufacturing hosted agent (manufacturing-agent/mcp-tools/)
summary: Component README for the Microsoft Foundry hosted Manufacturing agent that analyses new sales orders with AdventureWorks MCP tools, covering its source files, settings, deployment, local runs and offline tests; runtime details live in docs/services/manufacturing-agent.md.
audience: [developer, operator, ai-agent]
components: [manufacturing-agent, api-mcp, api-functions]
related: [docs/services/manufacturing-agent.md, docs/features/manufacturing/manufacturing-agent.md, docs/services/api-mcp.md, docs/features/authentication/END_TO_END_AUTHENTICATION.md]
---

# Manufacturing hosted agent (`manufacturing-agent/mcp-tools/`)

A **Microsoft Foundry hosted agent** (Microsoft Agent Framework, Responses protocol) that
analyses sales orders with AdventureWorks manufacturing, inventory and supply-chain MCP
tools. The Functions manufacturing queue trigger invokes its Responses endpoint and
records the findings. Invocation, scopes per autonomy mode and runtime settings are
documented in **[docs/services/manufacturing-agent.md](../../docs/services/manufacturing-agent.md)**;
the business feature is in [manufacturing agent](../../docs/features/manufacturing/manufacturing-agent.md).

## Files

| Path | Purpose |
|---|---|
| `src/mcp-tools/Program.cs` | Agent host, per-mode tool allowlists and instructions |
| `src/mcp-tools/McpServiceAuthentication.cs` | Per-invocation managed-identity token exchange with api-mcp |
| `src/mcp-tools/mcp-tools.csproj`, `Dockerfile` | .NET 10 project and container definition |
| `azure.yaml` | Standalone azd project for working on the agent alone; the demo uses the root `azure.yaml` |
| `AGENTS.md`, `CLAUDE.md` | Coding-agent instructions |

## How authentication works

Before **each invocation** the agent obtains a managed-identity assertion for
`api://AzureADTokenExchange/.default`, exchanges it at the api-mcp `/token` endpoint and
passes the bearer token to the hosted MCP tool. Tokens are never cached at startup or
logged. Tool allowlists use the MCP **snake_case wire names** (for example
`get_order_details`), not C# method names. ReadOnly and ProposePending receive read
scopes and read tools only; FullyAutonomous also receives `manufacturing.write` and the
two action tools. See [api-mcp](../../docs/services/api-mcp.md) and the
[authentication guide](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md).

The hosted agent's instance identity must be trusted by api-mcp. After deployment the root
`scripts/hooks/postdeploy.sh` resolves the agent's `instance_identity.principal_id` (via
`scripts/utilities/hosted-agent-mcp-trust.py`), updates api-mcp's trust settings and
publishes `MANUFACTURING_AGENT_ENDPOINT` for Functions.

## Settings

| Variable | Description |
|---|---|
| `FOUNDRY_PROJECT_ENDPOINT` | Injected by Foundry (and by `azd ai agent run` locally) |
| `AZURE_AI_MODEL_DEPLOYMENT_NAME` | Chat model deployment, declared in `azure.yaml` |
| `MCP_SERVICE_URL` | HTTPS api-mcp endpoint ending in `/mcp` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Telemetry (injected when hosted) |

## Deploy

From the repository root:

```bash
azd deploy manufacturing-agent --no-prompt
```

The root postdeploy hook must complete before any AI smoke test. Don't run
`azd provision`, `azd up` or `azd down` yourself (see the
[demo/POC policy](../../.github/copilot-instructions.md#azure-environment-policy-demopoc-only)).

## Run locally

From this folder, `azd ai agent run` starts the agent on `http://localhost:8088` and
`azd ai agent invoke --local "<message>"` calls it. api-mcp trusts only the deployed
agent's principal, so MCP tool calls from a local run are rejected; test end-to-end
against the deployed agent. The VS Code Foundry Toolkit (**Foundry Toolkit: Deploy Hosted
Agent**) is an alternative way to run and deploy.

## Offline tests

No AI calls or Azure changes:

```bash
dotnet test api-functions.Tests/api-functions.Tests.csproj --filter 'FullyQualifiedName~ManufacturingAgentResponseTests|FullyQualifiedName~ManufacturingMcpAuthenticationTests'
dotnet build manufacturing-agent/mcp-tools/src/mcp-tools/mcp-tools.csproj
python3 -m unittest discover -s tests/scripts -p test_hosted_agent_mcp_trust.py
python3 -m unittest discover -s tests/scripts -p test_manufacturing_agent_tools.py
```

## Troubleshooting

**Images built on Apple Silicon or other ARM64 machines do not run on the hosted agent
service.** `azd deploy` uses a remote build and produces the correct architecture. If you
build locally on a non-`linux/amd64` machine, use
`docker build --platform=linux/amd64 -t image .`.
