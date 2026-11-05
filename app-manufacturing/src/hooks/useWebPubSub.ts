import { useEffect, useRef, useState } from "react";
import { WebPubSubClient } from "@azure/web-pubsub-client";
import { WEB_PUBSUB_NEGOTIATE_URL } from "@/config/api";

/**
 * Connects to Azure Web PubSub and subscribes to the specified groups.
 * Calls `onMessage` when a server-sent group message arrives.
 *
 * An unavailable connection is surfaced to the UI; there is no polling fallback.
 */
export function useWebPubSub(
  groups: string[],
  onMessage: (group: string, data: Record<string, unknown>) => void,
  onConnected?: () => void,
) {
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting" | "unavailable">("connecting");
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const groupsKey = groups.join(",");

  useEffect(() => {
    let cancelled = false;
    const abortController = new AbortController();
    setStatus("connecting");

    const client = new WebPubSubClient({
      // Renew the negotiate token on reconnect rather than reusing an expired URL.
      getClientAccessUrl: async () => {
        const res = await fetch(
          `${WEB_PUBSUB_NEGOTIATE_URL}?groups=${encodeURIComponent(groupsKey)}`,
          { signal: abortController.signal },
        );
        if (!res.ok) throw new Error(`Negotiate failed: ${res.status}`);
        const { url } = (await res.json()) as { url: string };
        if (!url || cancelled) throw new Error("Push unavailable");
        return url;
      },
    });

    client.on("connected", () => {
      if (cancelled) return;
      setStatus("live");
      onConnectedRef.current?.();
    });
    client.on("disconnected", () => {
      if (!cancelled) setStatus("reconnecting");
    });
    client.on("stopped", () => {
      if (!cancelled) setStatus("unavailable");
    });
    client.on("rejoin-group-failed", () => {
      if (!cancelled) setStatus("unavailable");
    });
    client.on("group-message", (e) => {
      if (cancelled) return;
      try {
        const data =
          typeof e.message.data === "string"
            ? JSON.parse(e.message.data)
            : e.message.data;
        if (data && typeof data === "object" && !Array.isArray(data)) {
          onMessageRef.current(e.message.group, data as Record<string, unknown>);
        } else {
          console.warn("[WebPubSub] Ignoring non-object group message");
        }
      } catch (err) {
        console.warn("[WebPubSub] Invalid message", err);
      }
    });

    async function connect() {
      try {
        await client.start();
      } catch (err) {
        if (cancelled) return;
        setStatus("unavailable");
        console.warn("[WebPubSub] Connection failed — data may be stale.", err);
      }
    }

    connect();

    return () => {
      cancelled = true;
      abortController.abort();
      client.stop();
    };
  }, [groupsKey]);

  return status;
}
