import { useWebPubSub } from "./useWebPubSub";

const GROUPS = [
  "orders",
  "warehouse",
  "shopping-simulator",
  "reviews",
  "promotions",
];

/**
 * Subscribes to Web PubSub groups and dispatches custom events that
 * admin app pages can listen for to refresh their data.
 *
 * Admin app uses setInterval-based polling (not React Query) for most
 * pages, so we dispatch DOM events that individual pages can subscribe to.
 * Mount once at the app root.
 */
export function useRealTimeUpdates() {
  useWebPubSub(GROUPS, (group, data) => {
    // Dispatch a custom DOM event so any component can listen
    window.dispatchEvent(
      new CustomEvent("webpubsub", {
        detail: { group, ...data },
      }),
    );
  });
}
