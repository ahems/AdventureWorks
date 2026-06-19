import { ODATA_BASE } from "@/config/api";
import type {
  SalesOrderHeader,
  SalesOrderDetail,
  ODataResponse,
} from "@/types/production";

const API_BASE = ODATA_BASE;

async function fetchAll<T>(
  entity: string,
  params?: Record<string, string>,
  maxPages = 50,
): Promise<T[]> {
  const all: T[] = [];
  // URLSearchParams encodes '$' as '%24' which DAB rejects; build query string manually.
  const base = `${API_BASE}/${entity}`;
  let url: string | null =
    params && Object.keys(params).length > 0
      ? `${base}?${Object.entries(params)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join("&")}`
      : base;
  let page = 0;
  while (url && page < maxPages) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    const data: ODataResponse<T> & { nextLink?: string } = await res.json();
    all.push(...data.value);
    url = data.nextLink || null;
    page++;
  }
  return all;
}

/** Open / actionable customer demand: anything not Shipped/Cancelled/Rejected. */
export const fetchOpenSalesOrders = () =>
  fetchAll<SalesOrderHeader>("SalesOrderHeader", {
    $filter: "Status lt 5",
    $orderby: "DueDate asc",
  });

/** Most recent shipped orders for trailing-window demand metrics. */
export const fetchRecentShippedOrders = (sinceISODate: string) =>
  fetchAll<SalesOrderHeader>("SalesOrderHeader", {
    $filter: `Status eq 5 and OrderDate ge ${sinceISODate}`,
    $orderby: "OrderDate desc",
  });

/** Latest single shipped order — used to anchor the trailing windows when the dataset is static. */
export async function fetchLatestShippedOrderDate(): Promise<string | null> {
  const res = await fetch(
    `${API_BASE}/SalesOrderHeader?$filter=Status%20eq%205&$orderby=OrderDate%20desc&$first=1`,
  );
  if (!res.ok) return null;
  const json: ODataResponse<SalesOrderHeader> = await res.json();
  return json.value[0]?.OrderDate ?? null;
}

/** Batch fetch detail rows for a specific set of order IDs (chunked to keep URLs sane). */
export async function fetchSalesOrderDetailsForOrders(
  orderIds: number[],
): Promise<SalesOrderDetail[]> {
  if (orderIds.length === 0) return [];
  const CHUNK = 40;
  const out: SalesOrderDetail[] = [];
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const slice = orderIds.slice(i, i + CHUNK);
    const filter = slice.map((id) => `SalesOrderID eq ${id}`).join(" or ");
    const rows = await fetchAll<SalesOrderDetail>("SalesOrderDetail", {
      $filter: filter,
    });
    out.push(...rows);
  }
  return out;
}

export interface OpenDemandRow {
  productId: number;
  openQty: number;
  openOrders: number;
  earliestDueDate: string;
  eShopQty: number;
  b2bQty: number;
  orderRefs: {
    salesOrderId: number;
    salesOrderNumber: string;
    qty: number;
    dueDate: string;
    online: boolean;
    status: number;
    customerId: number;
  }[];
}

export interface HistoricalDemandRow {
  productId: number;
  qty30d: number;
  qty90d: number;
  qty365d: number;
  eShopQty: number;
  b2bQty: number;
  lastOrderDate: string;
  revenue90d: number;
}

export async function loadOpenDemand(): Promise<{
  headers: SalesOrderHeader[];
  rows: OpenDemandRow[];
}> {
  const headers = await fetchOpenSalesOrders();
  if (headers.length === 0) return { headers, rows: [] };
  const details = await fetchSalesOrderDetailsForOrders(
    headers.map((h) => h.SalesOrderID),
  );
  const headerById = new Map(headers.map((h) => [h.SalesOrderID, h]));
  const grouped = new Map<number, OpenDemandRow>();
  for (const d of details) {
    const h = headerById.get(d.SalesOrderID);
    if (!h) continue;
    let row = grouped.get(d.ProductID);
    if (!row) {
      row = {
        productId: d.ProductID,
        openQty: 0,
        openOrders: 0,
        earliestDueDate: h.DueDate,
        eShopQty: 0,
        b2bQty: 0,
        orderRefs: [],
      };
      grouped.set(d.ProductID, row);
    }
    row.openQty += d.OrderQty;
    row.openOrders += 1;
    if (h.OnlineOrderFlag) row.eShopQty += d.OrderQty;
    else row.b2bQty += d.OrderQty;
    if (new Date(h.DueDate) < new Date(row.earliestDueDate))
      row.earliestDueDate = h.DueDate;
    row.orderRefs.push({
      salesOrderId: h.SalesOrderID,
      salesOrderNumber: h.SalesOrderNumber,
      qty: d.OrderQty,
      dueDate: h.DueDate,
      online: h.OnlineOrderFlag,
      status: h.Status,
      customerId: h.CustomerID,
    });
  }
  return {
    headers,
    rows: [...grouped.values()].sort((a, b) => b.openQty - a.openQty),
  };
}

export async function loadHistoricalDemand(
  anchorDate: Date,
): Promise<HistoricalDemandRow[]> {
  // Pull only a 365-day window of shipped orders to keep page count reasonable.
  const since = new Date(anchorDate.getTime() - 365 * 86400000);
  // DAB maps datetime columns to Edm.DateTimeOffset — date-only literals cause 500.
  // Use full ISO datetime (colons encoded by encodeURIComponent are fine).
  const sinceISO = since.toISOString().split(".")[0] + "Z"; // e.g. 2025-01-12T00:00:00Z
  const headers = await fetchRecentShippedOrders(sinceISO);
  if (headers.length === 0) return [];
  const details = await fetchSalesOrderDetailsForOrders(
    headers.map((h) => h.SalesOrderID),
  );
  const headerById = new Map(headers.map((h) => [h.SalesOrderID, h]));
  const t30 = anchorDate.getTime() - 30 * 86400000;
  const t90 = anchorDate.getTime() - 90 * 86400000;
  const map = new Map<number, HistoricalDemandRow>();
  for (const d of details) {
    const h = headerById.get(d.SalesOrderID);
    if (!h) continue;
    let row = map.get(d.ProductID);
    if (!row) {
      row = {
        productId: d.ProductID,
        qty30d: 0,
        qty90d: 0,
        qty365d: 0,
        eShopQty: 0,
        b2bQty: 0,
        lastOrderDate: h.OrderDate,
        revenue90d: 0,
      };
      map.set(d.ProductID, row);
    }
    const t = new Date(h.OrderDate).getTime();
    row.qty365d += d.OrderQty;
    if (t >= t90) {
      row.qty90d += d.OrderQty;
      row.revenue90d += d.LineTotal;
    }
    if (t >= t30) row.qty30d += d.OrderQty;
    if (h.OnlineOrderFlag) row.eShopQty += d.OrderQty;
    else row.b2bQty += d.OrderQty;
    if (new Date(h.OrderDate) > new Date(row.lastOrderDate))
      row.lastOrderDate = h.OrderDate;
  }
  return [...map.values()];
}
