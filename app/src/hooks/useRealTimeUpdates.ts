import { useQueryClient } from "@tanstack/react-query";
import { useWebPubSub } from "./useWebPubSub";

const GROUPS = ["orders"];

/**
 * Subscribes to Web PubSub and invalidates React Query caches when
 * the server pushes real-time events. Mount once at the app root.
 */
export function useRealTimeUpdates() {
  const qc = useQueryClient();

  useWebPubSub(GROUPS, (group) => {
    if (group === "orders") {
      qc.invalidateQueries({ queryKey: ["shoppingCart"] });
    }
  });
}
