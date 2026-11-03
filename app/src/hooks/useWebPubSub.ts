import { useEffect, useRef } from "react";
import { WebPubSubClient } from "@azure/web-pubsub-client";
import { getFunctionsApiUrl } from "@/lib/utils";

export type WebPubSubStatus = "connecting" | "connected" | "disconnected" | "failed" | "not-configured";
let connectionStatus: WebPubSubStatus = "connecting";
const statusListeners = new Set<() => void>();

export const getWebPubSubStatus = () => connectionStatus;
export function subscribeWebPubSubStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

function publishStatus(status: WebPubSubStatus) {
  connectionStatus = status;
  statusListeners.forEach(listener => listener());
}

/**
 * Connects to Azure Web PubSub and subscribes to the specified groups.
 * Calls `onMessage` when a server-sent group message arrives.
 *
 * Reports the existing connection to diagnostics without opening another socket.
 * If push is unavailable, React Query's normal focus refetch remains the fallback.
 */
export function useWebPubSub(
  groups: string[],
  onMessage: (group: string, data: Record<string, unknown>) => void,
) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const groupsKey = groups.join(",");

  useEffect(() => {
    let client: WebPubSubClient | null = null;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const setStatus = (status: WebPubSubStatus) => { if (!cancelled) publishStatus(status); };
    setStatus("connecting");

    async function connect() {
      try {
        const functionsUrl = getFunctionsApiUrl();
        const negotiateUrl =
          functionsUrl.replace(/\/$/, "") + "/api/webpubsub/negotiate";

        const res = await fetch(
          `${negotiateUrl}?groups=${encodeURIComponent(groupsKey)}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          console.warn(
            "[WebPubSub] Negotiate failed:",
            res.status,
            "— live updates unavailable.",
          );
          setStatus(res.status === 503 ? "not-configured" : "failed");
          return;
        }
        const { url } = (await res.json()) as { url: string };
        if (cancelled) return;
        if (!url || typeof url !== "string") throw new Error("Invalid Web PubSub negotiate response.");

        client = new WebPubSubClient(url);
        client.on("connected", () => setStatus("connected"));
        client.on("disconnected", () => setStatus("disconnected"));
        client.on("stopped", () => setStatus("disconnected"));
        client.on("rejoin-group-failed", () => {
          console.warn("[WebPubSub] Failed to rejoin a subscribed group; live updates may be incomplete.");
          setStatus("failed");
        });

        client.on("group-message", (e) => {
          const data =
            typeof e.message.data === "string"
              ? (JSON.parse(e.message.data) as Record<string, unknown>)
              : (e.message.data as Record<string, unknown>);
          onMessageRef.current(e.message.group, data);
        });

        await client.start({ abortSignal: controller.signal });
        // Groups are auto-joined via the negotiate token — no joinGroup needed
      } catch (err) {
        if (cancelled) return;
        setStatus("failed");
        console.warn(
          "[WebPubSub] Connection failed — live updates unavailable.",
          err instanceof Error ? err.name : "Unknown error",
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
      client?.stop();
    };
  }, [groupsKey]);
}
