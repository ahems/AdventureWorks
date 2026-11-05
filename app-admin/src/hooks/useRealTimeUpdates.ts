import { useWebPubSub } from "./useWebPubSub";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeLiveUpdates } from "@/lib/liveUpdates";

const GROUPS = [
  "orders",
  "warehouse",
  "shopping-simulator",
  "reviews",
  "promotions",
  "utilities",
];

const QUERY_KEYS: Record<string, string[][]> = {
  orders: [
    ["admin", "orders"], ["admin", "order"], ["admin", "store-orders"],
    ["admin", "stores"], ["admin", "shoppingCarts"], ["customer", "orders"],
    ["receipt-status"], ["order-lines"], ["reporting"], ["customer-stats"], ["dashboardStats"],
  ],
  warehouse: [
    ["admin", "inventory"], ["transactionHistory"], ["productTransactionHistory"],
    ["reporting", "inventory-by-category"], ["dashboardStats"],
  ],
  "shopping-simulator": [
    ["admin", "orders"], ["admin", "customers"], ["dashboardStats"], ["customer-stats"],
  ],
  reviews: [["admin", "reviews"], ["reviews"]],
  promotions: [["admin", "specialOffers"], ["admin", "specialOfferProducts"], ["reporting"]],
  utilities: [
    ["admin", "localizationCounts"], ["admin", "localizations"],
    ["admin", "productDescriptions"], ["admin", "productNames"],
  ],
};

/**
 * Subscribes to Web PubSub groups and dispatches custom events that
 * admin app pages can listen for to refresh their data.
 *
 * Status pages use useLiveUpdates to coalesce events into authorized reads.
 * Query-backed pages invalidate their domain caches from the same events.
 * Mount once at the app root.
 */
export function useRealTimeUpdates() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const subscriptions = Object.entries(QUERY_KEYS).map(([group, keys]) =>
      subscribeLiveUpdates([group], async () => {
        await Promise.all(keys.map(queryKey =>
          queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false }),
        ));
      }, () => true, false),
    );
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, [queryClient]);
  useWebPubSub(GROUPS, (group, data) => {
    // Dispatch a custom DOM event so any component can listen
    window.dispatchEvent(
      new CustomEvent("webpubsub", {
        detail: { ...data, group },
      }),
    );
  });
}
