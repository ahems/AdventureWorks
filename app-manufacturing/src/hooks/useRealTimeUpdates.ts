import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
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
 * Manufacturing bursts are batched without postponing refreshes indefinitely.
 */
export function useRealTimeUpdates() {
  const qc = useQueryClient();
  const manufacturingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supplyChainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supplyChainHasPoCreated = useRef(false);

  useEffect(() => () => {
    if (manufacturingTimer.current) clearTimeout(manufacturingTimer.current);
    if (supplyChainTimer.current) clearTimeout(supplyChainTimer.current);
  }, []);

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
        // A fixed window keeps continuous operation events from starving updates.
        if (manufacturingTimer.current) break;
        manufacturingTimer.current = setTimeout(() => {
          manufacturingTimer.current = null;
          for (const key of [
            "manufacturing-status",
            "manufacturing-active",
            "active-operations",
            "work-orders",
            "work-order",
            "work-orders-active",
            "all-recent-wos",
            "recent-routings",
            "wo-routing",
            "all-routing",
            "workforce-snapshot",
            "workforce",
            "workforce-detail",
            "vendor-quality",
            "scrap-events",
            "supply-orders-shortages",
            "shortage-forecast",
            "reorder-recs",
            "plan-catalog",
            "overstock",
          ]) {
            // Reuse an in-flight read instead of restarting it on every burst.
            qc.invalidateQueries({ queryKey: [key] }, { cancelRefetch: false });
          }
        }, 2000);
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
