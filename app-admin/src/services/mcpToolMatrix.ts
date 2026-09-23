// AUTHORITATIVE tool-to-scope matrix, generated from
// api-mcp/AdventureWorks/Auth/ToolAuthorizationPolicy.cs (the server-side source of
// truth that is actually enforced by McpToolAuthorizationFilter). Used by the
// admin Authorization Inspection page to preview allow/deny decisions. Enforcement
// is always server-side; this is a faithful mirror for display only.

export type ToolAccessMode = "Public" | "SelfOrInternal" | "InternalOnly";

export interface ToolPolicyEntry {
  tool: string;
  scope: string;
  mode: ToolAccessMode;
  /** camelCase argument carrying the owning CustomerID (SelfOrInternal tools). */
  owner: string;
}

export const TOOL_POLICIES: ToolPolicyEntry[] = [
  { tool: "get_customer_orders", scope: "orders.read", mode: "SelfOrInternal", owner: "customerId" },
  { tool: "get_order_details", scope: "orders.read", mode: "SelfOrInternal", owner: "customerId" },
  { tool: "find_complementary_products", scope: "products.read", mode: "Public", owner: "" },
  { tool: "search_products", scope: "products.read", mode: "Public", owner: "" },
  { tool: "get_product_details", scope: "products.read", mode: "Public", owner: "" },
  { tool: "get_personalized_recommendations", scope: "products.read", mode: "SelfOrInternal", owner: "customerId" },
  { tool: "analyze_product_reviews", scope: "products.read", mode: "Public", owner: "" },
  { tool: "check_inventory_availability", scope: "inventory.read", mode: "InternalOnly", owner: "" },
  { tool: "get_products_for_promotion", scope: "admin.read", mode: "InternalOnly", owner: "" },
  { tool: "get_categories_with_products", scope: "products.read", mode: "Public", owner: "" },
  { tool: "get_active_promotions", scope: "products.read", mode: "Public", owner: "" },
  { tool: "get_recent_customers_without_orders", scope: "customers.read", mode: "InternalOnly", owner: "" },
  { tool: "search_customers", scope: "customers.read", mode: "InternalOnly", owner: "" },
  { tool: "get_top_selling_products", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_business_stats", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_top_customers", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_orders_by_status", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_sales_report_by_status", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_product_performance_summary", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_bank_status", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_bank_account", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_bank_transactions", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "bank_deposit", scope: "admin.write", mode: "InternalOnly", owner: "" },
  { tool: "bank_withdraw", scope: "admin.write", mode: "InternalOnly", owner: "" },
  { tool: "get_supported_currencies", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_financial_summary", scope: "sales.read", mode: "InternalOnly", owner: "" },
  { tool: "get_procurement_transactions", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_manufacturing_financials", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "generate_random_customer", scope: "admin.write", mode: "InternalOnly", owner: "" },
  { tool: "generate_random_customer_for_locale", scope: "admin.write", mode: "InternalOnly", owner: "" },
  { tool: "reset_all_simulators", scope: "mcp.admin", mode: "InternalOnly", owner: "" },
  { tool: "get_manufacturing_status", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_active_manufacturing_operations", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_manufacturing_workforce", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_manufacturing_scrap_events", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_vendor_quality_report", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_scrap_configuration", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_location_configuration", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_production_feasibility", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_all_products_feasibility", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_product_cost_analysis", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_manufacturing_catalog_snapshot", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_overstock_items", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_thin_margin_products", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_component_shortage_forecast", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_reorder_recommendations", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "begin_manufacturing_run", scope: "manufacturing.write", mode: "InternalOnly", owner: "" },
  { tool: "stop_manufacturing", scope: "manufacturing.write", mode: "InternalOnly", owner: "" },
  { tool: "update_scrap_configuration", scope: "manufacturing.write", mode: "InternalOnly", owner: "" },
  { tool: "update_location_configuration", scope: "manufacturing.write", mode: "InternalOnly", owner: "" },
  { tool: "propose_manufacturing_run", scope: "manufacturing.write", mode: "InternalOnly", owner: "" },
  { tool: "get_supply_chain_vendors", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_vendor_details", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_supply_catalog", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_supply_quote", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_active_supply_orders", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_supply_order_history", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "get_supply_order_details", scope: "manufacturing.read", mode: "InternalOnly", owner: "" },
  { tool: "place_supply_order", scope: "manufacturing.write", mode: "InternalOnly", owner: "" },
  { tool: "cancel_supply_order", scope: "manufacturing.write", mode: "InternalOnly", owner: "" },
  { tool: "restock_vendor_inventory", scope: "manufacturing.write", mode: "InternalOnly", owner: "" },
  { tool: "propose_supply_order", scope: "manufacturing.write", mode: "InternalOnly", owner: "" }
];

export interface ToolDecision extends ToolPolicyEntry {
  allowed: boolean;
  reason: string;
}

/**
 * Predicts the authorization decision for each MCP tool given a set of granted
 * scopes and the caller category. Mirrors the server-side rules:
 *  - Public tools: allowed to anyone holding the required scope.
 *  - InternalOnly tools: require the scope AND an internal (employee/manufacturing)
 *    category — consumers are denied even if a scope overlaps.
 *  - SelfOrInternal tools: internal callers with the scope are allowed; consumers
 *    with the scope are allowed only for their OWN records (ownership enforced
 *    server-side from the token subject, never a client-supplied id).
 */
export function evaluateTools(
  grantedScopes: string[],
  category: string,
): ToolDecision[] {
  const scopes = new Set(grantedScopes);
  const isInternal = category === "employee" || category === "manufacturing";
  return TOOL_POLICIES.map((p) => {
    const hasScope = scopes.has(p.scope);
    if (!hasScope) {
      return { ...p, allowed: false, reason: `Missing scope ${p.scope}` };
    }
    if (p.mode === "InternalOnly" && !isInternal) {
      return { ...p, allowed: false, reason: "Internal-only (employee/manufacturing)" };
    }
    if (p.mode === "SelfOrInternal" && !isInternal) {
      return {
        ...p,
        allowed: true,
        reason: `Own records only (ownership on ${p.owner})`,
      };
    }
    return { ...p, allowed: true, reason: `Scope ${p.scope} granted` };
  });
}

/** Distinct scopes referenced by the matrix, in a stable order. */
export const ALL_TOOL_SCOPES = Array.from(
  new Set(TOOL_POLICIES.map((p) => p.scope)),
).sort();
