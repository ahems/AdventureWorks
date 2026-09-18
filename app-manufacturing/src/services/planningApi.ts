import { MANUFACTURING_BASE as BASE } from '@/config/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FeasibilityComponent {
  productId: number;
  name: string;
  requiredPerUnit: number;
  requiredForQty: number;
  currentStock: number;
  canSupportUnits: number;
  shortfallForQty: number;
  isBottleneck: boolean;
}

export interface FeasibilityResult {
  productId: number;
  name: string;
  requestedQty: number;
  maxProducibleNow: number;
  maxProducibleWithProcurement: number;
  procurementCostToMeetRequest: number;
  bottleneckComponentName: string | null;
  components: FeasibilityComponent[];
}

export interface FinishedGoodSnapshot {
  productId: number;
  name: string;
  productNumber: string | null;
  listPrice: number;
  estimatedCogs: number;
  grossMarginPct: number;
  pricingSignal: 'healthy' | 'thin-margin' | 'loss-making' | 'no-price';
  currentStockQty: number;
  salesLast30Days: number;
  weeksOfSupply: number;
  inventorySignal: 'healthy' | 'overstock' | 'low-stock' | 'out-of-stock';
  maxProducibleNow: number;
}

export interface BomCostLine {
  productId: number;
  name: string;
  requiredPerUnit: number;
  standardCost: number;
  costContribution: number;
  isPurchased: boolean;
}

export interface CostAnalysis {
  productId: number;
  productName: string;
  listPrice: number;
  materialCost: number;
  routingCost: number;
  estimatedCogs: number;
  grossMarginPct: number;
  pricingSignal: string;
  bomLines: BomCostLine[];
}

export interface CurrentBomCostLine {
  productId: number;
  name: string;
  requiredPerUnit: number;
  currentCost: number;
  costDate: string | null;
  costContribution: number;
  isPurchased: boolean;
  costSource: 'ProductCostHistory' | 'ProductVendor.LastReceiptCost' | 'Product.StandardCost';
}

export interface CurrentCostAnalysis {
  productId: number;
  productName: string;
  listPrice: number;
  currentMaterialCost: number;
  estimatedRoutingCost: number;
  totalManufacturingCost: number;
  grossMarginPct: number;
  pricingSignal: string;
  costAsOf: string;
  bomBreakdown: CurrentBomCostLine[];
}

export interface AffectedFinishedGood {
  productId: number;
  name: string;
  requiredPerUnit: number;
  dailySalesRate: number;
}

export interface ComponentShortage {
  componentProductId: number;
  componentName: string;
  currentStock: number;
  dailyConsumptionRate: number;
  daysUntilStockout: number;
  weeksUntilStockout: number;
  urgencyLevel: 'critical' | 'warning' | 'watch' | 'ok';
  affectedProducts: AffectedFinishedGood[];
}

export interface ShortageForecastResponse {
  forecastDays: number;
  critical: number;
  warning: number;
  watch: number;
  items: ComponentShortage[];
}

export interface ReorderVendorOption {
  vendorId: string;
  vendorName: string;
  stockAvailable: number;
  canFulfillOrder: boolean;
  unitCost: number;
  totalCost: number;
  estimatedDeliveryRealMins: number;
  reliabilityPct: number;
  leadTimeDays: number;
}

export interface ReorderRecommendation {
  componentProductId: number;
  componentName: string;
  currentStock: number;
  daysUntilStockout: number;
  urgencyLevel: string;
  suggestedOrderQty: number;
  bestVendor: ReorderVendorOption | null;
  allVendors: ReorderVendorOption[];
}

export interface ReorderRecommendationsResponse {
  forecastDays: number;
  totalRecommendations: number;
  estimatedTotalProcurementCost: number;
  items: ReorderRecommendation[];
}

export interface WorkforceSnapshot {
  totalActiveWorkers: number;
  currentlyWorking: number;
  availableNow: number;
  offShift: number;
  unavailable: number;
  byLocation: LocationWorkforce[];
}

export interface LocationWorkforce {
  locationId: number;
  locationName: string;
  headcount: number;
  available: number;
  working: number;
  offShift: number;
}

export interface WorkerStatus {
  employeeId: number;
  name: string;
  jobTitle: string;
  locationId: number;
  locationName: string;
  shiftId: number;
  shiftName: string;
  status: 'available' | 'working' | 'off-shift' | 'unavailable';
  currentWorkOrderId: number | null;
  currentOperation: string | null;
  hourlyRate: number;
  tenureYears: number;
  scrapRateMultiplier: number;
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function fetchFeasibility(productId: number, qty = 1): Promise<FeasibilityResult> {
  const res = await fetch(`${BASE}/plan/feasibility/${productId}?qty=${qty}`);
  if (!res.ok) throw new Error(`Feasibility error: ${res.status}`);
  return res.json();
}

export async function fetchAllFeasibility(qty = 1): Promise<FinishedGoodSnapshot[]> {
  const res = await fetch(`${BASE}/plan/feasibility?qty=${qty}`);
  if (!res.ok) throw new Error(`Feasibility all error: ${res.status}`);
  return res.json();
}

export async function fetchCostAnalysis(productId: number): Promise<CostAnalysis> {
  const res = await fetch(`${BASE}/plan/cost/${productId}`);
  if (!res.ok) throw new Error(`Cost analysis error: ${res.status}`);
  return res.json();
}

export async function fetchCurrentCost(productId: number): Promise<CurrentCostAnalysis> {
  const res = await fetch(`${BASE}/plan/cost/${productId}/current`);
  if (!res.ok) throw new Error(`Current cost error: ${res.status}`);
  return res.json();
}

export async function fetchPlanCatalog(inventorySignal?: string, pricingSignal?: string): Promise<FinishedGoodSnapshot[]> {
  const params = new URLSearchParams();
  if (inventorySignal) params.set('inventorySignal', inventorySignal);
  if (pricingSignal) params.set('pricingSignal', pricingSignal);
  const qs = params.toString();
  const res = await fetch(`${BASE}/plan/catalog${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`Plan catalog error: ${res.status}`);
  return res.json();
}

export async function fetchOverstock(minWeeks = 12): Promise<{ thresholdWeeksOfSupply: number; count: number; signal: string; items: FinishedGoodSnapshot[] }> {
  const res = await fetch(`${BASE}/plan/overstock?minWeeks=${minWeeks}`);
  if (!res.ok) throw new Error(`Overstock error: ${res.status}`);
  return res.json();
}

export async function fetchThinMargin(maxMarginPct = 0.20): Promise<{ thresholdMarginPct: number; count: number; signal: string; items: FinishedGoodSnapshot[] }> {
  const res = await fetch(`${BASE}/plan/thin-margin?maxMarginPct=${maxMarginPct}`);
  if (!res.ok) throw new Error(`Thin margin error: ${res.status}`);
  return res.json();
}

export async function fetchShortageForecast(days = 90): Promise<ShortageForecastResponse> {
  const res = await fetch(`${BASE}/plan/shortage-forecast?days=${days}`);
  if (!res.ok) throw new Error(`Shortage forecast error: ${res.status}`);
  return res.json();
}

export async function fetchReorderRecommendations(days = 60): Promise<ReorderRecommendationsResponse> {
  const res = await fetch(`${BASE}/plan/reorder-recommendations?days=${days}`);
  if (!res.ok) throw new Error(`Reorder recommendations error: ${res.status}`);
  return res.json();
}

export async function fetchWorkforce(): Promise<WorkforceSnapshot> {
  const res = await fetch(`${BASE}/manufacturing/workforce`);
  if (!res.ok) throw new Error(`Workforce error: ${res.status}`);
  return res.json();
}

export async function fetchWorkforceDetail(): Promise<WorkerStatus[]> {
  const res = await fetch(`${BASE}/manufacturing/workforce/detail`);
  if (!res.ok) throw new Error(`Workforce detail error: ${res.status}`);
  return res.json();
}
