export interface LiveUpdate {
  group: string;
  event?: string;
  instanceId?: string;
  jobId?: string;
}

/** Bounded event batching with at most one status read in flight. No idle requests. */
export function subscribeLiveUpdates(
  groups: string[],
  refresh: () => Promise<unknown> | void,
  accepts: (update: LiveUpdate) => boolean = () => true,
  initialRead = true,
) {
  let active = true;
  let running = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    timer = undefined;
    if (!active || running) return;
    running = true;
    dirty = false;
    try {
      await refresh();
    } catch (error) {
      console.error("[LiveUpdates] Refresh failed.", error);
    } finally {
      running = false;
      if (active && dirty) schedule();
    }
  };
  const schedule = () => {
    if (!active) return;
    dirty = true;
    if (!running && timer === undefined) timer = setTimeout(() => void flush(), 250);
  };
  const message = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const update: unknown = event.detail;
    if (typeof update !== "object" || update === null || !("group" in update) ||
        typeof update.group !== "string") return;
    const detail = update as LiveUpdate;
    if (groups.includes(detail.group) && accepts(detail)) schedule();
  };
  const focus = () => {
    if (document.visibilityState === "visible") schedule();
  };
  window.addEventListener("webpubsub", message);
  window.addEventListener("webpubsub-reconnected", schedule);
  window.addEventListener("focus", focus);
  // Subscribe before the initial read so changes during loading are not missed.
  if (initialRead) void flush();
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener("webpubsub", message);
    window.removeEventListener("webpubsub-reconnected", schedule);
    window.removeEventListener("focus", focus);
  };
}
