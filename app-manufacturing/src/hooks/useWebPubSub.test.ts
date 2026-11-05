import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebPubSub } from "./useWebPubSub";

const { sdk } = vi.hoisted(() => ({
  sdk: {
    handlers: {} as Record<string, (data?: unknown) => void>,
    credential: null as { getClientAccessUrl: () => Promise<string> } | null,
    start: vi.fn(),
    stop: vi.fn(),
  },
}));
vi.mock("@azure/web-pubsub-client", () => ({
  WebPubSubClient: class {
    constructor(credential: typeof sdk.credential) { sdk.credential = credential; }
    on(event: string, handler: (data?: unknown) => void) { sdk.handlers[event] = handler; }
    start = sdk.start;
    stop = sdk.stop;
  },
}));
vi.mock("@/config/api", () => ({ WEB_PUBSUB_NEGOTIATE_URL: "/api/webpubsub/negotiate" }));

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("push connection lifecycle without polling fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sdk.handlers = {};
    sdk.start.mockReset().mockImplementation(async () => {
      await sdk.credential?.getClientAccessUrl();
      sdk.handlers.connected();
    });
    sdk.stop.mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ url: "wss://example.test/client" }),
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("catches up after subscribing and reconnecting, but never polls while idle", async () => {
    const onConnected = vi.fn();
    const { result, unmount } = renderHook(() => useWebPubSub(["warehouse"], vi.fn(), onConnected));
    await settle();
    expect(result.current).toBe("live");
    expect(onConnected).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(600_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => sdk.handlers.disconnected());
    expect(result.current).toBe("reconnecting");
    await act(async () => {
      await sdk.credential?.getClientAccessUrl();
      sdk.handlers.connected();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onConnected).toHaveBeenCalledTimes(2);
    unmount();
    expect(sdk.stop).toHaveBeenCalledTimes(1);
    act(() => sdk.handlers.connected());
    expect(onConnected).toHaveBeenCalledTimes(2);
  });

  it("shows unavailable when negotiation fails, with no request fallback", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
    const onConnected = vi.fn();
    const { result, unmount } = renderHook(() => useWebPubSub(["warehouse"], vi.fn(), onConnected));
    await settle();
    expect(result.current).toBe("unavailable");
    act(() => vi.advanceTimersByTime(600_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    unmount();
  });

  it("surfaces stopped connections and safely ignores malformed messages", async () => {
    const onMessage = vi.fn();
    const { result, unmount } = renderHook(() => useWebPubSub(["warehouse"], onMessage));
    await settle();
    act(() => {
      sdk.handlers["group-message"]({ message: { group: "warehouse", data: "invalid json" } });
      sdk.handlers["group-message"]({ message: { group: "warehouse", data: "null" } });
      sdk.handlers["group-message"]({ message: { group: "warehouse", data: [] } });
      sdk.handlers["group-message"]({ message: { group: "warehouse", data: '{"event":"database-changed"}' } });
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith("warehouse", { event: "database-changed" });
    expect(console.warn).toHaveBeenCalledTimes(3);
    act(() => sdk.handlers.stopped());
    expect(result.current).toBe("unavailable");
    unmount();
    act(() => sdk.handlers["group-message"]({ message: { group: "warehouse", data: {} } }));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("aborts negotiation and suppresses snapshot callbacks after unmount", async () => {
    let finish: (response: Response) => void = () => {};
    vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onConnected = vi.fn();
    const { unmount } = renderHook(() => useWebPubSub(["warehouse"], vi.fn(), onConnected));
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    finish({ ok: true, json: async () => ({ url: "wss://example.test/client" }) } as Response);
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    expect(sdk.stop).toHaveBeenCalledTimes(1);
  });
});
