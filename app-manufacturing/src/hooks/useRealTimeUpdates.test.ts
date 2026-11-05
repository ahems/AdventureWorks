import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GROUP_QUERY_KEYS, useRealTimeUpdates } from "./useRealTimeUpdates";

const { subscription } = vi.hoisted(() => ({
  subscription: {
    onMessage: null as ((group: string, data: Record<string, unknown>) => void) | null,
    onConnected: null as (() => void) | null,
  },
}));

vi.mock("./useWebPubSub", () => ({
  useWebPubSub: (
    _groups: string[],
    onMessage: typeof subscription.onMessage,
    onConnected: typeof subscription.onConnected,
  ) => {
    subscription.onMessage = onMessage;
    subscription.onConnected = onConnected;
    return "live";
  },
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(useRealTimeUpdates, { wrapper });
  return { ...hook, client, invalidateQueries, wrapper };
}

function emit(group = "manufacturing-ops", event = "wo-completed") {
  act(() => subscription.onMessage?.(group, { event }));
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("manufacturing real-time refresh batching", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("makes no recurring requests when no push event arrives", async () => {
    const { wrapper, invalidateQueries, unmount } = setup();
    const request = vi.fn().mockResolvedValue([]);
    const query = renderHook(() => useQuery({
      queryKey: ["work-orders"], queryFn: request,
    }), { wrapper });
    await act(async () => { await Promise.resolve(); });
    expect(request).toHaveBeenCalledTimes(1);
    await advance(600_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).not.toHaveBeenCalled();
    query.unmount();
    unmount();
  });

  it("coalesces bursts into one refresh per query after two seconds", async () => {
    const { unmount, invalidateQueries } = setup();
    for (let i = 0; i < 100; i++) emit();
    await advance(1999);
    expect(invalidateQueries).not.toHaveBeenCalled();
    await advance(1);
    const count = new Set(GROUP_QUERY_KEYS["manufacturing-ops"]).size;
    expect(invalidateQueries).toHaveBeenCalledTimes(count);
    for (const key of ["work-orders", "instruction-bom", "instruction-components", "active-bom", "product"]) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: [key] }, { cancelRefetch: false });
    }
    await advance(10000);
    expect(invalidateQueries).toHaveBeenCalledTimes(count);
    unmount();
  });

  it("retains one dirty follow-up when mutations arrive during an event-triggered read", async () => {
    const { wrapper, unmount } = setup();
    const finish: ((data: number[]) => void)[] = [];
    const request = vi.fn(() => new Promise<number[]>((resolve) => finish.push(resolve)));
    const query = renderHook(() => useQuery({
      queryKey: ["work-orders"], queryFn: request,
    }), { wrapper });
    await act(async () => { finish[0]([0]); });
    emit();
    await advance(2000);
    expect(request).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 100; i++) emit();
    await advance(10_000);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { finish[1]([1]); });
    expect(request).toHaveBeenCalledTimes(3);
    await act(async () => { finish[2]([2]); });
    await advance(60_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(query.result.current.data).toEqual([2]);
    query.unmount();
    unmount();
  });

  it("follows an initial in-flight read with a fresh post-mutation snapshot", async () => {
    const { wrapper, unmount } = setup();
    const finish: ((data: number[]) => void)[] = [];
    const request = vi.fn(() => new Promise<number[]>((resolve) => finish.push(resolve)));
    const query = renderHook(() => useQuery({
      queryKey: ["work-orders"], queryFn: request,
    }), { wrapper });
    emit();
    await advance(2000);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { finish[0]([0]); });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { finish[1]([1]); });
    await advance(60_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(query.result.current.data).toEqual([1]);
    query.unmount();
    unmount();
  });

  it("discards dirty follow-ups when unmounted during a read", async () => {
    const { wrapper, unmount } = setup();
    let finish: (data: number[]) => void = () => {};
    const request = vi.fn(() => new Promise<number[]>((resolve) => { finish = resolve; }));
    const query = renderHook(() => useQuery({
      queryKey: ["work-orders"], queryFn: request,
    }), { wrapper });
    emit();
    await advance(2000);
    emit();
    unmount();
    await act(async () => { finish([0]); });
    await advance(60_000);
    expect(request).toHaveBeenCalledTimes(1);
    query.unmount();
  });

  it.each(Object.keys(GROUP_QUERY_KEYS))(
    "refreshes during continuous %s events without waiting for quiet",
    async (group) => {
      const { unmount, invalidateQueries } = setup();
      for (let i = 0; i < 40; i++) {
        emit(group, "state-changed");
        await advance(100);
      }
      const key = GROUP_QUERY_KEYS[group][0];
      expect(invalidateQueries.mock.calls.filter(
        ([filter]) => filter.queryKey?.[0] === key,
      )).toHaveLength(2);
      unmount();
    },
  );

  it("deduplicates overlapping groups and cancels pending batches on unmount", async () => {
    const { unmount, invalidateQueries } = setup();
    emit();
    emit("supply-chain");
    await advance(2000);
    expect(invalidateQueries.mock.calls.filter(
      ([filter]) => filter.queryKey?.[0] === "manufacturing-status",
    )).toHaveLength(1);
    invalidateQueries.mockClear();
    emit();
    emit("supply-chain");
    unmount();
    await advance(2000);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("refreshes an explicit snapshot once per connection and reconnection", async () => {
    const { unmount, invalidateQueries } = setup();
    emit("supply-chain");
    act(() => subscription.onConnected?.());
    const count = new Set(Object.values(GROUP_QUERY_KEYS).flat()).size;
    expect(invalidateQueries).toHaveBeenCalledTimes(count);
    await advance(120_000);
    expect(invalidateQueries).toHaveBeenCalledTimes(count);
    act(() => subscription.onConnected?.());
    expect(invalidateQueries).toHaveBeenCalledTimes(count * 2);
    expect(invalidateQueries.mock.calls.every(
      ([filter, options]) => filter.queryKey?.length === 1 && options?.cancelRefetch === false,
    )).toBe(true);
    unmount();
  });

  it.each([
    ["supply-chain", ["supply-orders", "supply-orders-history", "supply-order",
      "open-purchase-orders", "vendor-purchase-orders", "supply-catalogs-bulk", "po-details"]],
    ["manufacturing-agent", ["agent-proposals", "manufacturing-agent-config", "agent-queue-status"]],
    ["warehouse", ["fg-catalog-dashboard", "all-cost-history", "product-inventory-all"]],
    ["orders", ["open-sales-orders", "open-demand", "historical-demand"]],
    ["finance", ["all-cost-history", "cost-history", "price-history", "open-sales-orders"]],
  ])("covers generic database events for %s", async (group, keys) => {
    const { unmount, invalidateQueries } = setup();
    emit(group as string, "database-changed");
    await advance(2000);
    for (const key of keys) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: [key] }, { cancelRefetch: false });
    }
    unmount();
  });

  it("ignores unknown groups", async () => {
    const { unmount, invalidateQueries } = setup();
    emit("unrelated");
    await advance(10_000);
    expect(invalidateQueries).not.toHaveBeenCalled();
    unmount();
  });

  it("keeps every application query root covered and disallows legacy polling", () => {
    const covered = new Set(Object.values(GROUP_QUERY_KEYS).flat());
    const inspect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) inspect(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
          const source = readFileSync(path, "utf8");
          expect(source, path).not.toMatch(/refetchInterval(?:InBackground)?\s*:/);
          expect(source, path).not.toMatch(/\bsetInterval\s*\(/);
          for (const match of source.matchAll(/queryKey:\s*\[\s*["']([^"']+)/g)) {
            expect(covered.has(match[1]), `${path}: ${match[1]}`).toBe(true);
          }
        }
      }
    };
    inspect(join(process.cwd(), "src"));
  });
});
