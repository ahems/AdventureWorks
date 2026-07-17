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
      const [countsRes, recentData] = await Promise.all([
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

      return {
        totalProducts: countsRes.totalProducts,
        totalCustomers: countsRes.totalCustomers,
        totalOrders: countsRes.totalOrders,
        pendingOrders: countsRes.pendingOrders,
        reviewsToModerate: countsRes.reviewsToModerate,
        recentOrders: recentData.salesOrderHeaders?.items ?? [],
      };
    },
    staleTime: 2 * 60 * 1000,
  });
};
