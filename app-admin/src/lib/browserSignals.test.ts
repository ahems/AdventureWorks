import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrowserSignals } from "./browserSignals";

const vitals = vi.hoisted(() => ({ onCLS: vi.fn(), onINP: vi.fn(), onLCP: vi.fn() }));
vi.mock("web-vitals", () => vitals);

describe("non-invasive browser outcome reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("observes HTTP200 GraphQL errors without changing the response or retrying", async () => {
    const report = vi.fn();
    const response = new Response(JSON.stringify({ data: null, errors: [{ message: "private-marker" }] }), { headers: { "Content-Type": "application/json" } });
    const nativeFetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", nativeFetch);
    startBrowserSignals(report, ["localhost:3000"]);
    const result = await fetch("http://localhost:3000/graphql", { method: "POST" });
    expect(result).toBe(response);
    expect(await result.json()).toEqual({ data: null, errors: [{ message: "private-marker" }] });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith("browser.http-outcome", { operation: "/graphql", status: 200, outcome: "graphql-error" }));
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report.mock.calls)).not.toContain("private-marker");
  });
  it("separates cancellation and throttling and ignores third-party requests", async () => {
    const report = vi.fn();
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockRejectedValueOnce(new DOMException("private-marker", "AbortError"))
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", nativeFetch);
    startBrowserSignals(report, ["localhost:3000"]);
    await fetch("http://localhost:3000/api/orders/123?token=marker");
    await expect(fetch("http://localhost:3000/api/orders/123")).rejects.toHaveProperty("name", "AbortError");
    await fetch("https://third-party.example.test/");
    expect(report).toHaveBeenCalledWith("browser.http-outcome", { operation: "/api/orders/:id", status: 429, outcome: "throttled" });
    expect(report).toHaveBeenCalledWith("browser.http-outcome", { operation: "/api/orders/:id", outcome: "cancelled" });
    expect(report.mock.calls.filter(([name]) => name === "browser.http-outcome")).toHaveLength(2);
  });
  it("emits one finite vital per document and labels unsupported measurements unavailable", () => {
    const report = vi.fn();
    vi.stubGlobal("fetch", vi.fn());
    startBrowserSignals(report, []);
    const record = vitals.onLCP.mock.calls[0][0];
    record({ name: "LCP", value: 1200 });
    record({ name: "LCP", value: 1300 });
    vitals.onINP.mock.calls[0][0]({ name: "INP", value: NaN });
    window.dispatchEvent(new Event("pagehide"));
    expect(report.mock.calls.filter(([, fields]) => fields.metric === "LCP")).toHaveLength(1);
    expect(report).toHaveBeenCalledWith("browser.web-vital", { metric: "INP", availability: "unavailable" });
    expect(report).toHaveBeenCalledWith("browser.web-vital", { metric: "CLS", availability: "unavailable" });
  });
  it("preserves failed HTTP responses even when the telemetry sink throws", async () => {
    const response = new Response("", { status: 503 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    startBrowserSignals(() => { throw new Error("Exporter unavailable"); }, ["localhost:3000"]);
    await expect(fetch("http://localhost:3000/api/orders")).resolves.toBe(response);
  });
});
