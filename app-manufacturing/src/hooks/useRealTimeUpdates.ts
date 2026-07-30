import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useWebPubSub } from "./useWebPubSub";

const GROUPS = [
  "manufacturing-agent",
  "manufacturing-ops",
  "warehouse",
  "supply-chain",
  "orders",
  "shopping-simulator",
  "finance",
];

/**
 * Subscribes to Web PubSub groups and invalidates React Query caches
 * when the server pushes real-time events. Mount once at the app root.
 *
 * This replaces aggressive polling with event-driven cache invalidation.
 * Each page still has a slow fallback `refetchInterval` for resilience.
 */
export function useRealTimeUpdates() {
  const qc = useQueryClient();
  const supplyChainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supplyChainHasPoCreated = useRef(false);

  useWebPubSub(GROUPS, (group, data) => {
    switch (group) {
      case "manufacturing-agent":
        qc.invalidateQueries({ queryKey: ["agent-runs"] });
        qc.invalidateQueries({ queryKey: ["agent-run-items"] });
        qc.invalidateQueries({ queryKey: ["agent-action-history"] });
        qc.invalidateQueries({ queryKey: ["agent-approvals-pending"] });
        qc.invalidateQueries({ queryKey: ["agent-queue-status"] });
        if ((data.event as string) === "config-changed") {
          qc.invalidateQueries({ queryKey: ["manufacturing-agent-config"] });
        }
        break;

      case "manufacturing-ops":
        qc.invalidateQueries({ queryKey: ["manufacturing-status"] });
        qc.invalidateQueries({ queryKey: ["manufacturing-active"] });
        qc.invalidateQueries({ queryKey: ["active-operations"] });
        qc.invalidateQueries({ queryKey: ["work-orders"] });
        qc.invalidateQueries({ queryKey: ["work-order"] });
        qc.invalidateQueries({ queryKey: ["work-orders-active"] });
        qc.invalidateQueries({ queryKey: ["all-recent-wos"] });
        qc.invalidateQueries({ queryKey: ["recent-routings"] });
        qc.invalidateQueries({ queryKey: ["wo-routing"] });
        qc.invalidateQueries({ queryKey: ["all-routing"] });
        qc.invalidateQueries({ queryKey: ["workforce-snapshot"] });
        qc.invalidateQueries({ queryKey: ["workforce"] });
        qc.invalidateQueries({ queryKey: ["workforce-detail"] });
        qc.invalidateQueries({ queryKey: ["vendor-quality"] });
        qc.invalidateQueries({ queryKey: ["scrap-events"] });
        qc.invalidateQueries({ queryKey: ["supply-orders-shortages"] });
        qc.invalidateQueries({ queryKey: ["shortage-forecast"] });
        qc.invalidateQueries({ queryKey: ["reorder-recs"] });
        qc.invalidateQueries({ queryKey: ["plan-catalog"] });
        qc.invalidateQueries({ queryKey: ["overstock"] });
        break;

      case "warehouse":
        qc.invalidateQueries({ queryKey: ["warehouse-status"] });
        qc.invalidateQueries({ queryKey: ["warehouse-active"] });
        qc.invalidateQueries({ queryKey: ["warehouse-damage-events"] });
        qc.invalidateQueries({ queryKey: ["warehouse-workforce"] });
        qc.invalidateQueries({ queryKey: ["warehouse-workforce-detail"] });
        qc.invalidateQueries({ queryKey: ["all-product-inventory"] });
        qc.invalidateQueries({ queryKey: ["product-inventory"] });
        qc.invalidateQueries({ queryKey: ["plan-catalog"] });
        break;

      case "supply-chain":
        // Debounce supply-chain events: during bulk reorder, hundreds of
        // po-created events arrive in rapid succession. Invalidating on each
        // one overwhelms the browser connection pool. Batch them into a single
        // invalidation after a 2s quiet window.
        if ((data.event as string) === "po-created") {
          supplyChainHasPoCreated.current = true;
        }
        if (supplyChainTimer.current) clearTimeout(supplyChainTimer.current);
        supplyChainTimer.current = setTimeout(() => {
          qc.invalidateQueries({ queryKey: ["supply-orders"] });
          qc.invalidateQueries({ queryKey: ["supply-orders-dashboard"] });
          qc.invalidateQueries({ queryKey: ["supply-order"] });
          qc.invalidateQueries({ queryKey: ["open-purchase-orders"] });
          qc.invalidateQueries({ queryKey: ["po-headers-all"] });
          qc.invalidateQueries({ queryKey: ["supply-catalog-all"] });
          qc.invalidateQueries({ queryKey: ["supply-catalog"] });
          if (supplyChainHasPoCreated.current) {
            qc.invalidateQueries({ queryKey: ["supply-orders-shortages"] });
            qc.invalidateQueries({ queryKey: ["manufacturing-status"] });
            supplyChainHasPoCreated.current = false;
          }
          supplyChainTimer.current = null;
        }, 2000);
        break;

      case "orders":
        qc.invalidateQueries({ queryKey: ["open-demand"] });
        break;

      case "shopping-simulator":
        qc.invalidateQueries({ queryKey: ["manufacturing-status"] });
        break;

      case "finance":
        qc.invalidateQueries({ queryKey: ["bank-status"] });
        qc.invalidateQueries({ queryKey: ["financial-summary"] });
        qc.invalidateQueries({ queryKey: ["recent-transactions"] });
        qc.invalidateQueries({ queryKey: ["procurement-transactions"] });
        qc.invalidateQueries({ queryKey: ["manufacturing-transactions"] });
        break;
    }
  });
}
