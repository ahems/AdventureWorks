import { useQueryClient } from "@tanstack/react-query";
import { useWebPubSub } from "./useWebPubSub";

const GROUPS = [
  "manufacturing-agent",
  "manufacturing-ops",
  "warehouse",
  "supply-chain",
  "orders",
  "shopping-simulator",
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
        qc.invalidateQueries({ queryKey: ["all-recent-wos"] });
        qc.invalidateQueries({ queryKey: ["recent-routings"] });
        qc.invalidateQueries({ queryKey: ["workforce-snapshot"] });
        qc.invalidateQueries({ queryKey: ["workforce"] });
        qc.invalidateQueries({ queryKey: ["workforce-detail"] });
        break;

      case "warehouse":
        qc.invalidateQueries({ queryKey: ["warehouse-status"] });
        qc.invalidateQueries({ queryKey: ["warehouse-active"] });
        qc.invalidateQueries({ queryKey: ["warehouse-damage-events"] });
        qc.invalidateQueries({ queryKey: ["warehouse-workforce"] });
        qc.invalidateQueries({ queryKey: ["warehouse-workforce-detail"] });
        qc.invalidateQueries({ queryKey: ["all-product-inventory"] });
        qc.invalidateQueries({ queryKey: ["product-inventory"] });
        break;

      case "supply-chain":
        qc.invalidateQueries({ queryKey: ["supply-orders"] });
        qc.invalidateQueries({ queryKey: ["supply-orders-dashboard"] });
        qc.invalidateQueries({ queryKey: ["supply-order"] });
        qc.invalidateQueries({ queryKey: ["open-purchase-orders"] });
        qc.invalidateQueries({ queryKey: ["po-headers-all"] });
        qc.invalidateQueries({ queryKey: ["supply-catalog-all"] });
        break;

      case "orders":
        qc.invalidateQueries({ queryKey: ["open-demand"] });
        break;

      case "shopping-simulator":
        qc.invalidateQueries({ queryKey: ["manufacturing-status"] });
        break;
    }
  });
}
