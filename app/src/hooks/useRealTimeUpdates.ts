import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useWebPubSub } from "./useWebPubSub";

const GROUPS = ["orders"];

/**
 * Subscribes to Web PubSub and invalidates React Query caches when
 * the server pushes real-time events. Mount once at the app root.
 */
export function useRealTimeUpdates() {
  const qc = useQueryClient();
  const scheduleRefresh = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let running = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      timer = undefined;
      if (!active) return;
      running = true;
      dirty = false;
      try {
        await qc.invalidateQueries({ queryKey: ["shoppingCart"] }, { cancelRefetch: false });
      } finally {
        running = false;
        if (active && dirty) schedule();
      }
    };
    const schedule = () => {
      dirty = true;
      if (active && !running && timer === undefined) timer = setTimeout(() => void flush(), 250);
    };
    scheduleRefresh.current = schedule;
    return () => {
      active = false;
      scheduleRefresh.current = () => {};
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [qc]);
  const refreshCart = () => scheduleRefresh.current();
  useWebPubSub(GROUPS, (group) => {
    if (group === "orders") {
      refreshCart();
    }
  }, refreshCart);
}
