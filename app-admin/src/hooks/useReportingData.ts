import { useQuery } from "@tanstack/react-query";
import { getFunctionsApiUrl } from "@/lib/utils";

// ─── Types (camelCase — matches Functions' JsonNamingPolicy.CamelCase) ────────

export interface CategoryRevenue {
  categoryName: string;
  revenue: number;
}

export interface MonthlyRevenue {
  year: number;
  month: number;
  revenue: number;
  orderCount: number;
}

export interface TopProduct {
  productName: string;
  revenue: number;
  unitsSold: number;
}

export interface OrderStatusCount {
  status: number;
  orderCount: number;
}

export interface TerritoryRevenue {
  territoryName: string;
  countryRegionCode: string;
  revenue: number;
  orderCount: number;
}

export interface CategoryInventory {
  categoryName: string;
  totalQuantity: number;
  productCount: number;
}

// ─── Shared fetch helper ─────────────────────────────────────────────────────

async function fetchReport<T>(path: string): Promise<T> {
  const res = await fetch(`${getFunctionsApiUrl()}/api/reporting/${path}`);
  if (!res.ok) throw new Error(`Reporting API error: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const STALE_MS = 15 * 60 * 1000; // 15 min — aggregate data changes slowly

// ─── Hooks ───────────────────────────────────────────────────────────────────

export const useRevenueByCategoryData = () =>
  useQuery<CategoryRevenue[]>({
    queryKey: ["reporting", "revenue-by-category"],
    queryFn: () => fetchReport<CategoryRevenue[]>("revenue-by-category"),
    staleTime: STALE_MS,
  });

export const useMonthlyRevenueTrendData = () =>
  useQuery<MonthlyRevenue[]>({
    queryKey: ["reporting", "monthly-trend"],
    queryFn: () => fetchReport<MonthlyRevenue[]>("monthly-trend"),
    staleTime: STALE_MS,
  });

export const useTopProductsData = (limit = 10) =>
  useQuery<TopProduct[]>({
    queryKey: ["reporting", "top-products", limit],
    queryFn: () => fetchReport<TopProduct[]>(`top-products?limit=${limit}`),
    staleTime: STALE_MS,
  });

export const useOrdersByStatusData = () =>
  useQuery<OrderStatusCount[]>({
    queryKey: ["reporting", "orders-by-status"],
    queryFn: () => fetchReport<OrderStatusCount[]>("orders-by-status"),
    staleTime: STALE_MS,
  });

export const useRevenueByTerritoryData = () =>
  useQuery<TerritoryRevenue[]>({
    queryKey: ["reporting", "revenue-by-territory"],
    queryFn: () => fetchReport<TerritoryRevenue[]>("revenue-by-territory"),
    staleTime: STALE_MS,
  });

export const useInventoryByCategoryData = () =>
  useQuery<CategoryInventory[]>({
    queryKey: ["reporting", "inventory-by-category"],
    queryFn: () => fetchReport<CategoryInventory[]>("inventory-by-category"),
    staleTime: STALE_MS,
  });
