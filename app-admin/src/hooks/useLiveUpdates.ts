import { useEffect, useRef } from "react";
import { subscribeLiveUpdates, type LiveUpdate } from "@/lib/liveUpdates";

export function useLiveUpdates(
  groups: string[],
  refresh: () => Promise<unknown> | void,
  enabled = true,
  accepts?: (update: LiveUpdate) => boolean,
  subscriptionKey = "",
) {
  const refreshRef = useRef(refresh);
  const acceptsRef = useRef(accepts);
  refreshRef.current = refresh;
  acceptsRef.current = accepts;
  const groupsKey = groups.join(",");
  useEffect(() => {
    if (!enabled) return;
    return subscribeLiveUpdates(
      groupsKey.split(","),
      () => refreshRef.current(),
      update => acceptsRef.current?.(update) ?? true,
    );
  }, [groupsKey, enabled, subscriptionKey]);
}
