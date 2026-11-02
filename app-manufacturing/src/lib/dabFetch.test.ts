import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dabFetch, SESSION_EXPIRED_MESSAGE } from "./dabFetch";
import { getDabRole, getValidAccessToken, hasSession, refreshAccessToken } from "@/services/dabAuth";

vi.mock("@/services/dabAuth", () => ({
  getDabRole: vi.fn(),
  getValidAccessToken: vi.fn(),
  hasSession: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

describe("authenticated DAB fetch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(hasSession).mockReturnValue(true);
    vi.mocked(getValidAccessToken).mockResolvedValue("delegated-token");
    vi.mocked(getDabRole).mockReturnValue("manufacturing-engineer");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("attaches the OAuth bearer and DAB role without losing request options", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}"));
    const signal = new AbortController().signal;
    await dabFetch("/api/PurchaseOrderHeader", { signal, headers: { Accept: "application/json" } });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer delegated-token");
    expect(headers.get("X-MS-API-ROLE")).toBe("manufacturing-engineer");
    expect(headers.get("Accept")).toBe("application/json");
    expect(init?.signal).toBe(signal);
  });

  it("refreshes and retries once on 401 with the renewed token", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}"));
    vi.mocked(refreshAccessToken).mockResolvedValue("renewed-token");
    vi.mocked(getValidAccessToken)
      .mockResolvedValueOnce("expired-token")
      .mockResolvedValueOnce("renewed-token");
    await dabFetch("/api/WorkOrderRouting");
    expect(refreshAccessToken).toHaveBeenCalledWith(true);
    const headers = new Headers(vi.mocked(fetch).mock.calls[1][1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer renewed-token");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces session expiry when refresh fails", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 401 }));
    vi.mocked(refreshAccessToken).mockResolvedValue(null);
    await expect(dabFetch("/api/PurchaseOrderDetail")).rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
