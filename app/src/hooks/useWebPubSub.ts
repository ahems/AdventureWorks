import { useEffect, useRef } from "react";
import { WebPubSubClient } from "@azure/web-pubsub-client";

/**
 * Connects to Azure Web PubSub and subscribes to the specified groups.
 * Calls `onMessage` when a server-sent group message arrives.
 *
 * Gracefully no-ops if the negotiate endpoint is unavailable (local dev
 * without Web PubSub) — the app falls back to polling intervals.
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

    async function connect() {
      try {
        const functionsUrl =
          (typeof window !== "undefined" &&
            (window as Window & { APP_CONFIG?: { API_FUNCTIONS_URL?: string } })
              .APP_CONFIG?.API_FUNCTIONS_URL) ||
          import.meta.env.VITE_API_FUNCTIONS_URL ||
          "http://localhost:7071";
        const negotiateUrl =
          functionsUrl.replace(/\/$/, "") + "/api/webpubsub/negotiate";

        const res = await fetch(
          `${negotiateUrl}?groups=${encodeURIComponent(groupsKey)}`,
        );
        if (!res.ok) {
          console.warn(
            "[WebPubSub] Negotiate failed:",
            res.status,
            "— falling back to polling.",
          );
          return;
        }
        const { url } = (await res.json()) as { url: string };
        if (cancelled || !url) return;

        client = new WebPubSubClient(url);

        client.on("group-message", (e) => {
          const data =
            typeof e.message.data === "string"
              ? (JSON.parse(e.message.data) as Record<string, unknown>)
              : (e.message.data as Record<string, unknown>);
          onMessageRef.current(e.message.group, data);
        });

        await client.start();
        // Groups are auto-joined via the negotiate token — no joinGroup needed
      } catch (err) {
        console.warn(
          "[WebPubSub] Connection failed — falling back to polling.",
          err,
        );
      }
    }

    connect();

    return () => {
      cancelled = true;
      client?.stop();
    };
  }, [groupsKey]);
}
