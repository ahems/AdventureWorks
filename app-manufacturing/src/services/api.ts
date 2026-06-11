import type {
  Product, ProductModel, ProductCategory, ProductSubcategory,
  ProductDescription, ProductModelProductDescriptionCulture,
  UnitMeasure, BillOfMaterials, WorkOrder, WorkOrderRouting,
  ProductInventory, Location, ScrapReason, ProductCostHistory,
  ProductListPriceHistory, TransactionHistory, Department, Shift,
  PurchaseOrderHeader, PurchaseOrderDetail, Vendor,
  ODataResponse
} from '@/types/production';
import { ODATA_BASE, MANUFACTURING_BASE } from '@/config/api';

const API_BASE = ODATA_BASE;

async function fetchOData<T>(entity: string, params?: Record<string, string>): Promise<T[]> {
  const url = new URL(`${API_BASE}/${entity}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  const data: ODataResponse<T> = await res.json();
  return data.value;
}

async function fetchAllOData<T>(entity: string, params?: Record<string, string>, maxPages = 50): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = `${API_BASE}/${entity}`;
  if (params) {
    const u = new URL(url);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    url = u.toString();
  }
  let page = 0;
  while (url && page < maxPages) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    const data: ODataResponse<T> & { nextLink?: string } = await res.json();
    all.push(...data.value);
    url = data.nextLink || null;
    page++;
  }
  return all;
}

// Products
export const fetchProducts = (filter?: string) =>
  fetchAllOData<Product>('Product', filter ? { $filter: filter } : undefined);

export const fetchManufacturedProducts = () =>
  fetchAllOData<Product>('Product', { $filter: 'MakeFlag eq true' });

export const fetchProduct = (id: number) =>
  fetchOData<Product>('Product', { $filter: `ProductID eq ${id}` }).then(r => r[0] || null);

// Product Models
export const fetchProductModels = () => fetchAllOData<ProductModel>('ProductModel');
export const fetchProductModel = (id: number) =>
  fetchOData<ProductModel>('ProductModel', { $filter: `ProductModelID eq ${id}` }).then(r => r[0] || null);

// Categories (filter to English only — these tables have CultureID)
export const fetchProductCategories = () =>
  fetchAllOData<ProductCategory>('ProductCategory', { $filter: "CultureID eq 'en'" });
export const fetchProductSubcategories = () =>
  fetchAllOData<ProductSubcategory>('ProductSubcategory', { $filter: "CultureID eq 'en'" });

// Descriptions
export const fetchProductDescriptions = () => fetchAllOData<ProductDescription>('ProductDescription');
export const fetchProductModelDescCultures = (modelId?: number) =>
  fetchAllOData<ProductModelProductDescriptionCulture>(
    'ProductModelProductDescriptionCulture',
    modelId ? { $filter: `ProductModelID eq ${modelId} and CultureID eq 'en'` } : { $filter: "CultureID eq 'en'" }
  );

// Unit Measures
export const fetchUnitMeasures = () => fetchAllOData<UnitMeasure>('UnitMeasure');

// BOM
export const fetchBillOfMaterials = () =>
  fetchAllOData<BillOfMaterials>('BillOfMaterials');

export const fetchActiveBOM = () =>
  fetchAllOData<BillOfMaterials>('BillOfMaterials', { $filter: 'EndDate eq null' });

// Work Orders — limited fetches for list views (most recent 500)
export const fetchWorkOrders = () =>
  fetchOData<WorkOrder>('WorkOrder', { $orderby: 'ModifiedDate desc', $first: '500' });

export const fetchWorkOrder = (id: number) =>
  fetchOData<WorkOrder>('WorkOrder', { $filter: `WorkOrderID eq ${id}` }).then(r => r[0] || null);

export const fetchWorkOrdersByProduct = (productId: number) =>
  fetchAllOData<WorkOrder>('WorkOrder', { $filter: `ProductID eq ${productId}` }, 10);

// Work Order Routing
export const fetchWorkOrderRouting = (workOrderId?: number) =>
  fetchAllOData<WorkOrderRouting>(
    'WorkOrderRouting',
    workOrderId
      ? { $filter: `WorkOrderID eq ${workOrderId}` }
      : { $first: '500', $orderby: 'ModifiedDate desc' },
    10
  );
export const fetchRoutingByProduct = (productId: number) =>
  fetchAllOData<WorkOrderRouting>('WorkOrderRouting', { $filter: `ProductID eq ${productId}` }, 10);

// Inventory
export const fetchProductInventory = (productId?: number) =>
  fetchAllOData<ProductInventory>(
    'ProductInventory',
    productId ? { $filter: `ProductID eq ${productId}` } : undefined
  );

// Locations
export const fetchLocations = () => fetchAllOData<Location>('Location');
export const fetchLocation = (id: number) =>
  fetchOData<Location>('Location', { $filter: `LocationID eq ${id}` }).then(r => r[0] || null);

// Scrap Reasons
export const fetchScrapReasons = () => fetchAllOData<ScrapReason>('ScrapReason');

// Costing
export const fetchProductCostHistory = (productId?: number) =>
  fetchAllOData<ProductCostHistory>(
    'ProductCostHistory',
    productId ? { $filter: `ProductID eq ${productId}` } : undefined
  );

export const fetchProductListPriceHistory = (productId?: number) =>
  fetchAllOData<ProductListPriceHistory>(
    'ProductListPriceHistory',
    productId ? { $filter: `ProductID eq ${productId}` } : undefined
  );

// Transactions — limit to avoid huge fetches
export const fetchTransactionHistory = (productId?: number, type?: string) => {
  const filters: string[] = [];
  if (productId) filters.push(`ProductID eq ${productId}`);
  if (type) filters.push(`TransactionType eq '${type}'`);
  return fetchAllOData<TransactionHistory>(
    'TransactionHistory',
    {
      ...(filters.length ? { $filter: filters.join(' and ') } : {}),
      $orderby: 'TransactionDate desc',
      $first: '500',
    },
    10
  );
};

// Departments & Shifts
export const fetchDepartments = () => fetchAllOData<Department>('Department');
export const fetchShifts = () => fetchAllOData<Shift>('Shift');

// ── CRUD helpers ──────────────────────────────────────────────────────────────

async function postEntity<T>(entity: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/${entity}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create failed: ${res.status} — ${text}`);
  }
  const data = await res.json();
  return data.value?.[0] ?? data;
}

async function deleteEntity(entity: string, keyPath: string, options?: { ignoreNotFound?: boolean }): Promise<void> {
  const res = await fetch(`${API_BASE}/${entity}/${keyPath}`, { method: 'DELETE' });
  if (res.status === 404 && options?.ignoreNotFound) return;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Delete failed: ${res.status} — ${text}`);
  }
}

// Products
export const createProduct = (body: Record<string, unknown>) => postEntity<Product>('Product', body);
export const deleteProduct = (id: number) => deleteEntity('Product', `ProductID/${id}`);

// BOM
export const createBOM = (body: Record<string, unknown>) => postEntity<BillOfMaterials>('BillOfMaterials', body);
export const deleteBOM = (id: number) => deleteEntity('BillOfMaterials', `BillOfMaterialsID/${id}`);

// Work Orders
export const createWorkOrder = (body: Record<string, unknown>) => postEntity<WorkOrder>('WorkOrder', body);
export const deleteWorkOrder = (id: number) => deleteEntity('WorkOrder', `WorkOrderID/${id}`, { ignoreNotFound: true });

// Work Order Routing
export const createWorkOrderRouting = (body: Record<string, unknown>) => postEntity<WorkOrderRouting>('WorkOrderRouting', body);
export const deleteWorkOrderRouting = (woId: number, productId: number, opSeq: number) =>
  deleteEntity('WorkOrderRouting', `WorkOrderID/${woId}/ProductID/${productId}/OperationSequence/${opSeq}`);

// Product Models CRUD
export const createProductModel = (body: Record<string, unknown>) => postEntity<ProductModel>('ProductModel', body);
export const deleteProductModel = (id: number) => deleteEntity('ProductModel', `ProductModelID/${id}`);

async function patchEntity(entity: string, keyPath: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_BASE}/${entity}/${keyPath}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Update failed: ${res.status} — ${text}`);
  }
}

export const updateProductModel = (id: number, body: Record<string, unknown>) =>
  patchEntity('ProductModel', `ProductModelID/${id}`, body);

// Update product's model association
export const updateProduct = (id: number, body: Record<string, unknown>) =>
  patchEntity('Product', `ProductID/${id}`, body);

// Update work order
export const updateWorkOrder = (id: number, body: Record<string, unknown>) =>
  patchEntity('WorkOrder', `WorkOrderID/${id}`, body);

// Update inventory quantity (reorder / restock)
export const updateProductInventory = (productId: number, locationId: number, body: Record<string, unknown>) =>
  patchEntity('ProductInventory', `ProductID/${productId}/LocationID/${locationId}`, body);

// Fetch ALL products (including purchased components)
export const fetchAllProducts = () => fetchAllOData<Product>('Product');

// Fetch products by model
export const fetchProductsByModel = (modelId: number) =>
  fetchAllOData<Product>('Product', { $filter: `ProductModelID eq ${modelId}` });

// ── Manufacturing Simulation API ──────────────────────────────────────────────
// MANUFACTURING_BASE is imported from '@/config/api' at the top of this file.

// --- Status types ---

export interface ShortageData {
  workOrderId: number;
  productId: number;
  productName: string;
  needed: number;
  available: number;
  shortfall: number;
  lastRetryUtc: string | null;
}

export interface ScrapEventData {
  workOrderId: number;
  productId: number;
  productName: string;
  locationId: number;
  locationName: string;
  scrapReasonId: number;
  scrapReasonName: string;
  isTotalFailure: boolean;
  failedAtUtc: string;
}

export interface LocationLoadData {
  locationId: number;
  locationName: string;
  earliestFreeSlotUtc: string | null;
  availabilityHrs: number;
  capacityUnits: number;
}

export interface ManufacturingStatus {
  isRunning: boolean;
  queueDepth: number;
  pendingWorkOrders: number;
  inProgressWorkOrders: number;
  completedToday: number;
  stalledForMaterials: number;
  shortages: ShortageData[];
  recentScrapEvents: ScrapEventData[];
  locationLoad: LocationLoadData[];
}

export interface ActiveOperation {
  workOrderId: number;
  productId: number;
  productName: string;
  operationSequence: number;
  locationId: number;
  locationName: string;
  actualStartDate: string;
  elapsedMinutes: number;
}

export async function fetchManufacturingStatus(): Promise<ManufacturingStatus> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/status`);
  if (!res.ok) throw new Error(`Status API error: ${res.status}`);
  return res.json();
}

export async function fetchActiveOperations(): Promise<ActiveOperation[]> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/active`);
  if (!res.ok) throw new Error(`Active ops API error: ${res.status}`);
  return res.json();
}

export async function stopManufacturing(): Promise<void> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Stop API error: ${res.status}`);
}

export interface ManufacturingBeginRequest {
  productId: number;
  orderQty: number;
  dueDate?: string;
}

export interface ManufacturingWarning {
  productId: number;
  name: string;
  required: number;
  available: number;
  shortfall: number;
}

export interface ManufacturingBeginResponse {
  runId: string;
  rootWorkOrderId: number;
  totalWorkOrders: number;
  leafWorkOrders: number;
  warnings: ManufacturingWarning[];
}

export async function beginManufacturingRun(body: ManufacturingBeginRequest): Promise<ManufacturingBeginResponse> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Manufacturing run failed: ${res.status} — ${text}`);
  }
  return res.json();
}

// Scrap Configuration
export interface ScrapConfig {
  locationId: number;
  locationName: string;
  failureRatePct: number;
  scrapReasonIds: number[];
  note: string | null;
}

export async function fetchScrapConfig(): Promise<ScrapConfig[]> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/scrap-config`);
  if (!res.ok) throw new Error(`Scrap config API error: ${res.status}`);
  return res.json();
}

export async function updateScrapConfig(locationId: number, body: { failureRatePct: number; scrapReasonIds: number[]; note?: string }): Promise<ScrapConfig> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/scrap-config/${locationId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Update scrap config failed: ${res.status} — ${text}`);
  }
  return res.json();
}

// Location Configuration
export interface LocationConfig {
  locationId: number;
  locationName: string;
  capacityUnits: number;
  dailyOperatingHours: number;
  speedFactor: number;
  overtimeMultiplier: number;
  shiftStartHour: number;
  note: string | null;
}

export async function fetchLocationConfig(): Promise<LocationConfig[]> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/location-config`);
  if (!res.ok) throw new Error(`Location config API error: ${res.status}`);
  return res.json();
}

export async function updateLocationConfig(locationId: number, body: { capacityUnits?: number; dailyOperatingHours?: number; speedFactor?: number; overtimeMultiplier?: number; shiftStartHour?: number; note?: string }): Promise<LocationConfig> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/location-config/${locationId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Update location config failed: ${res.status} — ${text}`);
  }
  return res.json();
}

// Purchase Orders
export const fetchPurchaseOrderHeaders = (filter?: string) =>
  fetchAllOData<PurchaseOrderHeader>('PurchaseOrderHeader', filter ? { $filter: filter } : undefined);

export const fetchRecentPurchaseOrders = () =>
  fetchOData<PurchaseOrderHeader>('PurchaseOrderHeader', { $orderby: 'PurchaseOrderID desc', $first: '200' });

export const fetchPurchaseOrdersByVendor = (vendorId: number) =>
  fetchAllOData<PurchaseOrderHeader>('PurchaseOrderHeader', { $filter: `VendorID eq ${vendorId}` });

export const fetchPurchaseOrderDetails = (purchaseOrderId: number) =>
  fetchOData<PurchaseOrderDetail>('PurchaseOrderDetail', { $filter: `PurchaseOrderID eq ${purchaseOrderId}` });

export const fetchAllPurchaseOrderDetails = (poIds: number[]) =>
  fetchAllOData<PurchaseOrderDetail>('PurchaseOrderDetail', {
    $filter: poIds.map(id => `PurchaseOrderID eq ${id}`).join(' or ')
  });

// Vendors
export const fetchVendors = () => fetchAllOData<Vendor>('Vendor');

// ── Vendor Quality & Scrap Events ────────────────────────────────────────────

export interface VendorQualityComponentData {
  componentProductId: number;
  componentName: string;
  scrapEvents: number;
  totalFailures: number;
}

export interface VendorQualityData {
  vendorId: number;
  vendorName: string;
  totalScrapEvents: number;
  totalFailures: number;
  affectedWorkOrders: number;
  mostRecentEventUtc: string;
  components: VendorQualityComponentData[];
}

export interface ScrapEventFull {
  workOrderId: number | string;
  productId: number;
  productName: string;
  locationId: number;
  locationName: string;
  scrapReasonId: number;
  scrapReasonName: string;
  scrappedQty: number;
  isTotalFailure: boolean;
  failedAtUtc: string;
  supplierVendorId: number | null;
  supplierVendorName: string | null;
  supplierComponentProductId: number | null;
  supplierComponentName: string | null;
}

export async function fetchVendorQuality(): Promise<VendorQualityData[]> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/vendor-quality`);
  if (!res.ok) throw new Error(`Vendor quality API error: ${res.status}`);
  return res.json();
}

export async function fetchVendorQualityDetail(vendorId: number): Promise<VendorQualityData> {
  const res = await fetch(`${MANUFACTURING_BASE}/manufacturing/vendor-quality/${vendorId}`);
  if (!res.ok) throw new Error(`Vendor quality detail API error: ${res.status}`);
  return res.json();
}

export async function fetchScrapEvents(vendorId?: number): Promise<ScrapEventFull[]> {
  const url = vendorId
    ? `${MANUFACTURING_BASE}/manufacturing/scrap-events?vendorId=${vendorId}`
    : `${MANUFACTURING_BASE}/manufacturing/scrap-events`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Scrap events API error: ${res.status}`);
  return res.json();
}
