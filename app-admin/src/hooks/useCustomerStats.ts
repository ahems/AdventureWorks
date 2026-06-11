import { useQuery } from "@tanstack/react-query";
import { getFunctionsApiUrl } from "@/lib/utils";
import type {
  CustomerStatsSummary,
  CustomerCountryStat,
  CustomerRegionStat,
  CustomerMonthlyRevenue,
} from "@/types/customerStats";

const fetchJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
};

/** Aggregate KPI summary: total customers, revenue, avg spend, countries served, spending buckets. */
export const useCustomerStatsSummary = () =>
  useQuery<CustomerStatsSummary>({
    queryKey: ["customer-stats", "summary"],
    queryFn: () =>
      fetchJson<CustomerStatsSummary>(`${getFunctionsApiUrl()}/api/customer-stats`),
    staleTime: 5 * 60 * 1000,
  });

/** Customer count and revenue grouped by country, ordered by customer count desc. */
export const useCustomerCountryBreakdown = () =>
  useQuery<CustomerCountryStat[]>({
    queryKey: ["customer-stats", "countries"],
    queryFn: () =>
      fetchJson<CustomerCountryStat[]>(
        `${getFunctionsApiUrl()}/api/customer-country-breakdown`,
      ),
    staleTime: 5 * 60 * 1000,
  });

/** Customer count and revenue grouped by sales territory group (North America / Europe / Pacific). */
export const useCustomerRegionBreakdown = () =>
  useQuery<CustomerRegionStat[]>({
    queryKey: ["customer-stats", "regions"],
    queryFn: () =>
      fetchJson<CustomerRegionStat[]>(
        `${getFunctionsApiUrl()}/api/customer-region-breakdown`,
      ),
    staleTime: 5 * 60 * 1000,
  });

/** Monthly revenue totals across all individual-customer orders, with cumulative sum added client-side. */
export const useCustomerMonthlyRevenue = () =>
  useQuery<CustomerMonthlyRevenue[]>({
    queryKey: ["customer-stats", "monthly-revenue"],
    queryFn: async () => {
      const data = await fetchJson<CustomerMonthlyRevenue[]>(
        `${getFunctionsApiUrl()}/api/customer-monthly-revenue`,
      );
      let cumulative = 0;
      return data.map((d) => {
        cumulative += d.revenue;
        return { ...d, cumulativeRevenue: cumulative };
      });
    },
    staleTime: 5 * 60 * 1000,
  });
