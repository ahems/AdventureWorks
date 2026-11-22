# Coding Agent Instructions

This folder is the AdventureWorks **Manufacturing agent**: a Microsoft Foundry hosted agent
(.NET 10, Microsoft Agent Framework, Responses protocol) that analyses new sales orders
using AdventureWorks MCP tools served by `api-mcp`. Azure Functions invokes it from the
manufacturing agent queue. Repository-wide rules are in
[`.github/copilot-instructions.md`](../../.github/copilot-instructions.md); runtime details
are in [docs/services/manufacturing-agent.md](../../docs/services/manufacturing-agent.md).

## Key files

- `src/mcp-tools/Program.cs` — agent host, autonomy-mode tool allowlists (MCP snake_case wire names) and instructions
- `src/mcp-tools/McpServiceAuthentication.cs` — per-invocation managed-identity token exchange with api-mcp
- `src/mcp-tools/mcp-tools.csproj`, `src/mcp-tools/Dockerfile` — project and container definition
- `azure.yaml` — standalone azd project; the demo deploys through the root `azure.yaml`

## Development workflow

```bash
dotnet build manufacturing-agent/mcp-tools/src/mcp-tools/mcp-tools.csproj   # from the repo root
azd deploy manufacturing-agent --no-prompt                                  # from the repo root
```

- Deploy only with `azd deploy`. Never run `azd provision`, `azd up` or `azd down`, and never
  patch Azure resources by hand: this is a demo/POC environment (see the
  [demo/POC policy](../../.github/copilot-instructions.md#azure-environment-policy-demopoc-only)).
- The root `scripts/hooks/postdeploy.sh` wires api-mcp trust for the agent's identity; wait
  for it before invoking the agent.
- `azd ai agent run` (from this folder) runs the agent on `http://localhost:8088`, but api-mcp
  only trusts the deployed agent's identity, so test tool calls against the deployed agent.
- AI invocations cost money and may change data in FullyAutonomous mode; run them intentionally.
- Do not commit or push changes; the user handles Git.

## Microsoft Foundry Skill

Install the **Microsoft Foundry Skill** for guided deployment, evaluation, and troubleshooting workflows.

Direct install (preferred, works with any coding agent):

```bash
npx skills add https://github.com/microsoft/azure-skills --skill microsoft-foundry
```

Or install the Azure Skills Plugin:

- **Copilot CLI**: `/plugin marketplace add microsoft/azure-skills` then `/plugin install azure@azure-skills`
- **Claude Code**: `/plugin install azure@claude-plugins-official`

Then ask naturally, e.g. `Use the Microsoft Foundry Skill to deploy this agent.`

## References

- [docs/services/manufacturing-agent.md](../../docs/services/manufacturing-agent.md)
- [Hosted agents overview](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents)
- [Microsoft Foundry Skill](https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/use-microsoft-foundry-skill)
