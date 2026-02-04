# AdventureWorks MCP Server (`api-mcp`)

This project hosts the **Model Context Protocol (MCP) server** for the AdventureWorks e‑commerce solution. It exposes a set of tools that the AI agent (running in `api-functions`) can call to query real AdventureWorks data (orders, products, reviews, inventory) and provide grounded answers to users.

The MCP server is implemented as an ASP.NET Core service with SSE transport and is deployed as a Container App alongside the rest of the backend.

---

## Role in the Overall Architecture

- The **frontend** talks to the AI Functions (`api-functions`) via HTTP (e.g., `/api/agent/chat`).
- The **AI agent** inside `api-functions` uses the Microsoft Agent Framework and is configured (via deployment scripts) to use this MCP server as a tools endpoint.
- The **MCP server** (`api-mcp`) connects to:
  - **Azure SQL** (AdventureWorks schema) using a connection string from configuration.
  - **Azure OpenAI** (for embeddings and semantic search) via `AZURE_OPENAI_ENDPOINT`.
  - **Application Insights** for telemetry.

This separation lets you evolve tools and data access in a dedicated service while keeping the agent orchestration logic inside Azure Functions.

---

## Project Structure

- `AdventureWorks/`
  - Main MCP server implementation.
  - Contains:
    - `Program.cs` – configures DI, telemetry, localization, and MCP.
    - `Services/` – data access and AI helpers (orders, products, reviews, OpenAI).
    - `Tools/AdventureWorksMcpTools.cs` – the MCP tools exposed to agents.
    - `Resources/` – localized strings used by services.
- `AppHost/`
  - Hosting shell that wires the AdventureWorks project into an app host (`builder.AddProject<Projects.AdventureWorks>("adventureworks-mcp")`).
- `ServiceDefaults/`
  - Shared service defaults (logging, health probes, configuration helpers) used by the MCP host.

The Container App entrypoint is the AppHost project, which in turn loads the AdventureWorks MCP service.

---

## MCP Server Configuration

Key configuration is in `AdventureWorks/Program.cs`:

- **Telemetry and logging**
  - `builder.Services.AddApplicationInsightsTelemetry();`
  - Console logging wired to stderr for container diagnostics.

- **Localization**
  - `builder.Services.AddLocalization();`
  - Services take localized string resources via `IStringLocalizer`.

- **Database and OpenAI**
  - Connection string from `ConnectionStrings:AdventureWorks` in appsettings (typically using managed identity in Azure).
  - `AZURE_OPENAI_ENDPOINT` environment/config key required for AI operations.

- **MCP server and tools**
  - `builder.Services.AddMcpServer().WithHttpTransport(o => o.Stateless = false).WithTools<AdventureWorksMcpTools>();`
  - HTTP SSE transport is enabled and stateful.
  - MCP endpoint exposed at `/mcp` via `app.MapMcp("/mcp");`.

The Functions project (`api-functions`) uses `MCP_SERVICE_URL` (set by azd) to point to this `/mcp` endpoint.

---

## AdventureWorks MCP Tools

All tools are defined in `AdventureWorks/Tools/AdventureWorksMcpTools.cs` and decorated with `[McpServerTool]`. They return **natural‑language strings** optimized for the chat agent, and they all emit Application Insights telemetry.

### Common Patterns

Each tool:

- Starts an AI telemetry operation (e.g., `MCP_GetCustomerOrders`).
- Calls into one or more services (`OrderService`, `ProductService`, `ReviewService`, `AIService`).
- Supports an optional `cultureId` where noted, for localized responses.
- Tracks success/failure and emits a `MCP_ToolExecuted` event with tool metadata.

### Tool: `GetCustomerOrders`

- **Attribute / ID:** `[McpServerTool]` – name is inferred from method name (`get_customer_orders`).
- **Signature:** `Task<string> GetCustomerOrders(int customerId, string? cultureId = null)`
- **Purpose:**
  - Returns up to 10 of the most recent orders for a given `CustomerID`.
  - Includes status and summary information for each order.
- **Usage:**
  - Ideal for customer order‑history questions ("show my recent orders").

### Tool: `GetOrderDetails`

- **Signature:** `Task<string> GetOrderDetails(int orderId, int? customerId = null, string? cultureId = null)`
- **Purpose:**
  - Returns detailed information for a specific order: items, pricing, shipping status.
  - Optionally validates that the order belongs to a given customer.
- **Usage:**
  - Used when a user asks about a specific order number or when the agent wants to drill into a result from `GetCustomerOrders`.

### Tool: `FindComplementaryProducts`

- **Signature:** `Task<string> FindComplementaryProducts(int productId, int limit = 5, string? cultureId = null)`
- **Purpose:**
  - Finds products that are frequently purchased together with a specified product.
  - Uses order history to compute complementary items.
- **Usage:**
  - Powering product recommendations like "what accessories should I buy with this bike?".

### Tool: `SearchProducts`

- **Signature:** `Task<string> SearchProducts(string searchTerm, string? cultureId = null, int? categoryId = null)`
- **Purpose:**
  - Performs semantic product search combining **embeddings over descriptions and reviews**.
  - Steps:
    1. Uses `AIService.GenerateQueryEmbeddingAsync` to embed the query.
    2. Searches description embeddings (`ProductService.SearchProductsByDescriptionEmbeddingAsync`).
    3. Searches review embeddings (`ReviewService.SearchProductsByReviewEmbeddingAsync`).
    4. Merges and deduplicates results per product, choosing the best (lowest distance) match.
    5. Formats a ranked list of up to 10 products, including:
       - Name, ID, category, price.
       - Whether the match came from description or review.
       - A short snippet of the matched text.
       - A human‑friendly relevance score.
- **Usage:**
  - General product discovery queries ("mountain bikes under $1000", "commuter bike helmets for rain").

### Tool: `GetProductDetails`

- **Signature:** `Task<string> GetProductDetails(int productId)`
- **Purpose:**
  - Returns richly formatted details for a specific product:
    - Name, number, category/subcategory.
    - Price, color, size, weight, and units.
    - Full product description (if present).
- **Usage:**
  - Drill‑down after a search or recommendation; the agent can call this to answer "tell me more about this product".

### Tool: `GetPersonalizedRecommendations`

- **Signature:** `Task<string> GetPersonalizedRecommendations(int customerId, int limit = 5, string? cultureId = null)`
- **Purpose:**
  - Returns personalized product recommendations for a customer based on purchase history and patterns.
- **Usage:**
  - Used by the agent to suggest what a specific customer might like next.

### Tool: `AnalyzeProductReviews`

- **Signature:** `Task<string> AnalyzeProductReviews(int productId, string? cultureId = null)`
- **Purpose:**
  - Summarizes customer review data for a product, including:
    - Average rating and review count.
    - Sentiment / key themes extracted from text.
  - Implemented via `ReviewService.AnalyzeProductReviewsAsync` with localization support.
- **Usage:**
  - Helps the agent answer questions like "what do customers think of this product?".

### Tool: `CheckInventoryAvailability`

- **Signature:** `Task<string> CheckInventoryAvailability(int productId, string? cultureId = null)`
- **Purpose:**
  - Checks real‑time inventory for a finished goods product.
  - Returns stock levels, storage locations, and availability status.
- **Usage:**
  - Enables the agent to respond accurately to "is this bike in stock?"‑style questions.

---

## How the Agent Uses These Tools

Deployment automation (see [docs/AI_AGENT_AUTOMATION.md](../docs/AI_AGENT_AUTOMATION.md)) creates and configures an AI agent in Azure AI that is wired to this MCP server. The agent:

- Connects to the MCP endpoint exposed by the Container App (e.g., `https://<func-app>.azurecontainerapps.io/mcp`).
- Exposes the tools above to the model as **MCP tools** (names like `get_customer_orders`, `search_products`, etc.).
- Uses the tools to fetch grounded data and incorporate it into chat responses.

If you extend `AdventureWorksMcpTools` with additional `[McpServerTool]` methods, they will become new tools available to the agent once redeployed.

---

## Running the MCP Server Locally (Optional)

For most development, you use the **Azure‑hosted** MCP endpoint configured in `MCP_SERVICE_URL` for Functions. If you need to run the MCP server locally for debugging:

1. From within the devcontainer:
   ```bash
   cd /workspaces/AdventureWorks/api-mcp
   dotnet run --project AppHost/AppHost.csproj
   ```
2. The MCP endpoint will be available at an HTTP URL printed in the console (typically `http://localhost:PORT/mcp`).
3. Point the Functions `MCP_SERVICE_URL` in `api-functions/local.settings.json` at that local URL to test end‑to‑end.

In normal workflows you should rely on the Azure‑hosted MCP service created by `azd up`, as described in the root `QUICKSTART.md` and AI Agent docs.

## Related documentation

- Overall architecture and components: [README.md](../README.md)
- Azure deployment and azd hooks: [QUICKSTART.md](../QUICKSTART.md), [scripts/README.md](../scripts/README.md)
- Infrastructure and Container Apps: [infra/README.md](../infra/README.md)
- AI agent configuration and automation: [docs/AGENT_FRAMEWORK_MIGRATION.md](../docs/AGENT_FRAMEWORK_MIGRATION.md), [docs/AI_AGENT_AUTOMATION.md](../docs/AI_AGENT_AUTOMATION.md), [docs/AI_AGENT_DEPLOYMENT_SUMMARY.md](../docs/AI_AGENT_DEPLOYMENT_SUMMARY.md)
- AI agent telemetry and testing: [docs/AI_AGENT_TELEMETRY_IMPLEMENTATION.md](../docs/AI_AGENT_TELEMETRY_IMPLEMENTATION.md), [docs/AI_AND_MCP_TESTING_GUIDE.md](../docs/AI_AND_MCP_TESTING_GUIDE.md), [docs/AI_CHAT_MCP_TESTING.md](../docs/AI_CHAT_MCP_TESTING.md)
- Functions that call this MCP server: [api-functions/README.md](../api-functions/README.md)
