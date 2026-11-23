import { getCurrentClaims, type DabTokenClaims } from "@/services/dabAuth";

/**
 * OAuth scopes the admin portal gates UI actions on. They mirror the api-mcp role →
 * scope grants and the Functions route registry; the server remains authoritative.
 */
export const Scopes = {
  SalesRead: "sales.read",
  CustomersRead: "customers.read",
  CustomersWrite: "customers.write",
  OrdersRead: "orders.read",
  OrdersWrite: "orders.write",
  InventoryRead: "inventory.read",
  ManufacturingRead: "manufacturing.read",
  ManufacturingWrite: "manufacturing.write",
  AdminRead: "admin.read",
  AdminWrite: "admin.write",
  McpAdmin: "mcp.admin",
  MonitoringRead: "monitoring.read",
  MonitoringWrite: "monitoring.write",
} as const;

export type Scope = (typeof Scopes)[keyof typeof Scopes];

/** Scopes granted in a token's `scope` (space-delimited) or `scp` claim. */
export function scopesFromClaims(claims: DabTokenClaims | null | undefined): Set<string> {
  const granted = new Set<string>();
  if (!claims) return granted;
  const add = (value: unknown) => {
    if (typeof value === "string") {
      for (const s of value.split(/\s+/)) if (s) granted.add(s);
    } else if (Array.isArray(value)) {
      for (const v of value) add(v);
    }
  };
  add(claims.scope);
  add(claims.scp);
  return granted;
}

/** Scopes granted to the signed-in employee's current access token. */
export function getGrantedScopes(): Set<string> {
  return scopesFromClaims(getCurrentClaims());
}

export function hasScope(scope: string): boolean {
  return getGrantedScopes().has(scope);
}
