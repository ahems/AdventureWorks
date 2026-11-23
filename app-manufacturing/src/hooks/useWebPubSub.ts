import { useEffect, useRef, useState } from "react";
import { WebPubSubClient } from "@azure/web-pubsub-client";
import { WEB_PUBSUB_NEGOTIATE_URL } from "@/config/api";
import { trackEvent } from "@/lib/appInsights";
import {
  getFunctionsAccessToken,
  getTabAuthorizationGeneration,
  isTabAuthorizationGenerationCurrent,
} from "@/services/dabAuth";

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
    const generation = getTabAuthorizationGeneration();
    const subscribedGroups = new Set(groupsKey.split(",").filter(Boolean));
    let cancelled = false;
    const abortController = new AbortController();
    let lastOutcome = "connecting";
    const reportStatus = (outcome: "connecting" | "live" | "reconnecting" | "unavailable") => {
      if (outcome !== lastOutcome) trackEvent("browser.realtime-outcome", { outcome });
      lastOutcome = outcome;
      setStatus(outcome);
    };
    setStatus("connecting");

    const client = new WebPubSubClient({
      // Renew the negotiate token on reconnect rather than reusing an expired URL.
      getClientAccessUrl: async () => {
        const ensureSession = () => {
          if (!isTabAuthorizationGenerationCurrent(generation)) {
            throw new Error("The live-updates session has changed.");
          }
        };
        ensureSession();
        const accessToken = await getFunctionsAccessToken();
        ensureSession();
        if (!accessToken) throw new Error("Functions authorization is required for live updates.");
        const res = await fetch(
          WEB_PUBSUB_NEGOTIATE_URL,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: abortController.signal,
          },
        );
        ensureSession();
        if (!res.ok) throw new Error(`Negotiate failed: ${res.status}`);
        const { url } = (await res.json()) as { url: string };
        ensureSession();
        if (!url || cancelled) throw new Error("Push unavailable");
        return url;
      },
    });

    client.on("connected", () => {
      if (cancelled || !isTabAuthorizationGenerationCurrent(generation)) return;
      reportStatus("live");
      onConnectedRef.current?.();
    });
    client.on("disconnected", () => {
      if (!cancelled && isTabAuthorizationGenerationCurrent(generation)) reportStatus("reconnecting");
    });
    client.on("stopped", () => {
      if (!cancelled && isTabAuthorizationGenerationCurrent(generation)) reportStatus("unavailable");
    });
    client.on("rejoin-group-failed", () => {
      if (!cancelled && isTabAuthorizationGenerationCurrent(generation)) trackEvent("browser.realtime-outcome", { outcome: "rejoin-failed" });
      if (!cancelled && isTabAuthorizationGenerationCurrent(generation)) reportStatus("unavailable");
    });
    client.on("group-message", (e) => {
      if (cancelled || !isTabAuthorizationGenerationCurrent(generation) || !subscribedGroups.has(e.message.group)) return;
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
        if (!isTabAuthorizationGenerationCurrent(generation)) {
          reportStatus("unavailable");
          await client.stop();
        }
      } catch (err) {
        if (cancelled) return;
        reportStatus("unavailable");
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
