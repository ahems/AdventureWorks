export type OrderStatus =
  | "Pending"
  | "Processing"
  | "Shipped"
  | "Delivered"
  | "Cancelled";

export interface OrderItem {
  SalesOrderDetailID: number;
  ProductID: number;
  ProductName: string;
  OrderQty: number;
  UnitPrice: number;
  LineTotal: number;
}

export interface Order {
  SalesOrderID: number;
  CustomerID: number;
  OrderDate: string;
  DueDate: string;
  ShipDate: string | null;
  Status: OrderStatus;
  SubTotal: number;
  TaxAmt: number;
  Freight: number;
  TotalDue: number;
  OrderItems: OrderItem[];
}

// Status workflow transitions — defines valid next statuses for each status
export const ORDER_STATUS_WORKFLOW: Record<OrderStatus, OrderStatus[]> = {
  Pending: ["Processing", "Cancelled"],
  Processing: ["Shipped", "Cancelled"],
  Shipped: ["Delivered"],
  Delivered: [],
  Cancelled: [],
};

export const ORDER_STATUS_CONFIG: Record<
  OrderStatus,
  { label: string; color: string; bgColor: string; icon: string }
> = {
  Pending: {
    label: "Pending",
    color: "text-amber-700",
    bgColor: "bg-amber-100",
    icon: "⏳",
  },
  Processing: {
    label: "Processing",
    color: "text-blue-700",
    bgColor: "bg-blue-100",
    icon: "⚙️",
  },
  Shipped: {
    label: "Shipped",
    color: "text-purple-700",
    bgColor: "bg-purple-100",
    icon: "📦",
  },
  Delivered: {
    label: "Delivered",
    color: "text-green-700",
    bgColor: "bg-green-100",
    icon: "✅",
  },
  Cancelled: {
    label: "Cancelled",
    color: "text-red-700",
    bgColor: "bg-red-100",
    icon: "❌",
  },
};
