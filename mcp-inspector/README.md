---
title: MCP Inspector gateway (mcp-inspector/) — authenticated MCP test console
summary: Component README for the MCP Inspector Container App, an OAuth gateway in front of the open-source MCP Inspector UI for calling the api-mcp tools and the DAB MCP endpoint; files, tests, configuration and deployment.
audience: [developer, ai-agent]
components: [mcp-inspector, api-mcp, api]
related: [docs/apps/mcp-inspector.md, docs/services/api-mcp.md, docs/features/mcp-oauth/TOOL_SCOPE_MATRIX.md]
---

# MCP Inspector gateway (`mcp-inspector/`)

An internal test console for the two AdventureWorks MCP servers: the custom
**api-mcp** server (63 tools) and the **DAB MCP** endpoint. It wraps the open-source
[`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector) UI
behind a small Node.js OAuth gateway, so employees sign in once and call tools over
MCP Streamable HTTP while the access tokens stay on the server. For the full guide,
see **[docs/apps/mcp-inspector.md](../docs/apps/mcp-inspector.md)**.

**Tech and hosting:** Node.js 22 gateway plus nginx in one container (remote ACR build),
hosted on **Azure Container Apps** with 0–1 replicas (azd service `mcp-inspector`).

## Files

| File | Purpose |
|---|---|
| `gateway.mjs` | OAuth gateway: PKCE sign-in for the MCP and DAB audiences, shell page, `/proxy/mcp` Streamable HTTP proxy |
| `telemetry.mjs` | Application Insights requests and upstream HTTP dependencies (role `mcp-inspector`): valid W3C parent/span links, fixed sanitized URLs, bounded best-effort export; no query strings, headers or bodies |
| `gateway.test.mjs` | `node --test` suite for the gateway |
| `nginx.conf` | Public listener on port 80 that forwards to the loopback gateway |
| `entrypoint.sh` | Starts the gateway, waits for `/health`, then starts nginx |
| `Dockerfile` | `node:22-bookworm-slim` image with nginx |

## Test

```bash
npm --prefix mcp-inspector test     # runs: node --test gateway.test.mjs
```

The gateway needs HTTPS URLs on separate origins and a registered redirect URI, so
exercise it in the deployed environment (open `MCP_INSPECTOR_URL`). To call MCP tools
from a script instead, use `python3 scripts/utilities/azure-auth.py` (see
[authenticated scripts](../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md)).

## Configuration

Telemetry export has a 500-item buffer, one concurrent batch and a two-second send
deadline. Drop/rejection/network diagnostics contain only fixed codes and are limited
to once per minute. Requests never await export. Upstream MCP calls receive a child
`traceparent`; transport success does not prove an MCP tool's logical success.

Required: `API_MCP_URL`, `API_DAB_MCP_URL` and `MCP_PROXY_FULL_ADDRESS` (set by Bicep).
`scripts/hooks/postdeploy.sh` registers the gateway callback on api-mcp. See
[runtime configuration](../docs/apps/mcp-inspector.md#runtime-configuration).

## Deploy

```bash
azd deploy mcp-inspector --no-prompt
```

## Related docs

- [MCP Inspector guide](../docs/apps/mcp-inspector.md)
- [api-mcp service](../docs/services/api-mcp.md)
- [MCP tool scope matrix](../docs/features/mcp-oauth/TOOL_SCOPE_MATRIX.md)
- [DAB API service](../docs/services/dab-api.md)
