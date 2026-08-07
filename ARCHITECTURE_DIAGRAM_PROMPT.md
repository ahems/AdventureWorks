# Prompt: Generate Azure Architecture Diagram for AdventureWorks E-Commerce Platform

## Objective

Create a detailed Azure architecture diagram for the **AdventureWorks E-Commerce & Manufacturing Platform**, modeled after the **[Baseline Microsoft Foundry Chat Reference Architecture](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/architecture/baseline-openai-e2e-chat)** on Microsoft Learn. This diagram represents the **ideal production state** of the solution — as if it were a real enterprise deployment with full security, networking, and reliability best practices — not the current demo deployment.

Use the same visual style, layout conventions, and iconography as the reference architecture diagram (available as a [Visio download](https://arch-center.azureedge.net/baseline-microsoft-foundry.vsdx) or [SVG](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/architecture/_images/baseline-microsoft-foundry.svg)).

---

## Key Differences from the Reference Architecture

The reference architecture uses **Azure App Service** to host a single chat UI. This solution replaces that with:

- **Azure Static Web App** for the customer-facing eShop (React SPA)
- **Azure Container Apps** for all backend services and two additional frontends (Admin, Manufacturing)
- **Azure Functions (Flex Consumption)** for serverless business logic
- **Azure SQL Database** as the primary application data store (instead of only Cosmos DB)
- **Azure Web PubSub** for real-time push notifications to all frontends
- **Azure Communication Services** for transactional email
- **Azure Container Registry** for container image builds
- **Azure Container App Job** for database seeding

The Foundry Agent Service components (Cosmos DB, AI Search, Storage for agent state) should be shown **separately** from the application's own Storage and SQL resources, following the reference architecture's isolation guidance.

---

## Virtual Network Layout

Draw a single **Azure Virtual Network** containing the following **subnets** (mirroring the reference architecture's segmentation pattern):

### 1. Application Gateway Subnet (`snet-appGateway`)

- **Azure Application Gateway** with **Azure WAF (Web Application Firewall)**
- This is the **only internet-facing ingress point** for all user traffic
- Receives HTTPS traffic from users and routes to backend services
- Protected by **Azure DDoS Protection** (shown on the public IP)

### 2. Private Endpoint Subnet (`snet-privateEndpoints`)

- Contains **private endpoints** for all PaaS services:
  - Azure SQL Database private endpoint
  - Azure Storage private endpoint (application storage)
  - Azure Key Vault private endpoint
  - Azure Container Registry private endpoint
  - Azure Web PubSub private endpoint
  - Azure Communication Services private endpoint
  - Microsoft Foundry private endpoint

### 3. Container Apps Integration Subnet (`snet-containerApps`)

- **Container App Environment** hosting:
  - **`av-app-admin`** — Admin Dashboard (React + Vite container)
  - **`av-app-manufacturing`** — Manufacturing Dashboard (React + Vite container)
  - **`av-api`** — Data API Builder (DAB) providing GraphQL + REST over Azure SQL
  - **`av-mcp`** — MCP Server (.NET Aspire, connects to Foundry + SQL)
  - **`av-mcp-inspector`** — MCP Inspector (nginx-based debugging tool)
  - **`av-seed-job`** — Container App Job for database seeding (PowerShell + sqlcmd)
- All containers use the **User-Assigned Managed Identity** for auth
- Virtual network integration for outbound traffic

### 4. Azure Functions Integration Subnet (`snet-functions`)

- **`av-func`** — Azure Functions (Flex Consumption, .NET 10 isolated worker)
  - Order processing, shopping simulator, manufacturing simulation
  - Bank simulator, inventory management, address lookup
  - AI agent orchestration (chat, promotions, reviews, catalog)
  - Email notifications via Communication Services
  - Real-time push via Web PubSub
- Virtual network integration for outbound private connectivity

### 5. Static Web App (External to VNet but linked via private endpoint)

- **`av-app`** — Azure Static Web App (customer-facing eShop)
  - React + TypeScript + Vite SPA
  - Deployed via SWA CLI
  - Routes API calls through Application Gateway to backend Container Apps and Functions

### 6. Azure AI Agent Integration Subnet (`snet-agentsEgress`)

- Delegated to `Microsoft.App/environments` for **Foundry Agent Service**
- Single-tenant data proxy for agent egress
- Virtual interface for outbound agent calls to:
  - Foundry Agent Service dependencies (via private endpoints)
  - External tools/MCP servers (via Azure Firewall)

### 7. Azure Firewall Subnet (`AzureFirewallSubnet`)

- **Azure Firewall** — inspects and controls all outbound (egress) traffic
- FQDN-based rules for approved destinations
- All Container Apps, Functions, and agent subnet traffic routed here via UDR

### 8. Azure Bastion Subnet (`AzureBastionSubnet`)

- **Azure Bastion** — secure RDP/SSH access to jump boxes
- For developer/operator access to private resources and Foundry portal

### 9. Jump Box Subnet (`snet-jumpBoxes`)

- **Jump box VM** — for accessing Foundry portal and private resources
- Connected through Azure Bastion

### 10. Build Agents Subnet (`snet-buildAgents`)

- **Build agent VMs** — for CI/CD pipelines with private network access
- Used for `azd deploy` and ACR remote builds within the VNet

---

## Azure Services — Outside the Virtual Network (PaaS with Private Endpoints)

Show these services **outside** the VNet boundary but connected **into** it via private endpoints (dashed lines to their respective private endpoints in `snet-privateEndpoints`):

### Application Data Services

| Service                          | Name Pattern       | Purpose                                                                                                                                                                                                                           |
| -------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Azure SQL Database**           | `av-sql-{token}`   | AdventureWorks schema — Production, Sales, Person tables. Entra ID auth with Managed Identity.                                                                                                                                    |
| **Azure Storage Account**        | `avstorage{token}` | Application queues (`simulation-order-queue`, `order-pipeline-queue`, etc.), tables (`shoppingSimulator`, `bankSimulator`), and blob containers.                                                                                  |
| **Azure Web PubSub**             | `av-wps-{token}`   | Real-time push notifications to all three frontends. Groups: `manufacturing-agent`, `manufacturing-ops`, `warehouse`, `supply-chain`, `orders`, `shopping-simulator`, `reviews`. Free tier in demo; Standard tier for production. |
| **Azure Communication Services** | `av-comms-{token}` | Transactional email for order notifications (shipped, delivered). Email Service with managed domain.                                                                                                                              |
| **Azure Key Vault**              | `av-kv-{token}`    | TLS certificates for Application Gateway, connection secrets, encryption keys.                                                                                                                                                    |
| **Azure Container Registry**     | `avacr{token}`     | Container image builds and storage for all Container Apps. ACR Tasks for remote builds.                                                                                                                                           |

### Microsoft Foundry (Right Side of Diagram)

Show the **Microsoft Foundry** block on the right side, matching the reference architecture layout:

| Component                                              | Purpose                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Microsoft Foundry Resource**                         | Top-level AI resource boundary                                                                                                 |
| **Foundry Agent Service**                              | Hosts AI agents — chat, promotions, reviews, catalog suggestions, email content, translation, help-me-choose, order processing |
| **Microsoft Foundry Project** (`av-aiproject-{token}`) | Project scope for agents, connections, and deployments                                                                         |
| **Azure OpenAI Models**                                | Chat model (GPT), Embedding model, Image generation model (gpt-image-2) — shown as deployments within the Foundry resource     |
| **Managed Identities**                                 | User-assigned identity for all service-to-service auth                                                                         |

### Foundry Agent Service Dependencies (Isolated Resources)

These are **dedicated** resources managed by Foundry Agent Service for agent state — shown separately from application data resources:

| Service                               | Purpose                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Azure Cosmos DB** (Foundry-managed) | Agent conversation history, agent definitions, operational state (`enterprise_memory` database) |
| **Azure AI Search** (Foundry-managed) | Searchable index for file search tool, knowledge sources for agents                             |
| **Azure Storage** (Foundry-managed)   | File uploads during chat sessions, agent file storage                                           |

Each of these has its own **private endpoint** in `snet-privateEndpoints` and is connected via dashed lines.

---

## Monitoring & Identity (Bottom-Left of Diagram)

### Monitoring

| Service                                              | Purpose                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Application Insights** (`av-appinsights-{token}`)  | APM for all services — Container Apps, Functions, DAB, MCP server. Token usage tracking for AI models. |
| **Azure Monitor**                                    | Metrics, alerts, and diagnostics for all resources                                                     |
| **Log Analytics Workspace** (`av-workspace-{token}`) | Central log aggregation — all services send diagnostics here                                           |

### Identity & Auth

| Service                                                    | Purpose                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Microsoft Entra ID**                                     | User authentication for eShop, admin, and manufacturing apps. App registrations for OAuth2/OIDC.                                                                                                                                                                    |
| **User-Assigned Managed Identity** (`av-identity-{token}`) | Single identity used by all Container Apps, Functions, and Foundry for passwordless service-to-service auth. RBAC roles: SQL db_datareader/db_datawriter, Storage Blob/Queue/Table Contributor, ACR Pull, Web PubSub Service Owner, Cognitive Services OpenAI User. |

---

## Private DNS Zones (Left Side of Diagram)

Show **Private DNS Zones** linked to the Virtual Network for name resolution of private endpoints:

- `privatelink.database.windows.net` (Azure SQL)
- `privatelink.blob.core.windows.net` (Storage)
- `privatelink.queue.core.windows.net` (Storage Queues)
- `privatelink.table.core.windows.net` (Storage Tables)
- `privatelink.vaultcore.azure.net` (Key Vault)
- `privatelink.azurecr.io` (Container Registry)
- `privatelink.webpubsub.azure.com` (Web PubSub)
- `privatelink.services.ai.azure.com` (Foundry)
- `privatelink.openai.azure.com` (Foundry OpenAI)
- `privatelink.cognitiveservices.azure.com` (Foundry Cognitive Services)
- `privatelink.documents.azure.com` (Cosmos DB)
- `privatelink.search.windows.net` (AI Search)
- `privatelink.communication.azure.com` (Communication Services)

---

## Data Flow Annotations (Numbered Workflow)

Add numbered workflow annotations matching the reference architecture style:

1. **User → Application Gateway**: Users access the eShop (Static Web App) or Admin/Manufacturing dashboards. All HTTPS traffic enters through Application Gateway with WAF inspection. Application Gateway routes requests to the appropriate backend: Static Web App for eShop, Container Apps for Admin and Manufacturing dashboards.

2. **Frontend → Backend APIs**: The frontend apps call the DAB GraphQL API (`av-api`) for data queries and Azure Functions (`av-func`) for business logic (orders, inventory, manufacturing, AI agents). All traffic flows through private endpoints within the VNet.

3. **Azure Functions → Foundry Agent Service**: When AI capabilities are needed (chat, order processing, product recommendations, review analysis), Functions call the MCP Server (`av-mcp`), which connects to Foundry Agent Service via private endpoint. The agent processes requests using its configured model and tools.

4. **Foundry Agent Service → AI Models**: The agent connects to its configured Azure OpenAI model deployment (chat completion, embeddings, image generation) within the Foundry resource. All inference calls stay within the Foundry boundary.

5. **Foundry Agent Service → Dependencies**: The agent persists conversation history to Cosmos DB, stores uploaded files in Storage, and indexes knowledge in AI Search — all via private endpoints through the agent integration subnet.

6. **Azure Functions → Application Data**: Functions read/write to Azure SQL (orders, products, manufacturing data) and Azure Storage (queues for async processing, tables for simulator state). All connections use Managed Identity with `Authentication=Active Directory Default`.

7. **Real-Time Push**: After mutations (order placed, work order completed, inventory updated), Functions push events via Azure Web PubSub to all connected frontends. Clients receive WebSocket messages and invalidate their React Query caches for instant UI updates.

8. **Email Notifications**: For order status changes (shipped, delivered), Functions send transactional emails via Azure Communication Services.

---

## Visual Style Requirements

- Use **official Azure architecture icons** (the same icon set used in the reference architecture)
- Follow the **same layout pattern**: VNet as a large blue boundary box, subnets as labeled sections within, PaaS services outside with private endpoint connections shown as dashed lines
- **Microsoft Foundry** block on the right side with its internal components stacked vertically
- **Monitoring** (Application Insights, Azure Monitor) in the bottom-left
- **Identity** (Entra ID, Managed Identity) in the bottom-left near monitoring
- **Private DNS Zones** on the left side, linked to the VNet
- **DDoS Protection** shown on the Application Gateway's public IP
- Use the **numbered circle annotations** (①②③④⑤⑥⑦⑧) for the workflow steps
- Container Apps should be shown with **individual named instances** inside the Container App Environment box, similar to how App Service shows multiple instances across zones in the reference architecture
- The Static Web App should be shown **separately** from the Container Apps environment since it's a distinct hosting platform

---

## Additional Notes

- This is an **ideal production state** diagram. The current demo deployment does NOT use private endpoints, VNet integration, Application Gateway, Firewall, Bastion, or Key Vault. The diagram should show what the architecture **would** look like with full enterprise security.
- The **Playwright Testing** workspace (`pw{token}`) used for E2E testing is NOT a production runtime component and should be **omitted** from the diagram.
- The **MCP Inspector** (`av-mcp-inspector`) is a development/debugging tool. Include it in the Container Apps environment but mark it as optional/dev-only if the diagram format supports it.
- All services authenticate via **Managed Identity** — no connection strings with secrets. Show this with identity arrows or annotations.
- The Azure Functions use **Flex Consumption** plan (serverless, Linux), not the traditional Consumption plan.
- The DAB (Data API Builder) container provides both **GraphQL and REST** endpoints and also exposes an **MCP endpoint** (`/mcp`) for AI tool integration.
