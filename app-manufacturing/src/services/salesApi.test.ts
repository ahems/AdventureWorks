import { beforeEach, describe, expect, it, vi } from "vitest";
import { dabFetch } from "@/lib/dabFetch";
import {
  fetchLatestShippedOrderDate,
  fetchOpenSalesOrders,
  fetchRecentShippedOrders,
} from "./salesApi";

vi.mock("@/lib/dabFetch", () => ({ dabFetch: vi.fn() }));

const filterOf = (call: number) =>
  new URL(vi.mocked(dabFetch).mock.calls[call][0] as string).searchParams.get("$filter");

describe("sales order status filters", () => {
  beforeEach(() => {
    vi.mocked(dabFetch).mockReset();
    vi.mocked(dabFetch).mockImplementation(async () =>
      new Response(JSON.stringify({ value: [{ OrderDate: "2026-11-01T00:00:00Z" }] })),
    );
  });

  it("open demand excludes Rejected, Shipped, Cancelled and Delivered", async () => {
    await fetchOpenSalesOrders();
    expect(filterOf(0)).toBe("Status ge 1 and Status le 3");
  });

  it("history includes Delivered as well as Shipped orders", async () => {
    await fetchRecentShippedOrders("2026-10-01");
    expect(filterOf(0)).toBe("(Status eq 5 or Status eq 7) and OrderDate ge 2026-10-01");

    await expect(fetchLatestShippedOrderDate()).resolves.toBe("2026-11-01T00:00:00Z");
    expect(filterOf(1)).toBe("(Status eq 5 or Status eq 7)");
  });
});
