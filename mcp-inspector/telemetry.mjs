// Minimal Application Insights request telemetry for the Inspector gateway. Only the method, a fixed
// route label, status and duration leave the process: never query strings (OAuth codes/state),
// headers, cookies or bodies. Ingestion uses the shared connection string (documented exception).
import { randomBytes } from "node:crypto";

const ROUTES = new Set(["/", "/health", "/auth/login", "/auth/logout", "/oauth/callback", "/inspector",
  "/proxy/health", "/proxy/config", "/proxy/mcp"]);
const FLUSH_MS = 5000;
const MAX_BUFFER = 500;

export function routeLabel(pathname) {
  if (ROUTES.has(pathname)) return pathname;
  if (pathname.startsWith("/proxy/")) return "/proxy/*";
  return "/assets/*";
}

export function parseConnectionString(value) {
  if (!value) return null;
  const parts = Object.fromEntries(value.split(";").filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()];
  }));
  if (!/^[0-9a-f-]{36}$/i.test(parts.instrumentationkey || "")) return null;
  let endpoint;
  try {
    endpoint = new URL(parts.ingestionendpoint || "https://dc.services.visualstudio.com/");
  } catch {
    return null;
  }
  if (endpoint.protocol !== "https:") return null;
  return { key: parts.instrumentationkey, url: new URL("v2.1/track", endpoint.href.replace(/\/?$/, "/")).href };
}

function traceId(header) {
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(header || "");
  return match && !/^0+$/.test(match[1]) ? match[1] : randomBytes(16).toString("hex");
}

function duration(ms) {
  const total = Math.max(0, Math.round(ms));
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `00.${pad(Math.floor(total / 3600000))}:${pad(Math.floor(total / 60000) % 60)}:` +
    `${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}0000`;
}

export function createTelemetry(connectionString, { send = fetch, now = Date.now, role = "mcp-inspector",
  origin = "https://inspector.invalid" } = {}) {
  const target = parseConnectionString(connectionString);
  const buffer = [];
  let timer = null;
  async function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!target || buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    try {
      await send(target.url, { method: "POST", headers: { "Content-Type": "application/x-json-stream" },
        body: batch.map(item => JSON.stringify(item)).join("\n") });
    } catch {
      // Telemetry is best-effort; request handling never depends on it.
    }
  }
  function track({ method, pathname, status, startedAt, traceparent }) {
    if (!target) return;
    const route = routeLabel(pathname);
    const finished = now();
    if (buffer.length >= MAX_BUFFER) buffer.shift();
    buffer.push({
      name: "Microsoft.ApplicationInsights.Request", time: new Date(startedAt).toISOString(), iKey: target.key,
      tags: { "ai.cloud.role": role, "ai.operation.id": traceId(traceparent), "ai.operation.name": `${method} ${route}` },
      data: { baseType: "RequestData", baseData: { ver: 2, id: randomBytes(8).toString("hex"),
        name: `${method} ${route}`, url: origin + route, responseCode: String(status),
        success: status < 500, duration: duration(finished - startedAt) } },
    });
    if (!timer) {
      timer = setTimeout(() => { void flush(); }, FLUSH_MS);
      timer.unref?.();
    }
  }
  return { enabled: Boolean(target), track, flush };
}
