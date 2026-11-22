---
title: OAuth and MCP server (api-mcp/) — OpenIddict authorization server with 63 MCP tools
summary: Component README for api-mcp, the ASP.NET Core service that is both the AdventureWorks OAuth 2.0 authorization server and a protected MCP Streamable HTTP server with 63 tools; folders, tests, configuration and deployment.
audience: [developer, operator, security-reviewer, ai-agent]
components: [api-mcp]
related: [docs/services/api-mcp.md, docs/features/mcp-oauth/README.md, docs/features/mcp-oauth/TOOL_SCOPE_MATRIX.md, docs/apps/mcp-inspector.md]
---

# OAuth and MCP server (`api-mcp/`)

`api-mcp` is one ASP.NET Core (.NET 10) service with two jobs:

- **OAuth 2.0 authorization server** (OpenIddict). It signs in AdventureWorks database
  users and trusted Azure workloads and issues RS256 JWTs bound to one resource
  (MCP, DAB or Functions), signed with a Key Vault-backed certificate.
- **MCP server.** It serves **63 tools** at `/mcp` over **MCP Streamable HTTP**. Each tool
  call is checked against a per-tool scope, role and ownership policy. Commerce tools
  query SQL directly; manufacturing, supply-chain, bank and simulator tools call
  Azure Functions with a short-lived service token.

Foundry agents, the hosted Manufacturing agent, the MCP Inspector and the Functions AI
chat all use these tools. For the full service guide, see
**[docs/services/api-mcp.md](../docs/services/api-mcp.md)**; for the security design, see
the **[OAuth server design](../docs/features/mcp-oauth/README.md)** and the complete
**[tool scope matrix](../docs/features/mcp-oauth/TOOL_SCOPE_MATRIX.md)**.

**Tech and hosting:** .NET 10, OpenIddict and the MCP C# SDK, remote-built in ACR from
`api-mcp/Dockerfile` and hosted on **Azure Container Apps** (azd service `api-mcp`).

## Key folders

| Path | Contents |
|---|---|
| `AdventureWorks/Program.cs` | DI, OAuth server, MCP server, telemetry and health endpoints |
| `AdventureWorks/Auth/` | OAuth clients, grants, scopes, roles and tool authorization policy |
| `AdventureWorks/Tools/` | The six MCP tool classes (63 tools) |
| `AdventureWorks/Services/` | SQL data access, Functions proxy and AI helpers |
| `AdventureWorks/Telemetry/` | Application Insights telemetry helpers |
| `AdventureWorks.Tests/` | xUnit tests (OAuth, tool authorization, inventory) |
| `ServiceDefaults/` | Shared OpenTelemetry, health and resilience defaults |

## Endpoints

`/.well-known/openid-configuration`, `/authorize`, `/token`, `/login`, `/logout`,
`/mcp` (requires an MCP-audience token), `/health` and `/alive` (liveness) and `/ready`
(readiness). The `API_MCP_URL` / `MCP_SERVICE_URL` azd outputs end in `/mcp`; strip it
for the OAuth issuer base.

## Test and call

```bash
dotnet test api-mcp/AdventureWorks.Tests
python3 scripts/utilities/azure-auth.py token --identity manufacturing --resource mcp   # never print or share tokens
```

The service runs only in Azure; deploy changes with `azd deploy api-mcp --no-prompt`.
Browse and call tools interactively with the [MCP Inspector](../docs/apps/mcp-inspector.md).

## Configuration

Key settings: SQL connection (managed identity), `MCP_SIGNING_KEY_VAULT_URI` and
`MCP_SIGNING_CERTIFICATE_NAME`, `API_FUNCTIONS_URL`, OAuth redirect URIs and trusted
service principals (set by `scripts/hooks/postdeploy.sh`). See the
[environment variables reference](../docs/reference/environment-variables.md#oauth-and-mcp-server-api-mcp).

## Deploy

```bash
azd deploy api-mcp --no-prompt
```

## Related docs

- [api-mcp service guide](../docs/services/api-mcp.md)
- [OAuth server design](../docs/features/mcp-oauth/README.md) and [tool scope matrix](../docs/features/mcp-oauth/TOOL_SCOPE_MATRIX.md)
- [Identity and authentication](../docs/architecture/identity-and-auth.md)
- [End-to-end authentication assurance](../docs/features/authentication/END_TO_END_AUTHENTICATION.md)
- [Foundry agents](../docs/features/ai/foundry-agents.md) and [AI chat](../docs/features/ai/ai-chat.md)
- [AI and MCP testing guide](../docs/testing/AI_AND_MCP_TESTING_GUIDE.md) and [AI chat MCP testing](../docs/testing/AI_CHAT_MCP_TESTING.md)
- [Monitoring](../docs/operations/monitoring.md)
