import { onCLS, onINP, onLCP } from "web-vitals";
import { classifyFailure, routeTemplate } from "./telemetrySafety";

type Report = (name: string, properties: Record<string, unknown>) => void;

export function startBrowserSignals(report: Report, ownDomains: string[]): void {
  const emit = report;
  report = (name, properties) => { try { emit(name, properties); } catch { /* Telemetry cannot change application outcomes. */ } };
  const observed = new Set<string>();
  const vital = ({ name, value }: { name: string; value: number }) => {
    if (!Number.isFinite(value) || observed.has(name)) return;
    observed.add(name);
    report("browser.web-vital", { metric: name, value, availability: "available", route: routeTemplate(location.pathname) });
  };
  try { onLCP(vital); onINP(vital); onCLS(vital); } catch { /* Unsupported browser; report unavailable on page hide. */ }
  const reportNavigation = () => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navigation?.loadEventEnd) report("browser.navigation", { durationMs: navigation.duration, responseMs: navigation.responseStart, availability: "available" });
    else report("browser.navigation", { availability: "unavailable" });
  };
  if (document.readyState === "complete") reportNavigation();
  else window.addEventListener("load", () => setTimeout(reportNavigation, 0), { once: true });
  window.addEventListener("pagehide", () => {
    for (const metric of ["LCP", "INP", "CLS"]) {
      if (!observed.has(metric)) report("browser.web-vital", { metric, availability: "unavailable" });
    }
  }, { once: true });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    let url: URL;
    try { url = new URL(rawUrl, location.href); } catch { return nativeFetch(input, init); }
    if (!ownDomains.includes(url.host)) return nativeFetch(input, init);
    const operation = routeTemplate(url.pathname);
    try {
      const response = await nativeFetch(input, init);
      if (!response.ok) report("browser.http-outcome", { operation, status: response.status, outcome: classifyFailure({ status: response.status }) });
      if (response.ok && /\/graphql\/?$/.test(url.pathname) && response.headers.get("content-type")?.includes("json")) {
        void inspectGraphQL(response.clone(), report, operation);
      }
      return response;
    } catch (error) {
      report("browser.http-outcome", { operation, outcome: error instanceof TypeError ? "network-failure" : classifyFailure(error) });
      throw error;
    }
  };
}

async function inspectGraphQL(response: Response, report: Report, operation: string) {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) { void reader.cancel().catch(() => {}); return; }
      chunks.push(value);
    }
    const payload = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder().decode(payload);
    const result = JSON.parse(text) as { errors?: unknown[] };
    if (Array.isArray(result.errors) && result.errors.length)
      report("browser.http-outcome", { operation, status: 200, outcome: "graphql-error" });
  } catch { /* A response body remains owned by its caller, including parse failures. */ }
  finally { reader.releaseLock(); }
}
