import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";

// Fetch up to 100 of each entity (IDs only for counting) plus hasNextPage flag.
// Products use first:1000 because the AW finished-goods catalogue is small (~295).
const GET_DASHBOARD_COUNTS = gql`
  query GetDashboardCounts {
    products(first: 1000, filter: { FinishedGoodsFlag: { eq: true } }) {
      items {
        ProductID
      }
    }
    customers(first: 100) {
      items {
        CustomerID
      }
      hasNextPage
    }
    salesOrderHeaders(first: 100) {
      items {
        SalesOrderID
        Status
      }
      hasNextPage
    }
    productReviews(first: 100) {
      items {
        ProductReviewID
      }
      hasNextPage
    }
  }
`;

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
  /** Formatted as "42" or "100+" when DAB has additional pages. */
  totalCustomers: string;
  /** Formatted as "42" or "100+" when DAB has additional pages. */
  totalOrders: string;
  pendingOrders: number;
  /** Formatted as "42" or "100+" when DAB has additional pages. */
  totalReviews: string;
  recentOrders: DashboardOrder[];
}

/** Returns e.g. "42" for an exact count or "100+" when more pages exist. */
const formatCount = (count: number, hasMore: boolean): string =>
  hasMore ? `${count.toLocaleString()}+` : count.toLocaleString();

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

export const useDashboardStats = () => {
  return useQuery<DashboardStats>({
    queryKey: ["dashboardStats"],
    queryFn: async () => {
      const [countData, recentData] = await Promise.all([
        graphqlClient.request<{
          products?: { items: Array<{ ProductID: number }> };
          customers?: {
            items: Array<{ CustomerID: number }>;
            hasNextPage?: boolean;
          };
          salesOrderHeaders?: {
            items: Array<{ SalesOrderID: number; Status: number }>;
            hasNextPage?: boolean;
          };
          productReviews?: {
            items: Array<{ ProductReviewID: number }>;
            hasNextPage?: boolean;
          };
        }>(GET_DASHBOARD_COUNTS),
        graphqlClient.request<{
          salesOrderHeaders?: { items: DashboardOrder[] };
        }>(GET_RECENT_ORDERS),
      ]);

      const orderItems = countData.salesOrderHeaders?.items ?? [];
      // Status 1 (In Process) and 2 (Approved) are considered "pending"
      const pendingOrders = orderItems.filter(
        (o) => o.Status === 1 || o.Status === 2,
      ).length;

      return {
        totalProducts: countData.products?.items?.length ?? 0,
        totalCustomers: formatCount(
          countData.customers?.items?.length ?? 0,
          countData.customers?.hasNextPage ?? false,
        ),
        totalOrders: formatCount(
          orderItems.length,
          countData.salesOrderHeaders?.hasNextPage ?? false,
        ),
        pendingOrders,
        totalReviews: formatCount(
          countData.productReviews?.items?.length ?? 0,
          countData.productReviews?.hasNextPage ?? false,
        ),
        recentOrders: recentData.salesOrderHeaders?.items ?? [],
      };
    },
    staleTime: 2 * 60 * 1000,
  });
};
