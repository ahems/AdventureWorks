import { useSyncExternalStore } from "react";
import { getWebPubSubStatus, subscribeWebPubSubStatus } from "@/hooks/useWebPubSub";

export function LiveUpdatesNotice() {
  const status = useSyncExternalStore(subscribeWebPubSubStatus, getWebPubSubStatus);
  if (status === "connected") return null;
  return (
    <div role="status" className="bg-amber-50 px-4 py-2 text-sm text-amber-900">
      {status === "connecting"
        ? "Connecting live updates..."
        : "Live updates unavailable. Data may be stale; returning to this tab refreshes active views."}
    </div>
  );
}
