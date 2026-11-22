import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  hasSession: vi.fn(),
  getValidAccessToken: vi.fn(),
  getDabRole: vi.fn(),
  refreshAccessToken: vi.fn(),
  getTabAuthorizationGeneration: vi.fn(() => 1),
  isTabAuthorizationGenerationCurrent: vi.fn(() => true),
}));
vi.mock("@/services/dabAuth", () => auth);

import { dabFetch } from "@/services/dabFetch";

const headersOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers);

describe("dabFetch", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    auth.hasSession.mockReturnValue(true);
    auth.getValidAccessToken.mockResolvedValue("token-1");
    auth.getDabRole.mockReturnValue("sales-admin");
    auth.isTabAuthorizationGenerationCurrent.mockReturnValue(true);
  });

  it("attaches the bearer token and X-MS-API-ROLE header", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await dabFetch("https://dab/api/Product", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
    });

    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers.get("Authorization")).toBe("Bearer token-1");
    expect(headers.get("X-MS-API-ROLE")).toBe("sales-admin");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
  });

  it("strips auth headers when there is no session", async () => {
    auth.hasSession.mockReturnValue(false);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await dabFetch("https://dab/api/Product", {
      headers: { Authorization: "Bearer stale", "X-MS-API-ROLE": "x" },
    });

    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("X-MS-API-ROLE")).toBe(false);
    expect(auth.getValidAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP 401", () => new Response("", { status: 401 })],
    [
      "AUTH_NOT_AUTHENTICATED",
      () =>
        new Response('{"errors":[{"extensions":{"code":"AUTH_NOT_AUTHENTICATED"}}]}', {
          status: 200,
        }),
    ],
  ])("force-refreshes and retries once on %s", async (_label, rejected) => {
    fetchMock
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    auth.refreshAccessToken.mockResolvedValue("token-2");

    const res = await dabFetch("https://dab/graphql", { method: "POST" });

    expect(res.status).toBe(200);
    expect(auth.refreshAccessToken).toHaveBeenCalledWith(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchMock.mock.calls[1]).get("Authorization")).toBe("Bearer token-2");
  });

  it("fails loudly when the session cannot be renewed", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    auth.refreshAccessToken.mockResolvedValue(null);

    await expect(dabFetch("https://dab/api/Product")).rejects.toThrow(/session has expired/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects responses from a superseded sign-in", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    auth.isTabAuthorizationGenerationCurrent.mockReturnValue(false);

    await expect(dabFetch("https://dab/api/Product")).rejects.toThrow(/session has expired/);
  });
});
