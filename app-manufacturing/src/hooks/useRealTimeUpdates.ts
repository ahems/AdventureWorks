import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useWebPubSub } from "./useWebPubSub";

const INVENTORY_KEYS = [
  "all-product-inventory", "product-inventory", "product-inventory-all",
  "inventory-all", "plan-catalog", "fg-catalog-dashboard", "shortage-forecast",
  "reorder-recs", "overstock", "feasibility-blocked",
];
const COST_KEYS = [
  "all-cost-history", "cost-history", "product-cost-history", "current-cost",
  "price-history", "thin-margin", "plan-catalog", "fg-catalog-dashboard",
];
const OPERATIONS_KEYS = [
  "manufacturing-status", "manufacturing-active", "active-operations",
  "manufacturing-status-vendor-detail", "manufacturing-status-vendor-blockers",
  "work-orders", "work-order", "work-orders-active", "all-recent-wos",
  "wos-for-product", "workforce-snapshot", "workforce", "workforce-detail",
  "vendor-quality", "vendor-quality-detail", "scrap-events",
  "recent-routings", "wo-routing", "all-routing", "all-routings",
  "work-order-routing", "work-order-routing-all", "product-routing", "routing-product",
];
const MANUFACTURING_IMPACT_KEYS = [
  "manufacturing-status", "manufacturing-active", "active-operations",
  "manufacturing-status-vendor-detail", "manufacturing-status-vendor-blockers",
  "work-orders", "work-order", "work-orders-active", "all-recent-wos",
  "wos-for-product", "supply-orders-shortages",
];
const PRODUCT_KEYS = [
  "product", "all-products", "products-all", "manufactured-products",
  "products-by-model", "products-meta", "product-model", "product-models",
  "active-bom", "instruction-bom", "instruction-components", "part-documents",
  "product-categories", "product-subcategories", "categories", "subcategories",
  "descriptions", "desc-cultures", "unit-measures", "locations", "location",
];
const SUPPLY_KEYS = [
  "supply-orders", "supply-orders-dashboard", "supply-orders-history",
  "supply-orders-shortages", "supply-orders-blocked", "supply-order",
  "open-purchase-orders", "po-headers-all", "po-details", "vendor-purchase-orders",
  "supply-catalog-all", "supply-catalog", "supply-catalog-product",
  "supply-catalogs-bulk", "supply-vendors", "supply-vendor", "vendors",
];
const FINANCE_KEYS = [
  "bank-status", "financial-summary", "recent-transactions",
  "procurement-transactions", "manufacturing-transactions",
];
const DEMAND_KEYS = [
  "open-demand", "open-sales-orders", "demand-anchor-date", "historical-demand",
];

// Group-level coverage also handles generic state-changed/database-changed events.
// Prefixes deliberately include inactive detail queries so later navigation is fresh.
export const GROUP_QUERY_KEYS: Record<string, readonly string[]> = {
  "manufacturing-agent": [
    "agent-runs", "agent-run-items", "agent-action-history",
    "agent-approvals-pending", "agent-queue-status", "agent-proposals",
    "manufacturing-agent-config",
  ],
  "manufacturing-ops": [
    ...OPERATIONS_KEYS, ...PRODUCT_KEYS, ...INVENTORY_KEYS, ...COST_KEYS,
    "location-config", "scrap-config", "scrap-reasons", "departments", "shifts",
    "supply-orders-shortages",
  ],
  warehouse: [
    "warehouse-status", "warehouse-active", "warehouse-damage-events",
    "warehouse-workforce", "warehouse-workforce-detail", "subcategory-configs",
    "supplier-receive-configs", "warehouse-damage-config",
    ...INVENTORY_KEYS, ...COST_KEYS, ...MANUFACTURING_IMPACT_KEYS, ...SUPPLY_KEYS,
    "vendor-quality", "vendor-quality-detail",
  ],
  "supply-chain": [
    ...SUPPLY_KEYS, ...INVENTORY_KEYS, ...COST_KEYS, ...MANUFACTURING_IMPACT_KEYS,
    ...FINANCE_KEYS, "supply-chain-config", "vendor-quality", "vendor-quality-detail",
  ],
  orders: [...DEMAND_KEYS, ...INVENTORY_KEYS, ...MANUFACTURING_IMPACT_KEYS, ...FINANCE_KEYS],
  "shopping-simulator": [...DEMAND_KEYS, ...INVENTORY_KEYS, ...MANUFACTURING_IMPACT_KEYS],
  finance: [...FINANCE_KEYS, ...COST_KEYS, "open-sales-orders"],
};

const GROUPS = Object.keys(GROUP_QUERY_KEYS);
const SNAPSHOT_KEYS = [...new Set(Object.values(GROUP_QUERY_KEYS).flat())];

/** Mount once at the app root; timers exist only while events are pending. */
export function useRealTimeUpdates() {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingKeys = useRef(new Set<string>());
  const flushing = useRef(false);
  const epoch = useRef(0);

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    const mountedEpoch = ++epoch.current;
    const keys = pendingKeys.current;
    return () => {
      epoch.current = mountedEpoch + 1;
      clearTimer();
      keys.clear();
      flushing.current = false;
    };
  }, []);

  const flush = async () => {
    if (flushing.current) return;
    const startedEpoch = epoch.current;
    flushing.current = true;
    try {
      while (epoch.current === startedEpoch && pendingKeys.current.size) {
        const batch = [...pendingKeys.current];
        pendingKeys.current.clear();
        // A read already started before this mutation may return an older
        // snapshot. Wait for it, then retain one dirty follow-up for that root.
        const alreadyFetching = batch.filter(
          (key) => qc.isFetching({ queryKey: [key], type: "active" }) > 0,
        );
        await Promise.all(batch.map((key) =>
          qc.invalidateQueries({ queryKey: [key] }, { cancelRefetch: false }),
        ));
        if (epoch.current !== startedEpoch) return;
        alreadyFetching.forEach((key) => pendingKeys.current.add(key));
        // Events received while awaiting reads are coalesced here, not lost.
      }
    } finally {
      if (epoch.current === startedEpoch) flushing.current = false;
    }
  };

  return useWebPubSub(
    GROUPS,
    (group) => {
      const keys = GROUP_QUERY_KEYS[group];
      if (!keys) return;
      keys.forEach((key) => pendingKeys.current.add(key));
      if (flushing.current || timer.current !== null) return;
      // A fixed window (not a quiet-period debounce) bounds continuous bursts.
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, 2000);
    },
    () => {
      clearTimer();
      // The token's groups are joined before "connected". Catch up once after
      // subscribing/reconnecting so missed events cannot leave cached data stale.
      SNAPSHOT_KEYS.forEach((key) => pendingKeys.current.add(key));
      void flush();
    },
  );
}
