import { MANUFACTURING_BASE as BASE } from "@/config/api";
import {
  fetchActiveBOM,
  fetchAllOData,
  fetchAllPurchaseOrderDetails,
  fetchProducts,
  fetchVendors as fetchSqlVendors,
  sqlUtcTimestamp,
} from "./api";
import type { PurchaseOrderHeader } from "@/types/production";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Vendor {
  vendorId: string;
  accountNumber: string;
  name: string;
  description: string;
  creditRating: number;
  preferredVendorStatus: boolean;
  defaultLeadTimeDays: number;
  reliabilityPct: number;
  shipMethodId: number;
  shipMethodName: string;
  shipBase: number;
  shipRate: number;
  restockDelaySimHrs: number;
  strengths: string[];
  weaknesses: string[];
}

export interface VendorSummary {
  vendor: Vendor;
  totalComponents: number;
  inStockComponents: number;
  activeOrders: number;
  deliveredToday: number;
}

export interface VendorStock {
  vendorId: string;
  productId: number;
  productName: string;
  standardPrice: number;
  averageLeadTime: number;
  minOrderQty: number;
  maxOrderQty: number;
  currentStock: number;
  maxStock: number;
  weightKg: number;
}

export interface VendorDetail {
  vendor: VendorSummary;
  stock: SupplyQuote[];
}

export interface SupplyQuote {
  vendorId: string;
  vendorName: string;
  productId: number;
  productName: string;
  qtyRequested: number;
  stockAvailable: number;
  unitCost: number;
  shippingCost: number;
  totalCost: number;
  leadTimeDays: number;
  minOrderQty: number;
  maxOrderQty: number;
  reliabilityPct: number;
  estimatedDeliverySimHrs: number;
  estimatedDeliveryRealMins: number;
  inStock: boolean;
  incomingQty: number;
  earliestIncomingEtaUtc: string | null;
}

/**
 * Format an incoming-PO ETA as a relative label.
 * Returns "—" for null, "arriving soon" for past/now, else "arrives ~X min".
 */
export function formatIncomingEta(iso: string | null | undefined): string {
  if (!iso) return "—";
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  return mins <= 0 ? "arriving soon" : `arrives ~${mins} min`;
}

/** Format an ISO timestamp as a compact UTC string, or "—" when null. */
export function formatUtcTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export interface TrackingEvent {
  eventType: string;
  description: string;
  timestampUtc: string;
}

export interface PurchaseOrder {
  orderId: string;
  vendorId: string;
  vendorName: string;
  productId: number;
  productName: string;
  qty: number;
  unitCost: number;
  shippingCost: number;
  totalCost: number;
  status: "pending" | "approved" | "complete" | "rejected";
  placedAtUtc: string;
  estimatedDeliveryUtc: string;
  actualDeliveryUtc?: string | null;
  cancellationReason?: string | null;
  trackingEvents?: TrackingEvent[];
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function initializeSupplyChain(): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/supply/initialize`, { method: "POST" });
  if (!res.ok) throw new Error(`Initialize failed: ${res.status}`);
  return res.json();
}

export async function fetchVendors(): Promise<VendorSummary[]> {
  const res = await fetch(`${BASE}/supply/vendors`);
  if (!res.ok) throw new Error(`Vendors API error: ${res.status}`);
  return res.json();
}

export async function fetchVendorDetail(
  vendorId: string,
): Promise<VendorDetail> {
  const res = await fetch(`${BASE}/supply/vendors/${vendorId}`);
  if (!res.ok) throw new Error(`Vendor detail error: ${res.status}`);
  return res.json();
}

export async function fetchCatalog(productId?: number): Promise<SupplyQuote[]> {
  const url = productId
    ? `${BASE}/supply/catalog/${productId}`
    : `${BASE}/supply/catalog`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Catalog error: ${res.status}`);
  return res.json();
}

export async function fetchQuote(
  vendorId: string,
  productId: number,
  qty: number,
): Promise<SupplyQuote> {
  const res = await fetch(
    `${BASE}/supply/quote?vendorId=${vendorId}&productId=${productId}&qty=${qty}`,
  );
  if (!res.ok) throw new Error(`Quote error: ${res.status}`);
  return res.json();
}

export async function placeOrder(
  vendorId: string,
  productId: number,
  qty: number,
): Promise<PurchaseOrder> {
  const res = await fetch(`${BASE}/supply/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vendorId, productId, qty }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Order failed: ${res.status} — ${text}`);
  }
  return res.json();
}

export interface ReorderAllItem {
  productId: number;
  remainingToOrder: number;
  quotes: {
    vendorId: string;
    stockAvailable: number;
    minOrderQty: number;
    maxOrderQty: number;
    unitCost: number;
  }[];
}

export async function submitBulkReorder(
  items: ReorderAllItem[],
): Promise<{ accepted: boolean; totalOrdersPlanned: number }> {
  const res = await fetch(`${BASE}/supply/reorder-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bulk reorder failed: ${res.status} — ${text}`);
  }
  return res.json();
}

export async function fetchOrder(orderId: string): Promise<PurchaseOrder> {
  const id = Number(orderId);
  if (!/^\d+$/.test(orderId) || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid purchase order ID: ${orderId}`);
  }
  const lines = await fetchSqlOrders(`PurchaseOrderID eq ${id}`);
  const first = lines[0];
  if (!first) throw new Error(`Order ${orderId} not found`);
  const qty = lines.reduce((s, l) => s + (l.qty || 0), 0);
  const unitCostSum = lines.reduce(
    (s, l) => s + (l.unitCost || 0) * (l.qty || 0),
    0,
  );
  return {
    ...first,
    qty,
    unitCost: qty > 0 ? unitCostSum / qty : first.unitCost,
    // Freight and TotalDue belong to the header, not each detail row.
    shippingCost: first.shippingCost,
    totalCost: first.totalCost,
    productName:
      lines.length > 1 ? `${lines.length} line items` : first.productName,
  };
}

export async function fetchOrders(): Promise<PurchaseOrder[]> {
  return fetchSqlOrders("Status eq 1 or Status eq 2");
}

export async function fetchOrderHistory(): Promise<PurchaseOrder[]> {
  return fetchSqlOrders();
}

async function fetchSqlOrders(filter?: string): Promise<PurchaseOrder[]> {
  const headers = await fetchAllOData<PurchaseOrderHeader>("PurchaseOrderHeader", {
    ...(filter ? { $filter: filter } : {}),
    $orderby: "OrderDate desc",
  });
  if (headers.length === 0) return [];

  const [details, vendors, products, bom] = await Promise.all([
    fetchAllPurchaseOrderDetails(headers.map((h) => h.PurchaseOrderID)),
    fetchSqlVendors(),
    fetchProducts("MakeFlag eq false"),
    fetchActiveBOM(),
  ]);
  const activeVendors = new Map(
    vendors.filter((v) => v.ActiveFlag).map((v) => [v.BusinessEntityID, v]),
  );
  const componentIds = new Set(bom.map((b) => b.ComponentID));
  const components = new Map(
    products.filter((p) => !p.MakeFlag && componentIds.has(p.ProductID))
      .map((p) => [p.ProductID, p]),
  );
  const detailsByOrder = new Map<number, typeof details>();
  for (const detail of details) {
    const rows = detailsByOrder.get(detail.PurchaseOrderID) ?? [];
    rows.push(detail);
    detailsByOrder.set(detail.PurchaseOrderID, rows);
  }
  const statuses: Record<number, PurchaseOrder["status"]> = {
    1: "pending", 2: "approved", 3: "rejected", 4: "complete",
  };

  return headers.flatMap((header) => {
    const vendor = activeVendors.get(header.VendorID);
    if (!vendor) return [];
    return (detailsByOrder.get(header.PurchaseOrderID) ?? []).flatMap((detail) => {
      const product = components.get(detail.ProductID);
      if (!product) return [];
      const status = statuses[header.Status];
      if (!status) throw new Error(`Unknown purchase order status: ${header.Status}`);
      return [{
        orderId: String(header.PurchaseOrderID),
        vendorId: String(header.VendorID),
        vendorName: vendor.Name,
        productId: detail.ProductID,
        productName: product.Name,
        qty: detail.OrderQty,
        unitCost: detail.UnitPrice,
        shippingCost: header.Freight,
        totalCost: header.TotalDue,
        status,
        placedAtUtc: sqlUtcTimestamp(header.OrderDate),
        estimatedDeliveryUtc: sqlUtcTimestamp(detail.DueDate),
      }];
    });
  });
}

export async function cancelOrder(
  orderId: string,
  reason?: string,
): Promise<{ message?: string; error?: string }> {
  const res = await fetch(`${BASE}/supply/order/${orderId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: reason || "Cancelled by user" }),
  });
  if (!res.ok) throw new Error(`Cancel error: ${res.status}`);
  return res.json();
}

export async function restockVendor(
  vendorId: string,
): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/supply/restock/${vendorId}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Restock error: ${res.status}`);
  return res.json();
}

export async function resetSupplyChain(): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/supply/reset`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Reset error: ${res.status}`);
  return res.json();
}

// ── Supply Chain Config ─────────────────────────────────────────────────────

export interface SupplyChainConfig {
  supplyChainSpeedMultiplier: number;
}

export async function fetchSupplyChainConfig(): Promise<SupplyChainConfig> {
  const res = await fetch(`${BASE}/supply/config`);
  if (!res.ok) throw new Error(`Config fetch error: ${res.status}`);
  return res.json();
}

export async function updateSupplyChainConfig(
  config: SupplyChainConfig,
): Promise<SupplyChainConfig & { message: string }> {
  const res = await fetch(`${BASE}/supply/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Config update failed: ${res.status} — ${text}`);
  }
  return res.json();
}
