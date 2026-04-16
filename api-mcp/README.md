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
    - `Services/` – data access and AI helpers (orders, products, reviews, manufacturing, supply chain, OpenAI).
    - `Tools/AdventureWorksMcpTools.cs` – e-commerce tools (orders, products, reviews, inventory).
    - `Tools/ManufacturingMcpTools.cs` – manufacturing simulation tools (production runs, scrap, feasibility, cost analysis).
    - `Tools/SupplyChainMcpTools.cs` – supply chain tools (vendors, catalog, quotes, purchase orders).
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
  - ```csharp
    builder.Services.AddMcpServer()
        .WithHttpTransport(o => o.Stateless = false)
        .WithTools<AdventureWorksMcpTools>()
        .WithTools<ManufacturingMcpTools>()
        .WithTools<SupplyChainMcpTools>();
    ```
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

## Manufacturing MCP Tools

All tools are defined in `AdventureWorks/Tools/ManufacturingMcpTools.cs`. They expose the manufacturing simulation engine — allowing an agent to monitor the shop floor, start production runs, inspect quality, configure capacity, and plan procurement.

### Simulation Control

#### Tool: `GetManufacturingStatus`

- **Signature:** `Task<string> GetManufacturingStatus()`
- **Purpose:** Returns the live status of the manufacturing simulation: running state, queue depth, work-order counts (pending / in-progress / completed today), material shortages, recent scrap events, and load per production location.

#### Tool: `GetActiveManufacturingOperations`

- **Signature:** `Task<string> GetActiveManufacturingOperations()`
- **Purpose:** Lists all routing operations currently in progress on the shop floor, including elapsed time, product name, location, and operation sequence number.

#### Tool: `BeginManufacturingRun`

- **Signature:** `Task<string> BeginManufacturingRun(int productId, int orderQty, string? dueDate = null)`
- **Purpose:** Starts a new production run for a finished good. Explodes the bill of materials recursively, creates work orders for all components, and queues routing operations. `productId` must reference a product with `MakeFlag = true`.
- **Usage:** Call `GetProductionFeasibility` first to verify sufficient component stock before starting a run.

#### Tool: `StopManufacturing`

- **Signature:** `Task<string> StopManufacturing()`
- **Purpose:** Clears the production queue. In-flight operations finish but no new ones start. Use to pause the simulation before reconfiguring scrap rates or location capacity.

### Workforce

#### Tool: `GetManufacturingWorkforce`

- **Signature:** `Task<string> GetManufacturingWorkforce()`
- **Purpose:** Returns a headcount summary of the manufacturing workforce grouped by production location and shift, showing total and currently active workers.

### Quality / Scrap

#### Tool: `GetManufacturingScrapEvents`

- **Signature:** `Task<string> GetManufacturingScrapEvents(int? vendorId = null)`
- **Purpose:** Retrieves scrap events recorded during manufacturing. Optionally filter by `vendorId` to investigate scrap attributable to components from a specific supplier. Shows product name, location, scrapped quantity, and scrap reason.

#### Tool: `GetVendorQualityReport`

- **Signature:** `Task<string> GetVendorQualityReport(int? vendorId = null)`
- **Purpose:** Returns an aggregated quality report per supplier showing total components supplied, scrap events, total scrapped quantity, and scrap rate. Optionally scope to a single vendor.

### Scrap & Location Configuration

#### Tool: `GetScrapConfiguration`

- **Signature:** `Task<string> GetScrapConfiguration()`
- **Purpose:** Returns the current per-location scrap failure rates and applicable scrap reason codes.

#### Tool: `UpdateScrapConfiguration`

- **Signature:** `Task<string> UpdateScrapConfiguration(int locationId, double failureRatePct, string? scrapReasonIds = null, string? note = null)`
- **Purpose:** Updates the scrap failure rate for a production location. `failureRatePct` must be `0.0`–`1.0`. Optionally supply a comma-separated list of `ScrapReasonID`s to restrict which reasons apply.

#### Tool: `GetLocationConfiguration`

- **Signature:** `Task<string> GetLocationConfiguration()`
- **Purpose:** Returns the capacity and shift configuration for all production locations: capacity units, daily operating hours, speed factor, and shift start hour.

#### Tool: `UpdateLocationConfiguration`

- **Signature:** `Task<string> UpdateLocationConfiguration(int locationId, int capacityUnits, double dailyOperatingHours = 8.0, double speedFactor = 1.0, int shiftStartHour = 6, string? note = null)`
- **Purpose:** Updates the capacity and shift settings for a specific production location. Use to simulate overtime, shift changes, or capacity expansions. `speedFactor > 1.0` means faster than normal.

### Planning & Analysis

#### Tool: `GetProductionFeasibility`

- **Signature:** `Task<string> GetProductionFeasibility(int productId, int qty = 1, bool withProcurement = true)`
- **Purpose:** Checks whether a finished good can be manufactured given current component stock. Returns the maximum producible quantity and any bottleneck components. Set `withProcurement = true` (default) to include pending supply orders.

#### Tool: `GetAllProductsFeasibility`

- **Signature:** `Task<string> GetAllProductsFeasibility(int qty = 1)`
- **Purpose:** Returns a feasibility snapshot for **all** manufactured finished goods: maximum producible quantity, inventory signal (overstock / low-stock / out-of-stock / healthy), pricing signal, and weeks of supply. Useful for prioritising the next production run.

#### Tool: `GetProductCostAnalysis`

- **Signature:** `Task<string> GetProductCostAnalysis(int productId, bool useCurrent = false)`
- **Purpose:** Full BOM cost breakdown including routing labour costs and gross margin vs list price. Set `useCurrent = true` to use actual costs from supply-chain purchase history instead of standard costs.

#### Tool: `GetManufacturingCatalogSnapshot`

- **Signature:** `Task<string> GetManufacturingCatalogSnapshot(string? inventorySignal = null, string? pricingSignal = null)`
- **Purpose:** Full catalog snapshot of all manufactured finished goods with stock levels, sales velocity, weeks of supply, and derived signals. Optional filters: `inventorySignal` (`overstock`, `low-stock`, `out-of-stock`, `healthy`) and `pricingSignal` (`thin-margin`, `loss-making`, `healthy`).

#### Tool: `GetOverstockItems`

- **Signature:** `Task<string> GetOverstockItems(double minWeeks = 12.0)`
- **Purpose:** Finds finished goods with excess inventory relative to recent sales velocity (candidates for promotions or discounts). Default threshold is 12 weeks of supply.

#### Tool: `GetThinMarginProducts`

- **Signature:** `Task<string> GetThinMarginProducts(double maxMarginPct = 0.20)`
- **Purpose:** Finds finished goods whose gross margin is below `maxMarginPct` — candidates for a list price increase.

#### Tool: `GetComponentShortageForecast`

- **Signature:** `Task<string> GetComponentShortageForecast(int days = 90)`
- **Purpose:** Forecasts which purchased components will run out of stock within the next `days` days based on current manufacturing activity and sales velocity. Results are sorted by urgency (critical / warning / watch).

#### Tool: `GetReorderRecommendations`

- **Signature:** `Task<string> GetReorderRecommendations(int days = 60)`
- **Purpose:** Returns reorder recommendations for components forecast to run short within `days` days. Includes suggested order quantities, the best (cheapest fulfilling) vendor option, and alternative vendor pricing. Use to drive supply-chain purchasing decisions.

---

## Supply Chain MCP Tools

All tools are defined in `AdventureWorks/Tools/SupplyChainMcpTools.cs`. They expose the supply-chain procurement simulation — allowing an agent to browse vendors, request quotes, place and track purchase orders, and manage vendor stock.

### Vendors

#### Tool: `GetSupplyChainVendors`

- **Signature:** `Task<string> GetSupplyChainVendors()`
- **Purpose:** Lists all active supply-chain vendors with credit rating, preferred status, number of unique products supplied, and total stock available. Use this to understand the supplier base before placing orders.

#### Tool: `GetVendorDetails`

- **Signature:** `Task<string> GetVendorDetails(string vendorId)`
- **Purpose:** Returns detailed information about a specific vendor including their full component catalog with current stock levels, unit prices, lead times, and minimum order quantities.

### Catalog

#### Tool: `GetSupplyCatalog`

- **Signature:** `Task<string> GetSupplyCatalog(int? productId = null)`
- **Purpose:** Returns the full vendor catalog showing all orderable components with vendor names, stock levels, unit prices, and lead times. Optionally filter to offerings for a single component by passing `productId`.

### Quotes

#### Tool: `GetSupplyQuote`

- **Signature:** `Task<string> GetSupplyQuote(string vendorId, int productId, int qty = 1)`
- **Purpose:** Gets a real-time quote from a specific vendor: unit price, any quantity discount, total cost, available stock, and lead time. Call this before placing an order to confirm pricing and availability.

### Orders

#### Tool: `PlaceSupplyOrder`

- **Signature:** `Task<string> PlaceSupplyOrder(string vendorId, int productId, int qty)`
- **Purpose:** Places a purchase order with a vendor. The vendor must have sufficient stock. Orders flow through the simulation pipeline: `pending → approved → picking → shipped → delivered`, with inventory updated on delivery.

#### Tool: `GetActiveSupplyOrders`

- **Signature:** `Task<string> GetActiveSupplyOrders()`
- **Purpose:** Lists all currently active (non-completed) purchase orders showing order ID, vendor, product, quantity, cost, status, and expected delivery date.

#### Tool: `GetSupplyOrderHistory`

- **Signature:** `Task<string> GetSupplyOrderHistory()`
- **Purpose:** Returns the full historical log of all purchase orders including delivered and cancelled orders. Useful for analysing purchasing patterns, vendor performance, and total procurement spend.

#### Tool: `GetSupplyOrderDetails`

- **Signature:** `Task<string> GetSupplyOrderDetails(string orderId)`
- **Purpose:** Returns the current status and full details of a specific purchase order including the status-history trail showing each stage transition.

#### Tool: `CancelSupplyOrder`

- **Signature:** `Task<string> CancelSupplyOrder(string orderId, string reason = "Cancelled by agent")`
- **Purpose:** Cancels a pending purchase order. Only orders in `pending` status can be cancelled; the vendor's stock is returned on cancellation.

### Restock & Maintenance

#### Tool: `RestockVendorInventory`

- **Signature:** `Task<string> RestockVendorInventory(string vendorId, int? productId = null)`
- **Purpose:** Triggers an immediate restock of a vendor's simulated inventory. Useful when testing or when vendor stock has been depleted through orders. Optionally restrict to a single product.

#### Tool: `ResetSupplyChainSimulation`

- **Signature:** `Task<string> ResetSupplyChainSimulation()`
- **Purpose:** Resets the entire supply-chain simulation: clears all purchase orders, cancels in-flight transitions, and re-seeds vendor stock to initial levels. Use this to start a clean simulation scenario.

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

---

## Testing with MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is a visual testing tool for MCP servers that provides both a web UI and CLI mode for testing tools, resources, and prompts.

### UI Mode (Interactive Testing)

Launch the MCP Inspector web interface:

```bash
npx @modelcontextprotocol/inspector
```

The Inspector will:

1. Start a local proxy server (default port 6277)
2. Open the web UI in your browser (default port 6274)
3. Show you the session token for authentication

**Note:** The Inspector automatically generates a session token and opens your browser with it pre-filled. Look for the `🔗 Open inspector with token pre-filled` message in the console output.

Once the UI opens, configure the connection to your Azure MCP service:

1. In the sidebar, select **"Streamable HTTP"** as the transport type
2. Enter your MCP service URL:
   ```bash
   # Get the URL from azd
   azd env get-values | grep MCP_SERVICE_URL
   ```
3. Copy the URL value (without quotes) and paste it into the "Server URL" field
4. Click **"Connect"**

**Important:** Do not pass the URL as a command-line argument for UI mode - it will try to spawn it as a STDIO process. Only use `--cli` mode with URLs as positional arguments.

In the web UI, you can:

- Browse all available MCP tools (`GetCustomerOrders`, `SearchProducts`, etc.)
- Test tools with different parameters
- View formatted responses
- See request/response history
- Export server configurations for use in other MCP clients

### CLI Mode (Scripting and Automation)

Use CLI mode for quick testing, CI/CD integration, or working with coding assistants.

First, export the MCP service URL:

```bash
export MCP_SERVICE_URL=$(azd env get-values | grep MCP_SERVICE_URL | cut -d'=' -f2 | tr -d '"')
```

Then use the CLI commands. For remote HTTP servers, pass the URL as a positional argument and specify `--transport http`:

```bash
# List all available tools
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http --method tools/list

# Search for products (semantic search)
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name search_products \
  --tool-arg searchTerm="mountain bikes"

# Get customer orders
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_customer_orders \
  --tool-arg customerId=29825

# Get order details with localization
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_order_details \
  --tool-arg orderId=43659 \
  --tool-arg cultureId="fr-FR"

# Check product inventory
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name check_inventory_availability \
  --tool-arg productId=771

# Analyze product reviews
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name analyze_product_reviews \
  --tool-arg productId=771

# Get product details
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_product_details \
  --tool-arg productId=771

# ── Manufacturing ──────────────────────────────────────────────────────────────

# Get manufacturing simulation status
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_manufacturing_status

# List active shop-floor operations
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_active_manufacturing_operations

# Start a production run (productId 749 = Mountain-100 Silver, 38)
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name begin_manufacturing_run \
  --tool-arg productId=749 \
  --tool-arg orderQty=2

# Check feasibility before starting a run
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_production_feasibility \
  --tool-arg productId=749 \
  --tool-arg qty=5

# Forecast component shortages over the next 90 days
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_component_shortage_forecast \
  --tool-arg days=90

# Get reorder recommendations
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_reorder_recommendations \
  --tool-arg days=60

# Get vendor quality / scrap report
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_vendor_quality_report

# ── Supply Chain ───────────────────────────────────────────────────────────────

# List all vendors
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_supply_chain_vendors

# Get catalog for a specific component
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_supply_catalog \
  --tool-arg productId=316

# Request a quote before ordering
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_supply_quote \
  --tool-arg vendorId=1498 \
  --tool-arg productId=316 \
  --tool-arg qty=50

# Place a purchase order
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name place_supply_order \
  --tool-arg vendorId=1498 \
  --tool-arg productId=316 \
  --tool-arg qty=50

# Check active orders
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --method tools/call \
  --tool-name get_active_supply_orders
```

**Note:** In CLI mode, the URL is passed as a positional argument along with `--transport http` to specify the Streamable HTTP transport.

### Testing with Authentication Headers

If your MCP service requires authentication, add custom headers (export `MCP_SERVICE_URL` first if not already done):

```bash
export MCP_SERVICE_URL=$(azd env get-values | grep MCP_SERVICE_URL | cut -d'=' -f2 | tr -d '"')
npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http \
  --header "Authorization: Bearer your-token-here" \
  --method tools/list
```

### Tips for Efficient Testing

1. **Use shell aliases** for frequently used commands (after exporting `MCP_SERVICE_URL`):

   ```bash
   # First export the URL
   export MCP_SERVICE_URL=$(azd env get-values | grep MCP_SERVICE_URL | cut -d'=' -f2 | tr -d '"')

   # Then add aliases to your .bashrc or .zshrc
   alias mcp-list='npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http --method tools/list'
   alias mcp-call='npx @modelcontextprotocol/inspector --cli "$MCP_SERVICE_URL" --transport http --method tools/call'

   # Then use them:
   mcp-list
   mcp-call --tool-name search_products --tool-arg searchTerm="helmets"
   ```

2. **Check tool names** first – MCP converts method names to snake_case:
   - `GetCustomerOrders` → `get_customer_orders`
   - `SearchProducts` → `search_products`
   - `CheckInventoryAvailability` → `check_inventory_availability`
   - `GetManufacturingStatus` → `get_manufacturing_status`
   - `BeginManufacturingRun` → `begin_manufacturing_run`
   - `GetProductionFeasibility` → `get_production_feasibility`
   - `GetReorderRecommendations` → `get_reorder_recommendations`
   - `GetSupplyChainVendors` → `get_supply_chain_vendors`
   - `PlaceSupplyOrder` → `place_supply_order`
   - `GetActiveSupplyOrders` → `get_active_supply_orders`

3. **Test localization** by passing `cultureId` arguments:
   - `en-US` (English - default)
   - `fr-FR` (French)
   - `es-ES` (Spanish)
   - `de-DE` (German)
   - `ja-JP` (Japanese)

4. **Use the web UI for exploration**, then switch to CLI for automation once you know the tool parameters.

### Troubleshooting

If the Inspector cannot connect:

```bash
# Verify the MCP service is running (export the URL first if not already done)
export MCP_SERVICE_URL=$(azd env get-values | grep MCP_SERVICE_URL | cut -d'=' -f2 | tr -d '"')
curl -X POST "$MCP_SERVICE_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Check Azure Container App logs:

```bash
az containerapp logs show \
  --name $(azd env get-values | grep SERVICE_API_MCP_NAME | cut -d'=' -f2 | tr -d '"') \
  --resource-group $(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d'=' -f2 | tr -d '"') \
  --follow
```

For more information on the MCP Inspector, see the [official documentation](https://github.com/modelcontextprotocol/inspector).

---

## Related documentation

- Overall architecture and components: [README.md](../README.md)
- Azure deployment and azd hooks: [QUICKSTART.md](../QUICKSTART.md), [scripts/README.md](../scripts/README.md)
- Infrastructure and Container Apps: [infra/README.md](../infra/README.md)
- AI agent configuration and automation: [docs/AGENT_FRAMEWORK_MIGRATION.md](../docs/AGENT_FRAMEWORK_MIGRATION.md), [docs/AI_AGENT_AUTOMATION.md](../docs/AI_AGENT_AUTOMATION.md), [docs/AI_AGENT_DEPLOYMENT_SUMMARY.md](../docs/AI_AGENT_DEPLOYMENT_SUMMARY.md)
- AI agent telemetry and testing: [docs/AI_AGENT_TELEMETRY_IMPLEMENTATION.md](../docs/AI_AGENT_TELEMETRY_IMPLEMENTATION.md), [docs/AI_AND_MCP_TESTING_GUIDE.md](../docs/AI_AND_MCP_TESTING_GUIDE.md), [docs/AI_CHAT_MCP_TESTING.md](../docs/AI_CHAT_MCP_TESTING.md)
- Functions that call this MCP server: [api-functions/README.md](../api-functions/README.md)
