# AdventureWorks MCP — Complete Tool-to-Scope Authorization Matrix

> This document is the human-readable projection of the single source of truth in
> [`api-mcp/AdventureWorks/Auth/ToolAuthorizationPolicy.cs`](../../../api-mcp/AdventureWorks/Auth/ToolAuthorizationPolicy.cs).
> A startup assertion (`McpAuthorizationExtensions`) fails fast if **any** MCP tool
> discovered by the server is missing from that registry, so no tool can ship
> unclassified. There are **62** tools across 6 tool classes.

## How to read this matrix

| Column | Meaning |
| ------ | ------- |
| **Tool (MCP wire name)** | The `snake_case` name the MCP SDK exposes on the wire (PascalCase method → snake_case). |
| **Required scope** | The single business-domain OAuth scope the access token must carry. Enforced server-side before the tool body runs. |
| **Access mode** | `Public` = any holder of the scope. `Self-or-internal (ownership)` = consumers may act only on their own records (server-resolved `CustomerID`), internal roles are unrestricted. `Internal-only` = requires the scope **and** a non-consumer category (defense-in-depth even if a token carried the scope). |
| **Ownership arg** | For ownership-checked tools, the tool argument whose customer identifier is validated/overwritten against the caller's server-resolved `CustomerID`. A client-supplied value can never widen access. |

Every authenticated MCP connection additionally requires the baseline **`mcp.access`**
scope (validated on `/mcp` before any tool dispatch). The scopes below are *in addition*
to `mcp.access`.

## Tools per required scope

| Required scope | Tool count |
| -------------- | ---------- |
| `manufacturing.read` | 24 |
| `sales.read` | 11 |
| `manufacturing.write` | 9 |
| `products.read` | 7 |
| `admin.write` | 4 |
| `orders.read` | 2 |
| `customers.read` | 2 |
| `inventory.read` | 1 |
| `admin.read` | 1 |
| `mcp.admin` | 1 |

## Matrix by tool class

### AdventureWorksMcpTools (19 tools)

| Tool (MCP wire name) | Required scope | Access mode | Ownership arg |
| -------------------- | -------------- | ----------- | ------------- |
| `get_customer_orders` | `orders.read` | Self-or-internal (ownership) | `customerId` |
| `get_order_details` | `orders.read` | Self-or-internal (ownership) | `customerId` |
| `find_complementary_products` | `products.read` | Public | — |
| `search_products` | `products.read` | Public | — |
| `get_product_details` | `products.read` | Public | — |
| `get_personalized_recommendations` | `products.read` | Self-or-internal (ownership) | `customerId` |
| `analyze_product_reviews` | `products.read` | Public | — |
| `check_inventory_availability` | `inventory.read` | Internal-only | — |
| `get_products_for_promotion` | `admin.read` | Internal-only | — |
| `get_categories_with_products` | `products.read` | Public | — |
| `get_active_promotions` | `products.read` | Public | — |
| `get_recent_customers_without_orders` | `customers.read` | Internal-only | — |
| `search_customers` | `customers.read` | Internal-only | — |
| `get_top_selling_products` | `sales.read` | Internal-only | — |
| `get_business_stats` | `sales.read` | Internal-only | — |
| `get_top_customers` | `sales.read` | Internal-only | — |
| `get_orders_by_status` | `sales.read` | Internal-only | — |
| `get_sales_report_by_status` | `sales.read` | Internal-only | — |
| `get_product_performance_summary` | `sales.read` | Internal-only | — |

### BankMcpTools (9 tools)

| Tool (MCP wire name) | Required scope | Access mode | Ownership arg |
| -------------------- | -------------- | ----------- | ------------- |
| `get_bank_status` | `sales.read` | Internal-only | — |
| `get_bank_account` | `sales.read` | Internal-only | — |
| `get_bank_transactions` | `sales.read` | Internal-only | — |
| `bank_deposit` | `admin.write` | Internal-only | — |
| `bank_withdraw` | `admin.write` | Internal-only | — |
| `get_supported_currencies` | `sales.read` | Internal-only | — |
| `get_financial_summary` | `sales.read` | Internal-only | — |
| `get_procurement_transactions` | `manufacturing.read` | Internal-only | — |
| `get_manufacturing_financials` | `manufacturing.read` | Internal-only | — |

### CustomerGeneratorMcpTools (2 tools)

| Tool (MCP wire name) | Required scope | Access mode | Ownership arg |
| -------------------- | -------------- | ----------- | ------------- |
| `generate_random_customer` | `admin.write` | Internal-only | — |
| `generate_random_customer_for_locale` | `admin.write` | Internal-only | — |

### SimulatorMcpTools (1 tools)

| Tool (MCP wire name) | Required scope | Access mode | Ownership arg |
| -------------------- | -------------- | ----------- | ------------- |
| `reset_all_simulators` | `mcp.admin` | Internal-only | — |

### ManufacturingMcpTools (20 tools)

| Tool (MCP wire name) | Required scope | Access mode | Ownership arg |
| -------------------- | -------------- | ----------- | ------------- |
| `get_manufacturing_status` | `manufacturing.read` | Internal-only | — |
| `get_active_manufacturing_operations` | `manufacturing.read` | Internal-only | — |
| `get_manufacturing_workforce` | `manufacturing.read` | Internal-only | — |
| `get_manufacturing_scrap_events` | `manufacturing.read` | Internal-only | — |
| `get_vendor_quality_report` | `manufacturing.read` | Internal-only | — |
| `get_scrap_configuration` | `manufacturing.read` | Internal-only | — |
| `get_location_configuration` | `manufacturing.read` | Internal-only | — |
| `get_production_feasibility` | `manufacturing.read` | Internal-only | — |
| `get_all_products_feasibility` | `manufacturing.read` | Internal-only | — |
| `get_product_cost_analysis` | `manufacturing.read` | Internal-only | — |
| `get_manufacturing_catalog_snapshot` | `manufacturing.read` | Internal-only | — |
| `get_overstock_items` | `manufacturing.read` | Internal-only | — |
| `get_thin_margin_products` | `manufacturing.read` | Internal-only | — |
| `get_component_shortage_forecast` | `manufacturing.read` | Internal-only | — |
| `get_reorder_recommendations` | `manufacturing.read` | Internal-only | — |
| `begin_manufacturing_run` | `manufacturing.write` | Internal-only | — |
| `stop_manufacturing` | `manufacturing.write` | Internal-only | — |
| `update_scrap_configuration` | `manufacturing.write` | Internal-only | — |
| `update_location_configuration` | `manufacturing.write` | Internal-only | — |
| `propose_manufacturing_run` | `manufacturing.write` | Internal-only | — |

### SupplyChainMcpTools (11 tools)

| Tool (MCP wire name) | Required scope | Access mode | Ownership arg |
| -------------------- | -------------- | ----------- | ------------- |
| `get_supply_chain_vendors` | `manufacturing.read` | Internal-only | — |
| `get_vendor_details` | `manufacturing.read` | Internal-only | — |
| `get_supply_catalog` | `manufacturing.read` | Internal-only | — |
| `get_supply_quote` | `manufacturing.read` | Internal-only | — |
| `get_active_supply_orders` | `manufacturing.read` | Internal-only | — |
| `get_supply_order_history` | `manufacturing.read` | Internal-only | — |
| `get_supply_order_details` | `manufacturing.read` | Internal-only | — |
| `place_supply_order` | `manufacturing.write` | Internal-only | — |
| `cancel_supply_order` | `manufacturing.write` | Internal-only | — |
| `restock_vendor_inventory` | `manufacturing.write` | Internal-only | — |
| `propose_supply_order` | `manufacturing.write` | Internal-only | — |
