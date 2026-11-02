import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dabFetch } from "@/lib/dabFetch";
import {
  fetchActiveOperations,
  fetchAllOData,
  fetchAllPurchaseOrderDetails,
  fetchWorkOrders,
  sqlUtcTimestamp,
} from "./api";

vi.mock("@/lib/dabFetch", () => ({ dabFetch: vi.fn() }));

describe("fetchWorkOrders", () => {
  beforeEach(() => { vi.mocked(dabFetch).mockReset(); });

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

  describe("DAB-only manufacturing reads", () => {
    beforeEach(() => { vi.mocked(dabFetch).mockReset(); });
    afterEach(() => vi.useRealTimers());

    it("joins active routing to products and locations and calculates elapsed minutes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-02T18:10:30Z"));
      vi.mocked(dabFetch).mockImplementation(async (url) => {
        const entity = new URL(url).pathname.split("/").pop();
        const data: Record<string, unknown[]> = {
          WorkOrderRouting: [{
            WorkOrderID: 1, ProductID: 10, OperationSequence: 2, LocationID: 20,
            ActualStartDate: "2026-11-02T18:00:00", ActualEndDate: null,
          }],
          Product: [{ ProductID: 10, Name: "Frame" }],
          Location: [{ LocationID: 20, Name: "Welding" }],
        };
        return new Response(JSON.stringify({ value: data[entity!] }));
      });

      await expect(fetchActiveOperations()).resolves.toEqual([{
        workOrderId: 1, productId: 10, productName: "Frame",
        operationSequence: 2, locationId: 20, locationName: "Welding",
        actualStartDate: "2026-11-02T18:00:00Z", elapsedMinutes: 10.5,
      }]);
      const url = new URL(vi.mocked(dabFetch).mock.calls[0][0]);
      expect(url.searchParams.get("$filter")).toBe(
        "ActualStartDate ne null and ActualEndDate eq null",
      );
      expect(url.searchParams.get("$orderby")).toBe("ActualStartDate asc");
      expect(dabFetch).toHaveBeenCalledTimes(3);
    });

    it("reports incomplete active routing instead of hiding records", async () => {
      vi.mocked(dabFetch).mockImplementation(async (url) =>
        new Response(JSON.stringify({
          value: url.includes("/WorkOrderRouting") ? [{
            WorkOrderID: 1, ProductID: 10, LocationID: 20,
            ActualStartDate: "2026-11-02T18:00:00",
          }] : [],
        })),
      );
      await expect(fetchActiveOperations()).rejects.toThrow(
        "Incomplete active routing data for work order 1",
      );
    });

    it("does not fetch lookup tables when there are no active operations", async () => {
      vi.mocked(dabFetch).mockResolvedValue(new Response(JSON.stringify({ value: [] })));
      await expect(fetchActiveOperations()).resolves.toEqual([]);
      expect(dabFetch).toHaveBeenCalledTimes(1);
    });

    it("reads every page rather than truncating after 50 pages", async () => {
      vi.mocked(dabFetch).mockImplementation(async (url) => {
        const page = Number(new URL(url).searchParams.get("page") ?? 1);
        return new Response(JSON.stringify({
          value: [page],
          nextLink: page < 51 ? `http://localhost:5000/api/Product?page=${page + 1}` : undefined,
        }));
      });
      const result = await fetchAllOData<number>("Product");
      expect(result).toHaveLength(51);
      expect(result[50]).toBe(51);
    });

    it("surfaces failures on subsequent pages", async () => {
      vi.mocked(dabFetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({
          value: [1], nextLink: "http://localhost:5000/api/Product?$after=cursor",
        })))
        .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
      await expect(fetchAllOData("Product")).rejects.toThrow("API error: 403");
    });

    it("skips empty detail lookups and batches unique order IDs into bounded filters", async () => {
      await expect(fetchAllPurchaseOrderDetails([])).resolves.toEqual([]);
      expect(dabFetch).not.toHaveBeenCalled();
      vi.mocked(dabFetch).mockImplementation(async () =>
        new Response(JSON.stringify({ value: [] })),
      );
      await fetchAllPurchaseOrderDetails([...Array.from({ length: 41 }, (_, i) => i + 1), 1]);
      expect(dabFetch).toHaveBeenCalledTimes(2);
      const filters = vi.mocked(dabFetch).mock.calls.map(
        ([url]) => new URL(url).searchParams.get("$filter")!,
      );
      expect(filters[0].split(" or ")).toHaveLength(40);
      expect(filters[1]).toBe("PurchaseOrderID eq 41");
    });
  });

  describe("SQL UTC timestamps", () => {
    it.each([
      ["2026-11-02T18:00:00.827", "2026-11-02T18:00:00.827Z"],
      ["2026-11-02T18:00:00Z", "2026-11-02T18:00:00Z"],
      ["2026-11-02T18:00:00+00:00", "2026-11-02T18:00:00+00:00"],
    ])("normalizes %s without interpreting it as browser-local time", (value, expected) => {
      expect(sqlUtcTimestamp(value)).toBe(expected);
    });

    it("reports invalid timestamps", () => {
      expect(() => sqlUtcTimestamp("invalid")).toThrow("Invalid SQL timestamp");
    });
  });

  it("allows Manufacturing DAB reads while denying anonymous access to operational tables", () => {
    const config: {
      entities: Record<string, {
        permissions: { role: string; actions: (string | { action: string })[] }[];
      }>;
    } = JSON.parse(readFileSync("../api/dab-config.json", "utf8"));
    for (const entity of [
      "WorkOrderRouting", "PurchaseOrderHeader", "PurchaseOrderDetail",
      "Vendor", "BillOfMaterials",
    ]) {
      const permissions = config.entities[entity].permissions;
      const role = permissions.find((p) => p.role === "manufacturing-engineer");
      expect(role?.actions).toContain("read");
      expect(permissions.some((p) => p.role === "anonymous")).toBe(false);
    }
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
