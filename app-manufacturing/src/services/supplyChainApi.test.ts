import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dabFetch } from "@/lib/dabFetch";
import { fetchOrder, fetchOrderHistory, fetchOrders, placeOrder, cancelOrder } from "./supplyChainApi";

vi.mock("@/lib/dabFetch", () => ({ dabFetch: vi.fn() }));

const header = {
  PurchaseOrderID: 1, VendorID: 10, Status: 1,
  OrderDate: "2026-11-02T18:00:00Z", Freight: 5, TotalDue: 49,
};
const detail = {
  PurchaseOrderID: 1, PurchaseOrderDetailID: 1, ProductID: 20,
  OrderQty: 2, UnitPrice: 10, DueDate: "2026-11-03T18:00:00Z",
};

function mockSqlData(overrides: Record<string, unknown[]> = {}) {
  const data: Record<string, unknown[]> = {
    PurchaseOrderHeader: [header],
    PurchaseOrderDetail: [detail],
    Vendor: [{ BusinessEntityID: 10, Name: "Supplier", ActiveFlag: true }],
    Product: [{ ProductID: 20, Name: "Blade", MakeFlag: false }],
    BillOfMaterials: [{ ComponentID: 20, EndDate: null }],
    ...overrides,
  };
  vi.mocked(dabFetch).mockImplementation(async (url) => {
    const entity = new URL(url).pathname.split("/").pop()!;
    if (!(entity in data)) throw new Error(`Unexpected DAB entity ${entity}`);
    return new Response(JSON.stringify({ value: data[entity] }));
  });
}

describe("supply-chain SQL reads", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.mocked(dabFetch).mockReset();
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("SQL reads must not call Functions");
    }));
    mockSqlData();
  });

  it("reads open orders through DAB and preserves the existing projection", async () => {
    await expect(fetchOrders()).resolves.toEqual([{
      orderId: "1", vendorId: "10", vendorName: "Supplier",
      productId: 20, productName: "Blade", qty: 2, unitCost: 10,
      shippingCost: 5, totalCost: 49, status: "pending",
      placedAtUtc: header.OrderDate, estimatedDeliveryUtc: detail.DueDate,
    }]);
    const url = new URL(vi.mocked(dabFetch).mock.calls[0][0]);
    expect(url.searchParams.get("$filter")).toBe("Status eq 1 or Status eq 2");
    expect(url.searchParams.get("$orderby")).toBe("OrderDate desc");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes terminal statuses in history without an open-order filter", async () => {
    mockSqlData({ PurchaseOrderHeader: [{ ...header, Status: 4 }] });
    expect((await fetchOrderHistory())[0].status).toBe("complete");
    expect(new URL(vi.mocked(dabFetch).mock.calls[0][0]).searchParams.has("$filter")).toBe(false);
  });

  it("preserves UTC when DAB timestamps have no timezone suffix", async () => {
    mockSqlData({
      PurchaseOrderHeader: [{ ...header, OrderDate: "2026-11-02T18:00:00" }],
      PurchaseOrderDetail: [{ ...detail, DueDate: "2026-11-03T18:00:00" }],
    });
    expect((await fetchOrders())[0]).toMatchObject({
      placedAtUtc: "2026-11-02T18:00:00Z",
      estimatedDeliveryUtc: "2026-11-03T18:00:00Z",
    });
  });

  it("keeps all lines but excludes inactive vendors, manufactured products and non-BOM components", async () => {
    mockSqlData({
      PurchaseOrderHeader: [header, { ...header, PurchaseOrderID: 2, VendorID: 11 }],
      PurchaseOrderDetail: [
        detail,
        { ...detail, PurchaseOrderDetailID: 2 },
        { ...detail, PurchaseOrderID: 2 },
        { ...detail, ProductID: 21 },
        { ...detail, ProductID: 22 },
      ],
      Vendor: [
        { BusinessEntityID: 10, Name: "Supplier", ActiveFlag: true },
        { BusinessEntityID: 11, Name: "Inactive", ActiveFlag: false },
      ],
      Product: [
        { ProductID: 20, Name: "Blade", MakeFlag: false },
        { ProductID: 21, Name: "Assembly", MakeFlag: true },
        { ProductID: 22, Name: "Non-BOM", MakeFlag: false },
      ],
      BillOfMaterials: [{ ComponentID: 20 }, { ComponentID: 21 }],
    });
    expect(await fetchOrderHistory()).toHaveLength(2);
  });

  it("aggregates multi-line detail without multiplying header freight and total", async () => {
    mockSqlData({ PurchaseOrderDetail: [
      detail,
      { ...detail, PurchaseOrderDetailID: 2, OrderQty: 1, UnitPrice: 20 },
    ] });
    const result = await fetchOrder("1");
    expect(result).toMatchObject({
      qty: 3, unitCost: 40 / 3, shippingCost: 5, totalCost: 49,
      productName: "2 line items",
    });
    expect(new URL(vi.mocked(dabFetch).mock.calls[0][0]).searchParams.get("$filter"))
      .toBe("PurchaseOrderID eq 1");
  });

  it.each(["abc", "-1", "0", "1 or Status eq 4", "9007199254740992"])(
    "rejects invalid ID %s before making a request",
    async (id) => {
      await expect(fetchOrder(id)).rejects.toThrow("Invalid purchase order ID");
      expect(dabFetch).not.toHaveBeenCalled();
    },
  );

  it("reports missing orders and does not fall back to the Functions listing", async () => {
    mockSqlData({ PurchaseOrderHeader: [] });
    await expect(fetchOrder("123")).rejects.toThrow("Order 123 not found");
    expect(dabFetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces DAB authorization failures instead of returning empty results", async () => {
    vi.mocked(dabFetch).mockResolvedValue(new Response("Forbidden", { status: 403 }));
    await expect(fetchOrders()).rejects.toThrow("API error: 403");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains the Functions workflows for placing and cancelling orders", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      new Response(JSON.stringify({ orderId: "1" })),
    );
    await placeOrder("10", 20, 2);
    await cancelOrder("1", "Not needed");
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("/supply/order"), expect.objectContaining({
      method: "POST", body: JSON.stringify({ vendorId: "10", productId: 20, qty: 2 }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining("/supply/order/1"), expect.objectContaining({
      method: "DELETE", body: JSON.stringify({ reason: "Not needed" }),
    }));
    expect(dabFetch).not.toHaveBeenCalled();
  });
});
