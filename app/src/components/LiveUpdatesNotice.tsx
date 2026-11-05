import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getWebPubSubStatus, subscribeWebPubSubStatus } from "@/hooks/useWebPubSub";

export function LiveUpdatesNotice() {
  const status = useSyncExternalStore(subscribeWebPubSubStatus, getWebPubSubStatus);
  const { t } = useTranslation();
  if (status === "connected") return null;
  return (
    <div role="status" className="bg-amber-50 px-4 py-2 text-sm text-amber-900">
      {status === "connecting"
        ? t("liveUpdates.connecting", "Connecting live updates...")
        : t("liveUpdates.unavailable", "Live updates unavailable. Data may be stale; returning to this tab refreshes active views.")}
    </div>
  );
}
