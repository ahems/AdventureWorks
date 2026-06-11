import { useQuery } from "@tanstack/react-query";
import { getFunctionsApiUrl } from "@/lib/utils";

// ─── Channel type ─────────────────────────────────────────────────────────────
// "eshop" = online orders (OnlineOrderFlag=1)
// "b2b"   = store/sales-rep orders (OnlineOrderFlag=0)
// "all"   = combined (default, no filter)
export type SalesChannel = "eshop" | "b2b" | "all";

function channelParam(channel: SalesChannel): string {
  if (channel === "eshop") return "&channel=eshop";
  if (channel === "b2b") return "&channel=b2b";
  return "";
}

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

export const useRevenueByCategoryData = (channel: SalesChannel = "all") =>
  useQuery<CategoryRevenue[]>({
    queryKey: ["reporting", "revenue-by-category", channel],
    queryFn: () => fetchReport<CategoryRevenue[]>(`revenue-by-category?${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useMonthlyRevenueTrendData = (channel: SalesChannel = "all") =>
  useQuery<MonthlyRevenue[]>({
    queryKey: ["reporting", "monthly-trend", channel],
    queryFn: () => fetchReport<MonthlyRevenue[]>(`monthly-trend?${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useTopProductsData = (limit = 10, channel: SalesChannel = "all") =>
  useQuery<TopProduct[]>({
    queryKey: ["reporting", "top-products", limit, channel],
    queryFn: () => fetchReport<TopProduct[]>(`top-products?limit=${limit}${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useOrdersByStatusData = (channel: SalesChannel = "all") =>
  useQuery<OrderStatusCount[]>({
    queryKey: ["reporting", "orders-by-status", channel],
    queryFn: () => fetchReport<OrderStatusCount[]>(`orders-by-status?${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useRevenueByTerritoryData = (channel: SalesChannel = "all") =>
  useQuery<TerritoryRevenue[]>({
    queryKey: ["reporting", "revenue-by-territory", channel],
    queryFn: () => fetchReport<TerritoryRevenue[]>(`revenue-by-territory?${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useInventoryByCategoryData = () =>
  useQuery<CategoryInventory[]>({
    queryKey: ["reporting", "inventory-by-category"],
    queryFn: () => fetchReport<CategoryInventory[]>("inventory-by-category"),
    staleTime: STALE_MS,
  });

// ─── Profitability types ──────────────────────────────────────────────────────

export interface ProductProfit {
  productName: string;
  revenue: number;
  totalCost: number;
  profit: number;
  marginPct: number;
  unitsSold: number;
}

export interface ProductProfitDetail {
  productID: number;
  productName: string;
  categoryName: string;
  currentListPrice: number;
  currentCost: number;
  revenue: number;
  totalCost: number;
  profit: number;
  marginPct: number;
  unitsSold: number;
  currentStock: number;
  currentOrders: number;
  activeDiscounts: number;
}

export interface CategoryProfit {
  categoryName: string;
  revenue: number;
  totalCost: number;
  profit: number;
  marginPct: number;
}

export interface DiscountTypeRevenue {
  offerType: string;
  totalRevenue: number;
  totalDiscount: number;
  orderCount: number;
}

export interface SlowMover {
  productID: number;
  productName: string;
  categoryName: string | null;
  currentListPrice: number;
  currentCost: number;
  currentStock: number;
  stockValue: number;
  unitsSoldLast12Months: number;
  daysSinceLastSale: number | null;
  marginPct: number;
  activeDiscounts: number;
}

export interface SalesTrendMonth {
  year: number;
  month: number;
  unitsSold: number;
  revenue: number;
}

export interface ProductPriceHistoryEntry {
  startDate: string;
  endDate: string | null;
  listPrice: number;
}

export interface ProductCostHistoryEntry {
  startDate: string;
  endDate: string | null;
  standardCost: number;
}

export interface ProductHistory {
  priceHistory: ProductPriceHistoryEntry[];
  costHistory: ProductCostHistoryEntry[];
}

// ─── Profitability hooks ──────────────────────────────────────────────────────

export const useProductProfitabilityData = (limit = 20, channel: SalesChannel = "all") =>
  useQuery<ProductProfit[]>({
    queryKey: ["reporting", "product-profitability", limit, channel],
    queryFn: () =>
      fetchReport<ProductProfit[]>(`product-profitability?limit=${limit}${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useProductProfitabilityBottomData = (limit = 20, channel: SalesChannel = "all") =>
  useQuery<ProductProfit[]>({
    queryKey: ["reporting", "product-profitability-bottom", limit, channel],
    queryFn: () =>
      fetchReport<ProductProfit[]>(
        `product-profitability?limit=${limit}&sortAsc=true${channelParam(channel)}`,
      ),
    staleTime: STALE_MS,
  });

export const useProductProfitabilityDetailData = (channel: SalesChannel = "all") =>
  useQuery<ProductProfitDetail[]>({
    queryKey: ["reporting", "product-profitability-detail", channel],
    queryFn: () =>
      fetchReport<ProductProfitDetail[]>(`product-profitability-detail?${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useProfitabilityByCategoryData = (channel: SalesChannel = "all") =>
  useQuery<CategoryProfit[]>({
    queryKey: ["reporting", "profitability-by-category", channel],
    queryFn: () => fetchReport<CategoryProfit[]>(`profitability-by-category?${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useDiscountImpactData = (channel: SalesChannel = "all") =>
  useQuery<DiscountTypeRevenue[]>({
    queryKey: ["reporting", "discount-impact", channel],
    queryFn: () => fetchReport<DiscountTypeRevenue[]>(`discount-impact?${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useSlowMoversData = (threshold = 10, channel: SalesChannel = "all") =>
  useQuery<SlowMover[]>({
    queryKey: ["reporting", "slow-movers", threshold, channel],
    queryFn: () =>
      fetchReport<SlowMover[]>(`slow-movers?threshold=${threshold}${channelParam(channel)}`),
    staleTime: STALE_MS,
  });

export const useSalesTrendsData = (productId: number, channel: SalesChannel = "all") =>
  useQuery<SalesTrendMonth[]>({
    queryKey: ["reporting", "sales-trends", productId, channel],
    queryFn: () =>
      fetchReport<SalesTrendMonth[]>(`sales-trends?productId=${productId}${channelParam(channel)}`),
    staleTime: STALE_MS,
    enabled: productId > 0,
  });

export const useProductHistoryData = (productId: number) =>
  useQuery<ProductHistory>({
    queryKey: ["reporting", "product-history", productId],
    queryFn: () =>
      fetchReport<ProductHistory>(
        `product-price-history?productId=${productId}`,
      ),
    staleTime: STALE_MS,
    enabled: productId > 0,
  });
