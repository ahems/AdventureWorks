import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealTimeUpdates } from "./useRealTimeUpdates";

const { invalidateQueries, subscription } = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  subscription: {
    onMessage: null as ((group: string, data: Record<string, unknown>) => void) | null,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock("./useWebPubSub", () => ({
  useWebPubSub: (_groups: string[], onMessage: typeof subscription.onMessage) => {
    subscription.onMessage = onMessage;
  },
}));

function emit(group = "manufacturing-ops") {
  act(() => subscription.onMessage?.(group, { event: "wo-completed" }));
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

describe("manufacturing real-time refresh batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invalidateQueries.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst into one refresh per query after two seconds", () => {
    const { unmount } = renderHook(useRealTimeUpdates);
    for (let i = 0; i < 100; i++) emit();
    advance(1999);
    expect(invalidateQueries).not.toHaveBeenCalled();
    advance(1);
    expect(invalidateQueries).toHaveBeenCalledTimes(20);
    expect(invalidateQueries).toHaveBeenCalledWith(
      { queryKey: ["work-orders"] },
      { cancelRefetch: false },
    );
    expect(invalidateQueries.mock.calls.every(([, options]) => options.cancelRefetch === false)).toBe(true);
    advance(10000);
    expect(invalidateQueries).toHaveBeenCalledTimes(20);
    unmount();
  });

  it("refreshes during continuous events rather than waiting for a quiet period", () => {
    const { unmount } = renderHook(useRealTimeUpdates);
    for (let i = 0; i < 40; i++) {
      emit();
      advance(100);
    }
    const workOrderCalls = invalidateQueries.mock.calls.filter(
      ([filter]) => filter.queryKey[0] === "work-orders",
    );
    expect(workOrderCalls).toHaveLength(2);
    unmount();
  });

  it("cancels both pending group timers on unmount", () => {
    const { unmount } = renderHook(useRealTimeUpdates);
    emit();
    emit("supply-chain");
    unmount();
    advance(2000);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("leaves unrelated group updates immediate", () => {
    const { unmount } = renderHook(useRealTimeUpdates);
    emit("orders");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["open-demand"] });
    unmount();
  });
});
