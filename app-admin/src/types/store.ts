export interface StoreListItem {
  storeBusinessEntityId: number;
  storeName: string;
  salesPersonID: number | null;
  salesRepFirstName: string | null;
  salesRepLastName: string | null;
  customerID: number;
  territoryID: number | null;
  territoryName: string | null;
  addressID: number | null;
  addressLine1: string | null;
  city: string | null;
  stateProvince: string | null;
  country: string | null;
  countryCode: string | null;
  orderCount: number;
  totalRevenue: number;
  lastOrderDate: string | null;
}

export interface StoreDetail extends StoreListItem {
  salesRepEmail: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  territoryCountry: string | null;
}

export interface StoreOrderSummary {
  salesOrderID: number;
  orderDate: string;
  dueDate: string;
  shipDate: string | null;
  status: number;
  purchaseOrderNumber: string | null;
  subTotal: number;
  taxAmt: number;
  freight: number;
  totalDue: number;
  onlineOrderFlag: boolean;
  comment: string | null;
  shipMethodName: string | null;
  lineItemCount: number;
}

export interface StoreProductInfo {
  productID: number;
  productName: string;
  productNumber: string | null;
  color: string | null;
  size: string | null;
  unitPrice: number;
  standardCost: number;
  categoryName: string | null;
  subcategoryName: string | null;
  stockQty: number;
  isDiscontinued: boolean;
}

export interface StoreOrderLineItem {
  productId: number;
  productName: string;
  productNumber: string | null;
  unitPrice: number;
  quantity: number;
  discountPct: number;
  lineTotal: number;
  /** Original ordered quantity (only set during reorder flow) */
  originalQty?: number;
  /** Current stock available (only set during reorder flow) */
  stockQty?: number;
}

export interface PlaceStoreOrderPayload {
  storeBusinessEntityId: number;
  items: Array<{
    productId: number;
    quantity: number;
    unitPrice: number;
    discountPct: number;
  }>;
  shipMethodId: number;
  purchaseOrderNumber?: string;
  dueDate?: string;
  comment?: string;
}

export interface TerritoryStoreSummary {
  territoryID: number;
  territoryName: string;
  countryCode: string;
  countryName: string;
  storeCount: number;
  activeStoreCount: number;
  totalRevenue: number;
  totalOrders: number;
  avgRevenuePerStore: number;
  lastOrderDate: string | null;
}

export interface OrderLineDetail {
  salesOrderDetailID: number;
  productID: number;
  productName: string;
  productNumber: string | null;
  orderQty: number;
  unitPrice: number;
  unitPriceDiscount: number;
  lineTotal: number;
  stockQty: number;
}

export interface ProductSubcategoryInfo {
  subcategoryID: number;
  subcategoryName: string;
  productCount: number;
}

export interface ProductCategoryInfo {
  categoryID: number;
  categoryName: string;
  productCount: number;
  subcategories: ProductSubcategoryInfo[];
}
