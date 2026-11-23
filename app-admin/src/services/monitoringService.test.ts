import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitoringService } from "./monitoringService";

const auth = vi.hoisted(() => ({ token: vi.fn(), current: true }));
vi.mock("./dabAuth", () => ({
  getFunctionsAccessToken: auth.token,
  getTabAuthorizationGeneration: () => "generation",
  isTabAuthorizationGenerationCurrent: () => auth.current,
}));
vi.mock("@/lib/utils", () => ({ getFunctionsApiUrl: () => "https://functions.example.test/" }));

describe("monitoring wire contract", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    auth.current = true;
    auth.token.mockReset().mockResolvedValue("resource-bound-token");
    vi.stubGlobal("fetch", vi.fn());
  });
  it("keeps resource-bound auth in headers and refuses failure-shaped empty snapshots", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 403 }));
    await expect(monitoringService.summary("1h")).rejects.toThrow("access denied");
    expect(fetch).toHaveBeenCalledWith("https://functions.example.test/api/monitoring/summary?range=1h", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer resource-bound-token" }) }));
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(monitoringService.summary("1h")).rejects.toThrow("unsupported format");
  });
  it("rejects stale sessions and malformed trace IDs before an HTTP request", async () => {
    auth.current = false;
    await expect(monitoringService.captures()).rejects.toThrow("session has changed");
    expect(fetch).not.toHaveBeenCalled();
    expect(() => monitoringService.trace("secret?code=credential")).toThrow("trace ID");
  });
  it("never turns an unavailable capture status into empty successful data", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 429 }));
    await expect(monitoringService.captures()).rejects.toThrow("throttled");
    auth.token.mockResolvedValue(null);
    await expect(monitoringService.captures()).rejects.toThrow("access denied");
  });
  it("accepts authorized captured summaries but drops unsupported private reasoning keys", async () => {
    const id = "a".repeat(32);
    const field = { text: "supported summary", originalBytes: 20, truncated: false, omitted: false };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      asOf: "2026-11-23T03:00:00Z", traceId: id, status: "available",
      source: { id: "trace", status: "available", asOf: "2026-11-23T03:00:00Z", reason: null, rows: [] },
      richContent: [{ spanId: "span", fields: { reasoningSummary: field, encryptedReasoning: { ...field, text: "private-marker" } } }],
    })));
    const result = await monitoringService.trace(id);
    expect(result.richContent?.[0].fields.reasoningSummary?.text).toBe("supported summary");
    expect(JSON.stringify(result)).not.toContain("private-marker");
  });
});
