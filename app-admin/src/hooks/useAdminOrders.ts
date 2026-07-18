import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { Order, OrderItem } from "@/types/order";
import { getFunctionsApiUrl } from "@/lib/utils";

// SalesOrderHeader.Status codes:
// 1=In Process, 2=Approved, 3=Backordered, 4=Rejected, 5=Shipped, 6=Cancelled, 7=Delivered
export const DB_STATUS_TO_LABEL: Record<number, string> = {
  1: "Processing",
  2: "Approved",
  3: "Backordered",
  4: "Rejected",
  5: "Shipped",
  6: "Cancelled",
  7: "Delivered",
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
    case 7:
      return "Delivered";
    default:
      return "Pending";
  }
};

// Map UI OrderStatus back to the DB status codes used in SalesOrderHeader
export const orderStatusToDbStatuses = (status: Order["Status"]): number[] => {
  switch (status) {
    case "Processing":
      return [1];
    case "Shipped":
      return [5];
    case "Cancelled":
      return [6];
    case "Delivered":
      return [7];
    case "Pending":
      return [2, 3, 4]; // Approved, Backordered, Rejected
    default:
      return [];
  }
};

export interface AdminOrdersFilter {
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string; // YYYY-MM-DD
  statuses?: number[]; // DB status codes
}

const buildOrdersFilter = (
  filter: AdminOrdersFilter,
): Record<string, unknown> | undefined => {
  const conditions: Record<string, unknown>[] = [];

  if (filter.statuses && filter.statuses.length > 0) {
    if (filter.statuses.length === 1) {
      conditions.push({ Status: { eq: filter.statuses[0] } });
    } else {
      conditions.push({
        or: filter.statuses.map((s) => ({ Status: { eq: s } })),
      });
    }
  }

  if (filter.dateFrom) {
    conditions.push({ OrderDate: { gte: `${filter.dateFrom}T00:00:00` } });
  }
  if (filter.dateTo) {
    conditions.push({ OrderDate: { lte: `${filter.dateTo}T23:59:59` } });
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { and: conditions };
};

const GET_ORDERS_ADMIN = gql`
  query GetOrdersAdmin($after: String, $filter: SalesOrderHeaderFilterInput) {
    salesOrderHeaders(
      first: 100
      after: $after
      orderBy: { OrderDate: DESC }
      filter: $filter
    ) {
      items {
        SalesOrderID
        CustomerID
        OrderDate
        DueDate
        ShipDate
        Status
        OnlineOrderFlag
        SubTotal
        TaxAmt
        Freight
        TotalDue
        customer {
          PersonID
          person {
            FirstName
            LastName
          }
          store {
            Name
          }
        }
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
  OnlineOrderFlag?: boolean;
  SubTotal?: number;
  TaxAmt?: number;
  Freight?: number;
  TotalDue?: number;
  customer?: {
    PersonID?: number | null;
    person?: { FirstName?: string; LastName?: string } | null;
    store?: { Name?: string } | null;
  };
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

const normalizeDisplayValue = (value?: string | null): string => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";

  switch (trimmed.toLowerCase()) {
    case "n/a":
    case "na":
    case "none":
    case "null":
    case "unknown":
    case "not applicable":
      return "";
    default:
      return trimmed;
  }
};

const mapOrder = (header: RawOrderHeader): Order => {
  // Build customer name from person or store
  let customerName = `Customer #${header.CustomerID}`;
  const personId = header.customer?.PersonID ?? null;

  if (header.customer?.person) {
    const firstName = normalizeDisplayValue(header.customer.person.FirstName);
    const lastName = normalizeDisplayValue(header.customer.person.LastName);
    if (firstName || lastName) {
      customerName = `${firstName} ${lastName}`.trim();
    }
  } else if (header.customer?.store?.Name) {
    customerName = header.customer.store.Name;
  }

  return {
    SalesOrderID: header.SalesOrderID,
    CustomerID: header.CustomerID,
    PersonID: personId,
    CustomerName: customerName,
    OrderDate: header.OrderDate,
    DueDate: header.DueDate,
    ShipDate: header.ShipDate,
    Status: dbStatusToOrderStatus(header.Status),
    OnlineOrderFlag: header.OnlineOrderFlag ?? true,
    SubTotal: header.SubTotal,
    TaxAmt: header.TaxAmt,
    Freight: header.Freight,
    TotalDue: header.TotalDue,
    OrderItems: (header.salesOrderDetails?.items ?? []).map(mapOrderItem),
  };
};

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

export const useShipOrder = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (salesOrderId: number) => {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/orders/${salesOrderId}/ship`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
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
        customer {
          PersonID
          person {
            FirstName
            LastName
          }
          store {
            Name
          }
        }
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

export const useAdminOrders = (filter: AdminOrdersFilter = {}) => {
  const { dateFrom, dateTo, statuses } = filter;
  return useQuery<Order[]>({
    queryKey: ["admin", "orders", dateFrom, dateTo, statuses],
    enabled: !statuses || statuses.length > 0,
    queryFn: async () => {
      const allItems: Order[] = [];
      let cursor: string | null = null;
      let hasMore = true;
      const filterVar = buildOrdersFilter(filter);
      while (hasMore) {
        const data = await graphqlClient.request<{
          salesOrderHeaders?: {
            items: RawOrderHeader[];
            hasNextPage?: boolean;
            endCursor?: string;
          };
        }>(GET_ORDERS_ADMIN, { after: cursor, filter: filterVar });
        const page = data.salesOrderHeaders;
        allItems.push(...(page?.items ?? []).map(mapOrder));
        hasMore = page?.hasNextPage ?? false;
        cursor = page?.endCursor ?? null;
      }
      return allItems;
    },
    staleTime: 2 * 60 * 1000,
  });
};

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
