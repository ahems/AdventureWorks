# AdventureWorks manufacturing hosted agent

This Foundry hosted agent analyses sales orders using AdventureWorks manufacturing,
inventory, and supply-chain MCP tools. The Functions manufacturing queue trigger invokes
its Responses endpoint and records the final analysis.

## How It Works

Foundry calls the remote MCP server on behalf of the model. Before **each invocation**,
the hosted agent obtains an Entra managed-identity assertion for
`api://AzureADTokenExchange/.default`, exchanges it at the MCP origin's `/token`
endpoint, and supplies the resulting bearer token through `HostedMcpServerTool.Headers`.
The token is never captured at startup or shared on a mutable singleton tool.
Tool allowlists and model instructions use the MCP SDK's case-sensitive
**snake_case wire names** (for example `get_order_details`), not C# method names
(`GetOrderDetails`). PascalCase filtering removes all exposed tools and can
produce a model `tool_failure` even after authentication succeeds.

The grant, client ID, and resource match Functions'
`api-functions/Services/McpServiceTokenProvider.cs`. The hosted implementation lives
inside this service's source directory because Foundry's remote code-build package
does not include sibling projects. Authentication failures abort the invocation;
tokens and response bodies are not logged, and redirects are not followed.

### Identity prerequisite and deployment boundary

The identity actually used by the hosted container must be trusted by api-mcp's
`MCP_TRUSTED_SERVICE_PRINCIPAL_IDS`. The existing Bicep configuration trusts the
shared application identity; Foundry can assign the hosted agent a **different**
instance identity. A successful Functions token exchange does not prove that the
hosted agent can authenticate. Setting `AZURE_CLIENT_ID` alone does not grant a
container access to an unassigned identity.

The root `scripts/hooks/postdeploy.sh` reconciles this trust after normal deployment,
using the same Container App environment-update pattern as OAuth redirect wiring:

1. Read `AGENT_MANUFACTURING_AGENT_RESPONSES_ENDPOINT` published by azd.
2. Read the corresponding Foundry agent's `versions.latest`, verify `definition.kind`
   is `hosted`, and resolve **`instance_identity.principal_id`**. Do not use
   `blueprint.principal_id`, `instance_identity.client_id`, or the project identity.
3. Read the existing api-mcp `MCP_TRUSTED_SERVICE_PRINCIPAL_IDS` and
   `MCP_ENTRA_TENANT_ID`. Require a configured service grant and existing shared
   identity trust; append the hosted principal without discarding any existing IDs.
4. Update only the named trust/redirect environment variables in the same
   `az containerapp update --set-env-vars` call, then wire Functions' agent endpoint.

The read-only resolver is `scripts/utilities/hosted-agent-mcp-trust.py`. It rejects
unexpected endpoints, prompt agents, missing instance identity, or invalid existing
grant configuration rather than silently reporting successful wiring. Repeated
deployments deduplicate IDs; identity rotation adds the current principal but does
not revoke old identities or unrelated explicit trust. Revocation is a separate
administrator policy decision.

**Deployment order:** deploy `manufacturing-agent` from the repository root with
the normal `azd deploy manufacturing-agent --no-prompt` workflow. Its root
postdeploy hook must run after the agent version exists and before an AI smoke
test. Functions can be deployed independently; do not invoke manufacturing AI
until the hosted code and root trust hook have both completed. A normal full
deployment/provisioning cycle also re-applies trust if Bicep reset the setting to
the shared identity alone. No agent/user recreation or manual Azure remediation
is needed for this allowlist wiring.

The deployment operator needs Foundry agent metadata read access, Container App
read/update access, and Python 3. The **hosted container**, not the deployer or
Functions, owns the short-lived managed-identity assertion. Its
`DefaultAzureCredential` must actually expose the published instance identity and
be able to request the token-exchange audience. The allowlist hook does not
assign identities, grant Azure roles, or prove token acquisition; any such failure
remains an explicit invocation/deployment blocker, not an anonymous fallback.

No hosted `environmentVariables` grant configuration is missing: the caller uses
`MCP_SERVICE_URL`, and the assertion audience/grant/client ID are protocol constants.
`MCP_ENTRA_TENANT_ID` and `MCP_TRUSTED_SERVICE_PRINCIPAL_IDS` belong to **api-mcp**,
not the hosted agent; existing Bicep supplies the tenant/shared trust and the root
hook adds the deployed instance principal. Do not work around auth errors with a
stored token, anonymous MCP access, or a startup-time token.

The Functions response-validation fix can be deployed independently of this agent.
HTTP 200 is not sufficient: the Responses envelope must be completed, error-free,
and contain final assistant findings. Failed, incomplete, empty, malformed, and
embedded error envelopes follow the existing retry/failure path instead of being
stored as completed findings. Genuine prose findings remain supported; structured
findings must include a nonempty `findingsSummary`.

Offline regression tests (no AI calls or Azure mutations):

```bash
dotnet test api-functions.Tests/api-functions.Tests.csproj --filter 'FullyQualifiedName~ManufacturingAgentResponseTests|FullyQualifiedName~ManufacturingMcpAuthenticationTests'
dotnet build manufacturing-agent/mcp-tools/src/mcp-tools/mcp-tools.csproj
python3 -m unittest discover -s tests/scripts -p test_hosted_agent_mcp_trust.py
python3 -m unittest discover -s tests/scripts -p test_manufacturing_agent_tools.py
bash -n scripts/hooks/postdeploy.sh
```

See [Program.cs](src/mcp-tools/Program.cs) for the full implementation.

## Prerequisites

1. An existing Foundry project with a deployed model (or create them during setup in Option 1 — `azd provision` can create them for you).
2. **[.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)** or later.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FOUNDRY_PROJECT_ENDPOINT` | Yes | Foundry project endpoint. Auto-injected in hosted containers; set automatically by `azd ai agent run` locally. |
| `AZURE_AI_MODEL_DEPLOYMENT_NAME` | Yes | Model deployment name — must match your Foundry project deployment. Declared in `azure.yaml`. |
| `MCP_SERVICE_URL` | Yes | HTTPS AdventureWorks MCP endpoint, ending in `/mcp`. Its origin hosts the managed-identity token exchange. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Recommended | Enables telemetry. Auto-injected in hosted containers; set manually for local dev. |

When using `azd ai agent run`, these are handled automatically. For manual runs, set them in your shell — .NET does not read `.env` files natively.

## Option 1: Azure Developer CLI (`azd`)

### Prerequisites

1. **Azure Developer CLI (`azd`)** — [Install azd](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/install-azd)
2. Install the Foundry extension:

   ```bash
   azd ext install microsoft.foundry
   ```

3. Authenticate:

   ```bash
   azd auth login
   ```

### Initialize the agent project

No cloning required. Create a new folder and initialize from the manifest:

```bash
mkdir mcp-tools-agent && cd mcp-tools-agent
azd ai agent init -m https://github.com/microsoft-foundry/foundry-samples/blob/main/samples/csharp/hosted-agents/agent-framework/mcp-tools/azure.yaml
```

Follow the prompts to configure your Foundry project and model deployment. If you don't have an existing Foundry project, `azd ai agent init` will guide you through creating one.

> If you already have a Foundry project and model deployment, add `-p <project-id> -d <deployment-name>` to `azd ai agent init` to target existing resources.

### Provision Azure resources (if needed)

If you don't already have a Foundry project and model deployment:

```bash
azd provision
```

### Run the agent locally

```bash
azd ai agent run
```

The agent host will start on `http://localhost:8088`.

### Invoke the local agent

In a separate terminal, invoke the running agent:

```bash
azd ai agent invoke --local "Search Microsoft Learn for how to use dependency injection in ASP.NET Core"
```

Or use curl directly:

```bash
# Triggers client-side MCP tools (docs search, code samples, docs fetch)
curl -sS -X POST http://localhost:8088/responses \
  -H "Content-Type: application/json" \
  -d '{"input": "Search Microsoft Learn for how to use dependency injection in ASP.NET Core", "stream": false}' | jq .

# Triggers code sample search (client-side only)
curl -sS -X POST http://localhost:8088/responses \
  -H "Content-Type: application/json" \
  -d '{"input": "Find a C# code sample for creating an Azure Blob Storage container", "stream": false}' | jq .
```

### Deploy to Foundry

Once tested locally, deploy to Microsoft Foundry:

```bash
azd deploy
```

For the full deployment guide, see [Deploy a hosted agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/deploy-hosted-agent).

### Invoke the deployed agent

```bash
azd ai agent invoke "Search Microsoft Learn for how to use dependency injection in ASP.NET Core"
```

Stream logs from the running agent with `azd ai agent monitor`.

## Option 2: VS Code (Foundry Toolkit)

### Prerequisites

1. **VS Code** with the **[Foundry Toolkit](https://marketplace.visualstudio.com/items?itemName=ms-windows-ai-studio.windows-ai-studio)** extension installed.
2. [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) extension.
3. Command Palette (`Ctrl+Shift+P`) → **C#: Check Workspace Requirements** to confirm the toolchain is ready.

### Run and debug the agent

Press **F5** to start the agent. The agent starts and the **Agent Inspector** opens automatically. Chat with the agent in the Inspector.

### Or run manually, then open the Inspector

1. Restore dependencies:

   ```bash
   dotnet restore
   ```

2. Configure the agent: create a `.env` file with the [required variables](#environment-variables). The sample loads `.env` automatically on startup.

3. Sign in to Azure with the Azure CLI so `DefaultAzureCredential` can authenticate the terminal process (the **F5** path reuses the Azure sign-in from the Foundry Toolkit, so it doesn't need a separate `az login`):

   ```bash
   az login
   ```

4. Start the agent (listens on `http://localhost:8088`):

   ```bash
   dotnet run
   ```

5. Open the Command Palette (`Ctrl+Shift+P`) → **Foundry Toolkit: Open Agent Inspector**, then send a message to test.

### Deploy to Foundry

1. Open the Command Palette (`Ctrl+Shift+P`) and run **Foundry Toolkit: Deploy Hosted Agent**. The extension opens a **Deploy Hosted Agent** wizard and reads `agent.yaml` to auto-populate settings.
2. If prompted, complete **Foundry Project Setup** to select subscription and project.
3. On the **Basics** tab, choose deployment method (**Code** or **Container**) and confirm the agent name.
4. On **Review + Deploy**, confirm runtime details, pick **CPU and Memory** size, and click **Deploy**.
5. After deployment, invoke the agent in the Agent Playground and stream live logs from the **Logs** tab.

## Troubleshooting

### Images built on Apple Silicon or other ARM64 machines do not work on our service

**Deploy with `azd deploy`**, which uses ACR remote build and always produces images with the correct architecture.

If you choose to **build locally**, and your machine is **not `linux/amd64`** (for example, an Apple Silicon Mac), the image will **not be compatible with our service**, causing runtime failures.

**Fix for local builds:**

```bash
docker build --platform=linux/amd64 -t image .
```

This forces the image to be built for the required `amd64` architecture.
