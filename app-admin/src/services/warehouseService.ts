/**
 * Warehouse API service for the admin app (read-only).
 * Calls the Azure Functions backend warehouse endpoints.
 */

import { getFunctionsApiUrl } from "@/lib/utils";

// ── Types (mirrors WarehouseService DTOs) ─────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const base = getFunctionsApiUrl().replace(/\/$/, "");
  const res = await fetch(`${base}/${path}`);
  if (!res.ok)
    throw new Error(`Warehouse API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

export const fetchWarehouseStatus = (): Promise<WarehouseMetrics> =>
  apiFetch<WarehouseMetrics>("api/warehouse/status");

export const fetchWarehouseActive = (): Promise<WarehouseActiveOperation[]> =>
  apiFetch<WarehouseActiveOperation[]>("api/warehouse/active");

export const fetchWarehouseDamageEvents = (): Promise<WarehouseDamageEvent[]> =>
  apiFetch<WarehouseDamageEvent[]>("api/warehouse/damage-events");
