import { beforeEach, describe, expect, it, vi } from "vitest";
import { dabFetch } from "@/lib/dabFetch";
import { fetchWorkOrders } from "./api";

vi.mock("@/lib/dabFetch", () => ({ dabFetch: vi.fn() }));

describe("fetchWorkOrders", () => {
  beforeEach(() => vi.mocked(dabFetch).mockReset());

  it("preserves the latest 500 query and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    const orders = [{ WorkOrderID: 1 }];
    vi.mocked(dabFetch).mockResolvedValue(new Response(JSON.stringify({ value: orders })));
    await expect(fetchWorkOrders({ signal })).resolves.toEqual(orders);
    expect(dabFetch).toHaveBeenCalledWith(
      expect.stringContaining("/WorkOrder?$orderby=ModifiedDate%20desc&$first=500"),
      { signal },
    );
  });

  it("surfaces the API error instead of returning an empty successful result", async () => {
    vi.mocked(dabFetch).mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "Worker limit reached" } }),
      { status: 500, statusText: "Internal Server Error" },
    ));
    await expect(fetchWorkOrders()).rejects.toThrow(
      'API error (WorkOrder): 500 Internal Server Error - {"error":{"message":"Worker limit reached"}}',
    );
  });
});
