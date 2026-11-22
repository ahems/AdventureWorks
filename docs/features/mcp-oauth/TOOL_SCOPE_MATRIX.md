---
title: MCP tool-to-scope authorization matrix (all 63 tools)
summary: Canonical reference for every api-mcp MCP tool, with description, required OAuth scope, access mode, ownership argument and the service principals allowed to call it.
audience: [developer, security-reviewer, ai-agent]
components: [api-mcp, api-functions, manufacturing-agent]
related:
  - docs/features/mcp-oauth/README.md
  - docs/services/api-mcp.md
  - docs/features/functions-oauth/ROUTE_SCOPE_MATRIX.md
  - docs/services/manufacturing-agent.md
---

# MCP tool-to-scope authorization matrix (all 63 api-mcp tools)

This is the canonical list of the **63** MCP tools that api-mcp exposes at `/mcp`, across 6 tool classes, with the authorization rule applied to each one.

**How this page is maintained.** It is hand-maintained. The rules it describes are enforced in code:

- Scope, access mode and ownership argument come from `ToolAuthorizationRegistry` in [`ToolAuthorizationPolicy.cs`](../../../api-mcp/AdventureWorks/Auth/ToolAuthorizationPolicy.cs). At startup, `ValidateToolAuthorizationCoverage` (in `McpAuthorizationExtensions.cs`) stops the server if any discovered tool lacks a registry entry, so a new tool cannot ship unclassified.
- The **Service-principal callers** column comes from the allow-lists in [`ServicePrincipalPolicy.cs`](../../../api-mcp/AdventureWorks/Auth/ServicePrincipalPolicy.cs).
- Descriptions are the first sentences of each tool's `[Description]` attribute in `api-mcp/AdventureWorks/Tools/*.cs`.

To compare this page with the code, run the `AuthInventoryTests` test in `api-mcp/AdventureWorks.Tests` with the `AUTH_MCP_INVENTORY` environment variable set to an output file path. The test writes the live tool inventory as JSON to that file.

## How to read this matrix

| Column | Meaning |
| ------ | ------- |
| **Tool (MCP wire name)** | The `snake_case` name the MCP SDK exposes on the wire (PascalCase method → snake_case). |
| **Description** | Summary of the tool's `[Description]` attribute (what an agent sees in `tools/list`). |
| **Required scope** | The single business-domain OAuth scope the access token must carry. Enforced server-side before the tool body runs. |
| **Access mode** | `Public` = any holder of the scope. `Self-or-internal (ownership)` = consumers may act only on their own records (server-resolved `CustomerID`), internal roles are unrestricted. `Internal-only` = requires the scope **and** a non-consumer category (defense-in-depth even if a token carried the scope). |
| **Ownership arg** | For ownership-checked tools, the tool argument whose customer identifier is validated/overwritten against the caller's server-resolved `CustomerID`. A client-supplied value can never widen access. |
| **Service-principal callers** | Workload identities (not users) allowed to call the tool. **Functions** = the Azure Functions app's managed identity (12 tools). **Hosted Manufacturing agent** = the Foundry hosted agent's identity (20 tools). `—` = user tokens only. |

Every authenticated MCP connection additionally requires the baseline **`mcp.access`**
scope (validated on `/mcp` before any tool dispatch). The scopes below are *in addition*
to `mcp.access`. `tools/list` returns all 63 tools to every caller; authorization is enforced when a tool is called.

Five tools ask the user to confirm before they run (MCP elicitation): `begin_manufacturing_run`, `stop_manufacturing`, `update_scrap_configuration`, `update_location_configuration` and `reset_all_simulators`.

## Totals

| Required scope | Tool count |
| -------------- | ---------- |
| `manufacturing.read` | 24 |
| `sales.read` | 11 |
| `manufacturing.write` | 9 |
| `products.read` | 7 |
| `admin.write` | 4 |
| `orders.read` | 3 |
| `customers.read` | 2 |
| `inventory.read` | 1 |
| `admin.read` | 1 |
| `mcp.admin` | 1 |
| **Total** | **63** |

| Access mode | Tool count |
| ----------- | ---------- |
| Internal-only | 53 |
| Public | 7 |
| Self-or-internal (ownership) | 3 |

| Tool class | Tool count |
| ---------- | ---------- |
| `AdventureWorksMcpTools` | 20 |
| `ManufacturingMcpTools` | 20 |
| `SupplyChainMcpTools` | 11 |
| `BankMcpTools` | 9 |
| `CustomerGeneratorMcpTools` | 2 |
| `SimulatorMcpTools` | 1 |

## Matrix by tool class

### AdventureWorksMcpTools (20 tools)

| Tool (MCP wire name) | Description | Required scope | Access mode | Ownership arg | Service-principal callers |
| -------------------- | ----------- | -------------- | ----------- | ------------- | ------------------------- |
| `get_customer_orders` | Get order history and status for a customer by their CustomerID. Returns up to 10 most recent orders with status information. | `orders.read` | Self-or-internal (ownership) | `customerId` | Functions |
| `get_order_details` | Get detailed information about a specific order including items, pricing, and shipping status. Optional: Validates order belongs to customer. | `orders.read` | Self-or-internal (ownership) | `customerId` | Functions, Hosted Manufacturing agent |
| `find_complementary_products` | Find products that are frequently purchased together with a specific product. Great for product recommendations. | `products.read` | Public | — | Functions |
| `search_products` | Search for products by name, category, or attributes. Returns matching products with details. | `products.read` | Public | — | Functions |
| `get_product_details` | Get detailed information about a specific product including specifications, pricing, and inventory. | `products.read` | Public | — | Functions, Hosted Manufacturing agent |
| `get_personalized_recommendations` | Get personalized product recommendations for a customer based on their purchase history, preferences, and buying patterns. Returns products the customer might like. | `orders.read` | Self-or-internal (ownership) | `customerId` | Functions |
| `analyze_product_reviews` | Analyze and summarize customer reviews for a product. Returns average rating, review count, sentiment analysis, and common themes from customer feedback. | `products.read` | Public | — | — |
| `get_product_availability` | Check whether a customer-facing finished product is in stock. Returns only the product ID and an inStock boolean; null means the finished product was not found. | `products.read` | Public | — | — |
| `check_inventory_availability` | Check real-time inventory availability for a product in finished goods locations. Returns stock levels, finished goods storage locations, and availability status. | `inventory.read` | Internal-only | — | Functions, Hosted Manufacturing agent |
| `get_products_for_promotion` | Get products with inventory and sales data to support promotion creation. Returns products ranked by their suitability for the given promotion type. | `admin.read` | Internal-only | — | — |
| `get_categories_with_products` | Get the full AdventureWorks product catalogue organized by category and subcategory, showing in-stock products with prices and stock levels. | `products.read` | Public | — | Functions |
| `get_active_promotions` | Get all currently active promotions with eligible products and discount details. Use this when planning orders so you can apply available discounts to make the order more realistic. | `products.read` | Public | — | Functions |
| `get_recent_customers_without_orders` | Admin tool: Find the most recently registered customers who have NEVER placed any order. Returns CustomerID, full name, email, and location. | `customers.read` | Internal-only | — | — |
| `search_customers` | Search existing AdventureWorks customers by name (partial match). Returns CustomerID, name, email, location, and order history summary. | `customers.read` | Internal-only | — | Functions |
| `get_top_selling_products` | Get the top-selling products ranked by total revenue. Use this for admin analytics questions about best sellers, most popular products, top revenue items, or product sales performance. | `sales.read` | Internal-only | — | — |
| `get_business_stats` | Admin tool: Return high-level business KPIs — total customers, total orders, total revenue, orders and revenue broken down by status (In Process, Approved, Backordered, Rejected, Shipped, Cancelled), and top 5 product categories by revenue. | `sales.read` | Internal-only | — | — |
| `get_top_customers` | Admin tool: Return the top N customers ranked by their lifetime total spend. Use this when asked 'who are the best/top customers', 'highest-value customers', or 'biggest spenders'. | `sales.read` | Internal-only | — | — |
| `get_orders_by_status` | Admin tool: Return orders filtered by a plain-English status name. Accepted values for statusFilter: 'pending' (same as 'in process'), 'approved', 'backordered', 'rejected', 'shipped', 'cancelled'. | `sales.read` | Internal-only | — | — |
| `get_sales_report_by_status` | Admin tool: Generate a sales report grouped by order status. | `sales.read` | Internal-only | — | — |
| `get_product_performance_summary` | Admin tool: Get a comprehensive performance summary for a specific product by ProductID. | `sales.read` | Internal-only | — | — |

### BankMcpTools (9 tools)

| Tool (MCP wire name) | Description | Required scope | Access mode | Ownership arg | Service-principal callers |
| -------------------- | ----------- | -------------- | ----------- | ------------- | ------------------------- |
| `get_bank_status` | Get the current virtual bank status: all currency account balances and a USD-equivalent total calculated using live exchange rates. | `sales.read` | Internal-only | — | — |
| `get_bank_account` | Get the current balance for a specific currency account. For example, 'USD' for the main account or 'EUR' for the Euro account. | `sales.read` | Internal-only | — | — |
| `get_bank_transactions` | List the most recent bank transactions across all currencies or filtered to a specific currency. | `sales.read` | Internal-only | — | — |
| `bank_deposit` | Record a credit (incoming money) to a virtual bank account. Use this when a customer sale is completed, a return is received, or any other money-in event occurs. | `admin.write` | Internal-only | — | — |
| `bank_withdraw` | Record a debit (outgoing money) from a virtual bank account. Use this when paying vendors for purchased components (always use USD), paying worker wages (USD), or any other money-out event. | `admin.write` | Internal-only | — | — |
| `get_supported_currencies` | List all currencies supported by this virtual bank. Currency accounts are automatically created for every currency in the AdventureWorks Sales.Currency database table. | `sales.read` | Internal-only | — | — |
| `get_financial_summary` | Get a financial summary across all simulators showing procurement spend (PO approvals and refunds), manufacturing WO overhead costs, payroll charges per routing operation, and scrap write-offs. | `sales.read` | Internal-only | — | — |
| `get_procurement_transactions` | Get recent procurement transactions — PO approval debits and refunds for rejected deliveries. Use this to audit which purchase orders have been paid for and which were refunded. | `manufacturing.read` | Internal-only | — | — |
| `get_manufacturing_financials` | Get recent manufacturing financial transactions. | `manufacturing.read` | Internal-only | — | — |

### CustomerGeneratorMcpTools (2 tools)

| Tool (MCP wire name) | Description | Required scope | Access mode | Ownership arg | Service-principal callers |
| -------------------- | ----------- | -------------- | ----------- | ------------- | ------------------------- |
| `generate_random_customer` | Generate a complete random fictitious customer profile for the shopping simulator. | `admin.write` | Internal-only | — | Functions |
| `generate_random_customer_for_locale` | Generate a complete random fictitious customer profile for a specific locale/culture. | `admin.write` | Internal-only | — | Functions |

### SimulatorMcpTools (1 tool)

| Tool (MCP wire name) | Description | Required scope | Access mode | Ownership arg | Service-principal callers |
| -------------------- | ----------- | -------------- | ----------- | ------------- | ------------------------- |
| `reset_all_simulators` | Reset ALL simulators together in the correct order: (1) clears the manufacturing work-order queue, (2) resets the supply chain and re-seeds vendor stock, (3) resets the bank and re-seeds the USD balance from historical profit. | `mcp.admin` | Internal-only | — | — |

### ManufacturingMcpTools (20 tools)

| Tool (MCP wire name) | Description | Required scope | Access mode | Ownership arg | Service-principal callers |
| -------------------- | ----------- | -------------- | ----------- | ------------- | ------------------------- |
| `get_manufacturing_status` | Get the current live status of the manufacturing simulation: whether it is running, queue depth, work order counts (pending/in-progress/completed today), material shortages, recent scrap events, and load per production location. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_active_manufacturing_operations` | List all manufacturing routing operations that are currently in progress, including elapsed time, product name, location, and operation sequence number. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `begin_manufacturing_run` | Start a new manufacturing production run for a finished good. Explodes the bill of materials, creates work orders for all components, and queues routing operations. | `manufacturing.write` | Internal-only | — | Hosted Manufacturing agent |
| `stop_manufacturing` | Stop the manufacturing simulation by clearing the production queue. In-flight operations will finish but no new ones will be started. | `manufacturing.write` | Internal-only | — | — |
| `get_manufacturing_workforce` | Get a headcount summary of the manufacturing workforce grouped by production location and shift. Shows total workers and how many are currently active. | `manufacturing.read` | Internal-only | — | — |
| `get_manufacturing_scrap_events` | Retrieve scrap events recorded during manufacturing. Optionally filter by vendorId to investigate scrap attributable to components from a specific supplier. | `manufacturing.read` | Internal-only | — | — |
| `get_vendor_quality_report` | Get an aggregated quality report per supplier vendor showing total components supplied, number of scrap events, total scrapped quantity, and scrap rate. | `manufacturing.read` | Internal-only | — | — |
| `get_scrap_configuration` | Get the current per-location scrap failure rates and applicable scrap reason codes. Use this to understand the current quality configuration of each production station before making adjustments. | `manufacturing.read` | Internal-only | — | — |
| `update_scrap_configuration` | Update the scrap failure rate for a specific production location. Used to simulate quality improvements or degradation. | `manufacturing.write` | Internal-only | — | — |
| `get_location_configuration` | Get the capacity and shift configuration for all production locations, including capacity units, daily operating hours, speed factor, and shift start hour. | `manufacturing.read` | Internal-only | — | — |
| `update_location_configuration` | Update the capacity and shift settings for a specific production location. Use to simulate overtime, shift changes, or capacity expansions. | `manufacturing.write` | Internal-only | — | — |
| `get_production_feasibility` | Check whether a specific finished good can be manufactured given current component stock. Returns the maximum producible quantity and any bottleneck components. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_all_products_feasibility` | Get a feasibility snapshot for ALL manufactured finished goods showing the maximum producible quantity of each, inventory signal (overstock/low-stock/out-of-stock/healthy), pricing signal, and weeks of supply. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_product_cost_analysis` | Get a full bill-of-materials (BOM) cost breakdown for a manufactured product including routing labour costs and gross margin vs list price. | `manufacturing.read` | Internal-only | — | — |
| `get_manufacturing_catalog_snapshot` | Get a full catalog snapshot of all manufactured finished goods with stock levels, sales velocity, weeks of supply, and derived signals. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_overstock_items` | Find finished goods that have excess inventory relative to recent sales velocity (candidates for promotions or discounts in the eShop). Default threshold is 12 weeks of supply. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_thin_margin_products` | Find finished goods whose gross margin is below a given threshold — candidates for a list price increase. Default threshold is 20% margin. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_component_shortage_forecast` | Forecast which purchased components will run out of stock within the next N days based on current manufacturing activity and sales velocity. Returns items sorted by urgency (critical/warning/watch). | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_reorder_recommendations` | Get reorder recommendations for components forecast to run out within the next N days. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `propose_manufacturing_run` | Propose starting a manufacturing run for a product, pending human approval. Use this instead of BeginManufacturingRun when the agent mode is ProposePending. | `manufacturing.write` | Internal-only | — | — |

### SupplyChainMcpTools (11 tools)

| Tool (MCP wire name) | Description | Required scope | Access mode | Ownership arg | Service-principal callers |
| -------------------- | ----------- | -------------- | ----------- | ------------- | ------------------------- |
| `get_supply_chain_vendors` | List all active supply chain vendors with their credit rating, preferred status, number of unique products supplied, and total stock available. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_vendor_details` | Get detailed information about a specific vendor including their catalog of components with current stock levels, unit prices, lead times, and minimum order quantities. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_supply_catalog` | Get the full supply chain vendor catalog showing all components available to order, with vendor names, stock levels, unit prices, and lead times. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_supply_quote` | Get a real-time quote from a specific vendor for a component including unit price, any quantity discount, total cost, available stock, and lead time. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `place_supply_order` | Place a purchase order with a vendor for a component. The vendor must have sufficient stock. | `manufacturing.write` | Internal-only | — | Hosted Manufacturing agent |
| `get_active_supply_orders` | List all currently active (non-completed) supply chain purchase orders showing order ID, vendor, product, quantity, cost, status, and expected delivery date. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_supply_order_history` | Get the full historical log of all supply chain purchase orders including delivered and cancelled orders. Useful for analysing purchasing patterns, vendor performance, and total procurement spend. | `manufacturing.read` | Internal-only | — | Hosted Manufacturing agent |
| `get_supply_order_details` | Get the current SQL status and details of a specific supply chain purchase order by its numeric PurchaseOrderID, including all matching purchased BOM component lines and the order total. | `manufacturing.read` | Internal-only | — | — |
| `cancel_supply_order` | Cancel a pending supply chain purchase order. Only orders in 'pending' status can be cancelled. | `manufacturing.write` | Internal-only | — | — |
| `restock_vendor_inventory` | Trigger an immediate restock of a vendor's simulated inventory — useful when testing or when vendor stock has been depleted through orders. | `manufacturing.write` | Internal-only | — | — |
| `propose_supply_order` | Propose placing a supply order with a vendor, pending human approval. Use this instead of PlaceSupplyOrder when the agent mode is ProposePending. | `manufacturing.write` | Internal-only | — | — |
