import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { fetchOwnedOrderDetails } from "@/services/orderDetails";

export interface OrderItem {
  ProductID: number;
  OrderQty: number;
  UnitPrice: number;
  LineTotal: number;
  product: {
    Name: string;
  };
}

export interface Order {
  SalesOrderID: number;
  OrderDate: string;
  Status: number;
  SubTotal: number;
  TaxAmt: number;
  Freight: number;
  TotalDue: number;
  SalesOrderNumber: string;
  Comment?: string;
  CurrencyRateID?: number;
  salesOrderDetails: {
    items: OrderItem[];
  };
  shipMethod?: {
    Name: string;
  };
  currencyRate?: {
    currency?: {
      CurrencyCode: string;
    };
  };
}

const GET_CUSTOMER_ORDERS = gql`
  query GetCustomerOrders($customerId: Int!) {
    salesOrderHeaders(
      filter: { CustomerID: { eq: $customerId } }
      orderBy: { OrderDate: DESC }
    ) {
      items {
        SalesOrderID
        SalesOrderNumber
        OrderDate
        Status
        SubTotal
        TaxAmt
        Freight
        TotalDue
        Comment
        CurrencyRateID
        shipMethod {
          Name
        }
        currencyRate {
          currency {
            CurrencyCode
          }
        }
      }
    }
  }
`;

export const useOrders = (customerId: number) => {
  return useQuery<Order[]>({
    queryKey: ["orders", customerId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        salesOrderHeaders: { items: Array<Omit<Order, "salesOrderDetails">> };
      }>(GET_CUSTOMER_ORDERS, {
        customerId,
      });
      const orders = data.salesOrderHeaders.items;
      const details = await fetchOwnedOrderDetails(orders.map(order => order.SalesOrderID));
      const detailsByOrder = new Map<number, OrderItem[]>();
      for (const detail of details) {
        const items = detailsByOrder.get(detail.salesOrderId) ?? [];
        items.push({
          ProductID: detail.productId,
          OrderQty: detail.orderQty,
          UnitPrice: detail.unitPrice,
          LineTotal: detail.lineTotal,
          product: { Name: detail.productName },
        });
        detailsByOrder.set(detail.salesOrderId, items);
      }
      return orders.map(order => ({
        ...order,
        salesOrderDetails: { items: detailsByOrder.get(order.SalesOrderID) ?? [] },
      }));
    },
    enabled: !!customerId,
  });
};

export const getOrderStatusText = (status: number): string => {
  const statusMap: Record<number, string> = {
    1: "Pending",
    2: "Approved",
    3: "Backordered",
    4: "Rejected",
    5: "Shipped",
    6: "Cancelled",
    7: "Delivered",
  };
  return statusMap[status] || "Unknown";
};

export const getOrderStatusColor = (status: number): string => {
  const colorMap: Record<number, string> = {
    1: "text-yellow-600 bg-yellow-50 border-yellow-200",
    2: "text-blue-600 bg-blue-50 border-blue-200",
    3: "text-orange-600 bg-orange-50 border-orange-200",
    4: "text-red-600 bg-red-50 border-red-200",
    5: "text-green-600 bg-green-50 border-green-200",
    6: "text-gray-600 bg-gray-50 border-gray-200",
    7: "text-teal-600 bg-teal-50 border-teal-200",
  };
  return colorMap[status] || "text-gray-600 bg-gray-50 border-gray-200";
};
