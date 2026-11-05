import { useEffect, useRef } from "react";
import { WebPubSubClient } from "@azure/web-pubsub-client";
import { getWebPubSubNegotiateUrl } from "@/lib/utils";

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
 * Reports push availability; pages recover on reconnect/focus, never by polling.
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
        const negotiateUrl = getWebPubSubNegotiateUrl();
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
        client.on("connected", () => {
          if (cancelled) return;
          setStatus("connected");
          window.dispatchEvent(new Event("webpubsub-reconnected"));
        });
        client.on("disconnected", () => setStatus("disconnected"));
        client.on("stopped", () => setStatus("disconnected"));
        client.on("rejoin-group-failed", () => {
          setStatus("failed");
          console.warn("[WebPubSub] Failed to rejoin a subscribed group.");
        });

        client.on("group-message", (e) => {
          if (cancelled) return;
          let data: unknown = e.message.data;
          if (typeof data === "string") {
            try {
              data = JSON.parse(data);
            } catch (error) {
              console.warn("[WebPubSub] Invalid JSON group message.", error);
              return;
            }
          }
          if (typeof data !== "object" || data === null || Array.isArray(data)) {
            console.warn("[WebPubSub] Group message must be an object.");
            return;
          }
          onMessageRef.current(e.message.group, data as Record<string, unknown>);
        });

        await client.start({ abortSignal: controller.signal });
        // Groups are auto-joined via the negotiate token — no joinGroup needed
      } catch (err) {
        if (cancelled) return;
        setStatus("failed");
        console.warn(
          "[WebPubSub] Connection failed — live updates unavailable.",
          err,
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
