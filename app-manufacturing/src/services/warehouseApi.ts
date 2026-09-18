/**
 * Warehouse Simulation API service.
 * Calls the Azure Functions backend at MANUFACTURING_BASE/warehouse/*
 * The warehouse is always-on and event-driven — no start/stop endpoints.
 */

import { MANUFACTURING_BASE } from "@/config/api";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WarehouseMetrics {
  queueDepth: number;
  activeOperations: number;
  storedToday: number;
  retrievedToday: number;
  receivedToday: number;
  damageEventsToday: number;
  totalUnitsHandledToday: number;
  workerUtilisationPct: number;
  workersByShift: WarehouseShiftHeadcount[];
}

export interface WarehouseShiftHeadcount {
  shiftId: number;
  shiftName: string;
  headcount: number;
  available: number;
  working: number;
  offShift: number;
}

export interface WarehouseWorkerSnapshot {
  totalWorkers: number;
  currentlyWorking: number;
  availableNow: number;
  offShift: number;
  unavailable: number;
  byShift: WarehouseShiftHeadcount[];
}

export interface WarehouseWorkerStatus {
  employeeId: number;
  name: string;
  jobTitle: string;
  shiftId: number;
  shiftName: string;
  status: "available" | "working" | "off-shift" | "unavailable";
  currentOperationId: string | null;
  currentOperation: string | null;
  hourlyRate: number;
  tenureYears: number;
}

export interface WarehouseActiveOperation {
  operationId: string;
  operationType: "Store" | "Retrieve" | "ReceiveSupplier";
  productId: number;
  productName: string;
  quantity: number;
  assignedEmployeeId: number | null;
  assignedWorkerName: string | null;
  scheduledStartUtc: string;
  scheduledCompletionUtc: string;
  elapsedMinutes: number;
  sourceReferenceId: number | null;
}

export interface WarehouseDamageEvent {
  operationId: string;
  operationType: string;
  productId: number;
  productName: string;
  quantity: number;
  damagedUnits: number;
  damageReasonId: number;
  damageReasonName: string;
  isTotalLoss: boolean;
  writeOffValue: number;
  occurredAtUtc: string;
}

export interface SubcategoryHandlingConfig {
  subcategoryId: number;
  subcategoryName: string;
  storeMinMinutes: number;
  storeMaxMinutes: number;
  retrieveMinMinutes: number;
  retrieveMaxMinutes: number;
  baseWeightKgThreshold: number;
  note: string | null;
}

export interface SupplierReceiveConfig {
  subcategoryId: number;
  subcategoryName: string;
  receiveMinMinutes: number;
  receiveMaxMinutes: number;
  inspectionMinMinutes: number;
  inspectionMaxMinutes: number;
  additionalMinutesPerUnit: number;
  note: string | null;
}

export interface WarehouseDamageConfig {
  operationType: string;
  damageRatePct: number;
  damageReasonIds: number[];
  note: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MANUFACTURING_BASE}/${path}`, init);
  if (!res.ok)
    throw new Error(`Warehouse API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ── Status & Monitoring ───────────────────────────────────────────────────────

export const fetchWarehouseStatus = (): Promise<WarehouseMetrics> =>
  apiFetch<WarehouseMetrics>("warehouse/status");

export const fetchWarehouseActive = (): Promise<WarehouseActiveOperation[]> =>
  apiFetch<WarehouseActiveOperation[]>("warehouse/active");

export const fetchWarehouseWorkforce = (): Promise<WarehouseWorkerSnapshot> =>
  apiFetch<WarehouseWorkerSnapshot>("warehouse/workforce");

export const fetchWarehouseWorkforceDetail = (): Promise<
  WarehouseWorkerStatus[]
> => apiFetch<WarehouseWorkerStatus[]>("warehouse/workforce/detail");

export const fetchWarehouseMetrics = (): Promise<WarehouseMetrics> =>
  apiFetch<WarehouseMetrics>("warehouse/metrics");

export const fetchWarehouseDamageEvents = (
  operationType?: string,
): Promise<WarehouseDamageEvent[]> =>
  apiFetch<WarehouseDamageEvent[]>(
    operationType
      ? `warehouse/damage-events?type=${operationType}`
      : "warehouse/damage-events",
  );

// ── Configuration ─────────────────────────────────────────────────────────────

export const fetchSubcategoryConfigs = (): Promise<
  SubcategoryHandlingConfig[]
> => apiFetch<SubcategoryHandlingConfig[]>("warehouse/subcategory-config");

export const updateSubcategoryConfig = (
  id: number,
  body: {
    storeMinMinutes: number;
    storeMaxMinutes: number;
    retrieveMinMinutes: number;
    retrieveMaxMinutes: number;
    baseWeightKgThreshold: number;
    note?: string;
  },
): Promise<SubcategoryHandlingConfig> =>
  apiFetch<SubcategoryHandlingConfig>(`warehouse/subcategory-config/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const fetchSupplierReceiveConfigs = (): Promise<
  SupplierReceiveConfig[]
> => apiFetch<SupplierReceiveConfig[]>("warehouse/supplier-receive-config");

export const updateSupplierReceiveConfig = (
  id: number,
  body: {
    receiveMinMinutes: number;
    receiveMaxMinutes: number;
    inspectionMinMinutes: number;
    inspectionMaxMinutes: number;
    additionalMinutesPerUnit: number;
    note?: string;
  },
): Promise<SupplierReceiveConfig> =>
  apiFetch<SupplierReceiveConfig>(`warehouse/supplier-receive-config/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const fetchDamageConfigs = (): Promise<WarehouseDamageConfig[]> =>
  apiFetch<WarehouseDamageConfig[]>("warehouse/damage-config");

export const updateDamageConfig = (
  operationType: string,
  body: { damageRatePct: number; damageReasonIds: number[]; note?: string },
): Promise<WarehouseDamageConfig> =>
  apiFetch<WarehouseDamageConfig>(`warehouse/damage-config/${operationType}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ── Constants ─────────────────────────────────────────────────────────────────

export const DAMAGE_REASON_NAMES: Record<number, string> = {
  1: "Dropped during handling",
  2: "Forklift impact",
  3: "Crushed by stacking",
  4: "Water / moisture damage",
  5: "Packaging failure in transit",
  6: "Caught on racking",
  7: "Label / barcode damaged",
  8: "Temperature damage",
};

export const OP_TYPE_LABELS: Record<string, string> = {
  store: "Store (finished goods)",
  retrieve: "Retrieve (order pick)",
  receive: "Receive (supplier delivery)",
};
