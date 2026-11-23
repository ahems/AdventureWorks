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
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  return { key: parts.instrumentationkey, url: new URL("/v2.1/track", endpoint.origin).href };
}

export function beginTrace(header) {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header || "");
  const valid = match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2]);
  const traceId = valid ? match[1] : randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return { traceId, spanId, parentId: valid ? match[2] : null,
    traceparent: `00-${traceId}-${spanId}-${valid ? match[3] : "01"}` };
}

function duration(ms) {
  const total = Math.max(0, Math.round(ms));
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `00.${pad(Math.floor(total / 3600000))}:${pad(Math.floor(total / 60000) % 60)}:` +
    `${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}0000`;
}

export function createTelemetry(connectionString, { send = fetch, now = Date.now, role = "mcp-inspector",
  origin = "https://inspector.invalid", diagnostic = code => console.error(`Inspector telemetry: ${code}`),
  timeoutMs = 2000 } = {}) {
  const target = parseConnectionString(connectionString);
  const safeOrigin = new URL(origin).origin;
  const buffer = [];
  let timer = null;
  let pending = null;
  let lastDiagnostic = -Infinity;
  function report(code) {
    if (now() - lastDiagnostic < 60000) return;
    lastDiagnostic = now();
    try { diagnostic(code); } catch { /* Diagnostics cannot affect requests. */ }
  }
  async function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending) return pending;
    if (!target || buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    pending = (async () => {
      const controller = new AbortController();
      let timeout;
      try {
        const response = await Promise.race([
          send(target.url, { method: "POST", headers: { "Content-Type": "application/x-json-stream" },
            body: batch.map(item => JSON.stringify(item)).join("\n"), signal: controller.signal }),
          new Promise((_, reject) => { timeout = setTimeout(() => {
            controller.abort(); reject(new Error("timeout"));
          }, timeoutMs); }),
        ]);
        if (response && (!response.ok || response.status === 206)) report("export_rejected");
        void response?.body?.cancel()?.catch(() => report("export_failed"));
      } catch { report("export_failed"); }
      finally { clearTimeout(timeout); }
    })().finally(() => {
      pending = null;
      if (buffer.length && !timer) {
        timer = setTimeout(() => { void flush(); }, FLUSH_MS);
        timer.unref?.();
      }
    });
    return pending;
  }
  function enqueue(item) {
    if (buffer.length >= MAX_BUFFER) { buffer.shift(); report("buffer_dropped"); }
    buffer.push(item);
    if (!timer) {
      timer = setTimeout(() => { void flush(); }, FLUSH_MS);
      timer.unref?.();
    }
  }
  function track({ method, pathname, status, startedAt, traceparent, context = beginTrace(traceparent) }) {
    if (!target) return;
    const route = routeLabel(pathname);
    const finished = now();
    enqueue({
      name: "Microsoft.ApplicationInsights.Request", time: new Date(startedAt).toISOString(), iKey: target.key,
      tags: { "ai.cloud.role": role, "ai.operation.id": context.traceId,
        ...(context.parentId ? { "ai.operation.parentId": context.parentId } : {}),
        "ai.operation.name": `${method} ${route}` },
      data: { baseType: "RequestData", baseData: { ver: 2, id: context.spanId,
        name: `${method} ${route}`, url: safeOrigin + route, responseCode: String(status),
        success: status < 400, duration: duration(finished - startedAt) } },
    });
  }
  function dependency({ context, parent, method, target: upstream, status, startedAt, outcome }) {
    if (!target) return;
    const host = new URL(upstream).host;
    enqueue({
      name: "Microsoft.ApplicationInsights.RemoteDependency", time: new Date(startedAt).toISOString(), iKey: target.key,
      tags: { "ai.cloud.role": role, "ai.operation.id": context.traceId, "ai.operation.parentId": parent.spanId },
      data: { baseType: "RemoteDependencyData", baseData: { ver: 2, id: context.spanId,
        name: `${method} /mcp`, type: "Http", target: host, data: `https://${host}/mcp`,
        resultCode: String(status || 0), success: outcome === "completed" && status < 400,
        duration: duration(now() - startedAt), properties: { outcome } } },
    });
  }
  return { enabled: Boolean(target), track, dependency, flush };
}
