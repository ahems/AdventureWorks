// Product-related
export interface Product {
  ProductID: number;
  Name: string;
  ProductNumber: string;
  MakeFlag: boolean;
  FinishedGoodsFlag: boolean;
  Color: string | null;
  SafetyStockLevel: number;
  ReorderPoint: number;
  StandardCost: number;
  ListPrice: number;
  Size: string | null;
  SizeUnitMeasureCode: string | null;
  WeightUnitMeasureCode: string | null;
  Weight: number | null;
  DaysToManufacture: number;
  ProductLine: string | null;
  Class: string | null;
  Style: string | null;
  ProductSubcategoryID: number | null;
  ProductModelID: number | null;
  SellStartDate: string;
  SellEndDate: string | null;
  DiscontinuedDate: string | null;
  ModifiedDate: string;
}

export interface ProductModel {
  ProductModelID: number;
  Name: string;
  CatalogDescription: string | null;
  Instructions: string | null;
  ModifiedDate: string;
}

export interface ProductCategory {
  ProductCategoryID: number;
  CultureID: string;
  Name: string;
  ModifiedDate: string;
}

export interface ProductSubcategory {
  ProductSubcategoryID: number;
  ProductCategoryID: number;
  CultureID: string;
  Name: string;
  ModifiedDate: string;
}

export interface ProductDescription {
  ProductDescriptionID: number;
  Description: string;
  ModifiedDate: string;
}

export interface ProductModelProductDescriptionCulture {
  ProductModelID: number;
  ProductDescriptionID: number;
  CultureID: string;
  ModifiedDate: string;
}

export interface UnitMeasure {
  UnitMeasureCode: string;
  Name: string;
  ModifiedDate: string;
}

// BOM
export interface BillOfMaterials {
  BillOfMaterialsID: number;
  ProductAssemblyID: number | null;
  ComponentID: number;
  StartDate: string;
  EndDate: string | null;
  UnitMeasureCode: string;
  BOMLevel: number;
  PerAssemblyQty: number;
  ModifiedDate: string;
}

// Work Orders
export interface WorkOrder {
  WorkOrderID: number;
  ProductID: number;
  OrderQty: number;
  StockedQty: number;
  ScrappedQty: number;
  StartDate: string;
  EndDate: string | null;
  DueDate: string;
  ScrapReasonID: number | null;
  ModifiedDate: string;
}

export interface WorkOrderRouting {
  WorkOrderID: number;
  ProductID: number;
  OperationSequence: number;
  LocationID: number;
  ScheduledStartDate: string;
  ScheduledEndDate: string;
  ActualStartDate: string | null;
  ActualEndDate: string | null;
  ActualResourceHrs: number | null;
  PlannedCost: number;
  ActualCost: number | null;
  ModifiedDate: string;
}

// Inventory
export interface ProductInventory {
  ProductID: number;
  LocationID: number;
  Shelf: string;
  Bin: number;
  Quantity: number;
  ModifiedDate: string;
}

export interface Location {
  LocationID: number;
  Name: string;
  CostRate: number;
  Availability: number;
  ModifiedDate: string;
}

// Scrap
export interface ScrapReason {
  ScrapReasonID: number;
  Name: string;
  ModifiedDate: string;
}

// Costing
export interface ProductCostHistory {
  ProductID: number;
  StartDate: string;
  EndDate: string | null;
  StandardCost: number;
  ModifiedDate: string;
}

export interface ProductListPriceHistory {
  ProductID: number;
  StartDate: string;
  EndDate: string | null;
  ListPrice: number;
  ModifiedDate: string;
}

// Transactions
export interface TransactionHistory {
  TransactionID: number;
  ProductID: number;
  ReferenceOrderID: number;
  ReferenceOrderLineID: number;
  TransactionDate: string;
  TransactionType: string;
  Quantity: number;
  ActualCost: number;
  ModifiedDate: string;
}

// Department & Shift
export interface Department {
  DepartmentID: number;
  Name: string;
  GroupName: string;
  ModifiedDate: string;
}

export interface Shift {
  ShiftID: number;
  Name: string;
  StartTime: string;
  EndTime: string;
  ModifiedDate: string;
}

// API response
export interface ODataResponse<T> {
  value: T[];
  nextLink?: string;
}

// BOM tree node for UI
export interface BomTreeNode {
  bomId: number;
  componentId: number;
  componentName: string;
  perAssemblyQty: number;
  unitMeasureCode: string;
  standardCost: number;
  bomLevel: number;
  children: BomTreeNode[];
  totalCost: number;
}

// Purchasing
export interface PurchaseOrderHeader {
  PurchaseOrderID: number;
  RevisionNumber: number;
  Status: number; // 1=Pending 2=Approved 3=Rejected 4=Complete
  EmployeeID: number;
  VendorID: number;
  ShipMethodID: number;
  OrderDate: string;
  ShipDate: string | null;
  SubTotal: number;
  TaxAmt: number;
  Freight: number;
  TotalDue: number;
  ModifiedDate: string;
}

export interface PurchaseOrderDetail {
  PurchaseOrderID: number;
  PurchaseOrderDetailID: number;
  DueDate: string;
  OrderQty: number;
  ProductID: number;
  UnitPrice: number;
  LineTotal: number;
  ReceivedQty: number;
  RejectedQty: number;
  StockedQty: number;
  ModifiedDate: string;
}

// Sales Orders (customer demand)
export interface SalesOrderHeader {
  SalesOrderID: number;
  RevisionNumber: number;
  OrderDate: string;
  DueDate: string;
  ShipDate: string | null;
  Status: number; // 1=InProcess 2=Approved 3=Backordered 4=Rejected 5=Shipped 6=Cancelled
  OnlineOrderFlag: boolean;
  SalesOrderNumber: string;
  PurchaseOrderNumber: string | null;
  AccountNumber: string | null;
  CustomerID: number;
  SalesPersonID: number | null;
  TerritoryID: number | null;
  BillToAddressID: number;
  ShipToAddressID: number;
  ShipMethodID: number;
  SubTotal: number;
  TaxAmt: number;
  Freight: number;
  TotalDue: number;
  Comment: string | null;
  ModifiedDate: string;
}

export interface SalesOrderDetail {
  SalesOrderID: number;
  SalesOrderDetailID: number;
  CarrierTrackingNumber: string | null;
  OrderQty: number;
  ProductID: number;
  SpecialOfferID: number;
  UnitPrice: number;
  UnitPriceDiscount: number;
  LineTotal: number;
  ModifiedDate: string;
}

export const SALES_ORDER_STATUS: Record<number, string> = {
  1: 'In process',
  2: 'Approved',
  3: 'Backordered',
  4: 'Rejected',
  5: 'Shipped',
  6: 'Cancelled',
};

// Vendor
export interface Vendor {
  BusinessEntityID: number;
  AccountNumber: string;
  Name: string;
  CreditRating: number;
  PreferredVendorStatus: boolean;
  ActiveFlag: boolean;
  PurchasingWebServiceURL: string | null;
  ModifiedDate: string;
}
