import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { Order, OrderItem } from "@/types/order";
import { getFunctionsApiUrl } from "@/lib/utils";

// SalesOrderHeader.Status codes:
// 1=In Process, 2=Approved, 3=Backordered, 4=Rejected, 5=Shipped, 6=Cancelled
export const DB_STATUS_TO_LABEL: Record<number, string> = {
  1: "Processing",
  2: "Approved",
  3: "Backordered",
  4: "Rejected",
  5: "Shipped",
  6: "Cancelled",
};

// Map DB status to the OrderStatus union type used in the admin UI
export const dbStatusToOrderStatus = (status: number): Order["Status"] => {
  switch (status) {
    case 1:
      return "Processing";
    case 5:
      return "Shipped";
    case 6:
      return "Cancelled";
    default:
      return "Pending";
  }
};

const GET_ORDERS_ADMIN = gql`
  query GetOrdersAdmin($after: String) {
    salesOrderHeaders(first: 100, after: $after, orderBy: { OrderDate: DESC }) {
      items {
        SalesOrderID
        CustomerID
        OrderDate
        DueDate
        ShipDate
        Status
        SubTotal
        TaxAmt
        Freight
        TotalDue
        salesOrderDetails {
          items {
            SalesOrderDetailID
            ProductID
            OrderQty
            UnitPrice
            LineTotal
            product {
              Name
            }
          }
        }
      }
      hasNextPage
      endCursor
    }
  }
`;

interface RawOrderDetail {
  SalesOrderDetailID: number;
  ProductID: number;
  OrderQty: number;
  UnitPrice: number;
  LineTotal: number;
  product?: { Name?: string };
}

interface RawOrderHeader {
  SalesOrderID: number;
  CustomerID: number;
  OrderDate?: string;
  DueDate?: string;
  ShipDate?: string;
  Status: number;
  SubTotal?: number;
  TaxAmt?: number;
  Freight?: number;
  TotalDue?: number;
  salesOrderDetails?: { items: RawOrderDetail[] };
}

const mapOrderItem = (detail: RawOrderDetail): OrderItem => ({
  SalesOrderDetailID: detail.SalesOrderDetailID,
  ProductID: detail.ProductID,
  ProductName: detail.product?.Name ?? `Product #${detail.ProductID}`,
  OrderQty: detail.OrderQty,
  UnitPrice: detail.UnitPrice,
  LineTotal: detail.LineTotal,
});

const mapOrder = (header: RawOrderHeader): Order => ({
  SalesOrderID: header.SalesOrderID,
  CustomerID: header.CustomerID,
  OrderDate: header.OrderDate,
  DueDate: header.DueDate,
  ShipDate: header.ShipDate,
  Status: dbStatusToOrderStatus(header.Status),
  SubTotal: header.SubTotal,
  TaxAmt: header.TaxAmt,
  Freight: header.Freight,
  TotalDue: header.TotalDue,
  OrderItems: (header.salesOrderDetails?.items ?? []).map(mapOrderItem),
});

export interface PagedOrders {
  items: Order[];
  hasNextPage: boolean;
  endCursor: string;
}

const CANCEL_ORDER_MUTATION = gql`
  mutation CancelOrder($id: Int!) {
    updateSalesOrderHeader(SalesOrderID: $id, item: { Status: 6 }) {
      SalesOrderID
      Status
    }
  }
`;

export const useCancelOrder = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (salesOrderId: number) => {
      await graphqlClient.request(CANCEL_ORDER_MUTATION, { id: salesOrderId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
    },
  });
};

const GET_ORDER_BY_ID = gql`
  query GetOrderById($id: Int!) {
    salesOrderHeaders(filter: { SalesOrderID: { eq: $id } }) {
      items {
        SalesOrderID
        CustomerID
        OrderDate
        DueDate
        ShipDate
        Status
        SubTotal
        TaxAmt
        Freight
        TotalDue
        salesOrderDetails {
          items {
            SalesOrderDetailID
            ProductID
            OrderQty
            UnitPrice
            LineTotal
            product {
              Name
            }
          }
        }
      }
    }
  }
`;

export const useOrderById = (orderId: number | null) =>
  useQuery<Order | null>({
    queryKey: ["admin", "order", orderId],
    enabled: orderId !== null,
    queryFn: async () => {
      const data = await graphqlClient.request<{
        salesOrderHeaders?: { items: RawOrderHeader[] };
      }>(GET_ORDER_BY_ID, { id: orderId });
      const item = data.salesOrderHeaders?.items?.[0];
      return item ? mapOrder(item) : null;
    },
    staleTime: 2 * 60 * 1000,
  });

export const useAdminOrders = (after?: string | null) =>
  useQuery<PagedOrders>({
    queryKey: ["admin", "orders", after ?? null],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        salesOrderHeaders?: {
          items: RawOrderHeader[];
          hasNextPage?: boolean;
          endCursor?: string;
        };
      }>(GET_ORDERS_ADMIN, { after: after ?? null });
      return {
        items: (data.salesOrderHeaders?.items ?? []).map(mapOrder),
        hasNextPage: data.salesOrderHeaders?.hasNextPage ?? false,
        endCursor: data.salesOrderHeaders?.endCursor ?? "",
      };
    },
    staleTime: 2 * 60 * 1000,
  });

export const useReceiptStatus = (salesOrderId: number | null) =>
  useQuery<{ exists: boolean }>({
    queryKey: ["receipt-status", salesOrderId],
    enabled: salesOrderId !== null,
    queryFn: async () => {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/orders/${salesOrderId}/receipt-status`,
      );
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      return res.json();
    },
    staleTime: 30 * 1000,
  });
