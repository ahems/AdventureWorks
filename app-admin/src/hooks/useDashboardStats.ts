import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { getFunctionsApiUrl } from "@/lib/utils";
import { gql } from "graphql-request";

// Separate query for the five most-recent orders shown in the dashboard panel.
const GET_RECENT_ORDERS = gql`
  query GetRecentOrders {
    salesOrderHeaders(first: 5, orderBy: { OrderDate: DESC }) {
      items {
        SalesOrderID
        Status
        TotalDue
        OrderDate
      }
    }
  }
`;

export interface DashboardOrder {
  SalesOrderID: number;
  OrderDate: string;
  Status: number;
  TotalDue: number;
}

export interface DashboardStats {
  totalProducts: number;
  totalCustomers: number;
  totalOrders: number;
  pendingOrders: number;
  reviewsToModerate: number;
  recentOrders: DashboardOrder[];
}

// Map numeric SalesOrderHeader.Status to display string
// 1=In Process, 2=Approved, 3=Backordered, 4=Rejected, 5=Shipped, 6=Cancelled
export const ORDER_STATUS_LABELS: Record<number, string> = {
  1: "In Process",
  2: "Approved",
  3: "Backordered",
  4: "Rejected",
  5: "Shipped",
  6: "Cancelled",
  7: "Delivered",
};

export const getOrderStatusLabel = (status: number): string =>
  ORDER_STATUS_LABELS[status] ?? "Unknown";

interface DashboardCountsResponse {
  totalProducts: number;
  totalCustomers: number;
  totalOrders: number;
  pendingOrders: number;
  reviewsToModerate: number;
}

export const useDashboardStats = () => {
  return useQuery<DashboardStats>({
    queryKey: ["dashboardStats"],
    queryFn: async () => {
      // Load KPI counts and recent orders independently so one failing source
      // doesn't blank the whole dashboard.
      const [countsResult, recentResult] = await Promise.allSettled([
        fetch(`${getFunctionsApiUrl()}/api/reporting/dashboard-counts`).then(
          (r) => {
            if (!r.ok) throw new Error(`dashboard-counts HTTP ${r.status}`);
            return r.json() as Promise<DashboardCountsResponse>;
          },
        ),
        graphqlClient.request<{
          salesOrderHeaders?: { items: DashboardOrder[] };
        }>(GET_RECENT_ORDERS),
      ]);

      if (countsResult.status === "rejected" && recentResult.status === "rejected") {
        throw countsResult.reason;
      }
      if (countsResult.status === "rejected") {
        console.error("Dashboard counts failed:", countsResult.reason);
      }
      if (recentResult.status === "rejected") {
        console.error("Recent orders failed:", recentResult.reason);
      }

      const counts =
        countsResult.status === "fulfilled" ? countsResult.value : undefined;
      return {
        totalProducts: counts?.totalProducts ?? 0,
        totalCustomers: counts?.totalCustomers ?? 0,
        totalOrders: counts?.totalOrders ?? 0,
        pendingOrders: counts?.pendingOrders ?? 0,
        reviewsToModerate: counts?.reviewsToModerate ?? 0,
        recentOrders:
          recentResult.status === "fulfilled"
            ? (recentResult.value.salesOrderHeaders?.items ?? [])
            : [],
      };
    },
    staleTime: 2 * 60 * 1000,
  });
};
