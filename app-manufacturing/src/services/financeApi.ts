import { MANUFACTURING_BASE as BASE } from "@/config/api";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BankAccountBalance {
  currencyCode: string;
  currencyName: string;
  balance: number;
}

export interface BankStatusResponse {
  accounts: BankAccountBalance[];
  totalUsd: number;
  reportedAtUtc: string;
}

export interface FinancialSummary {
  procurement: {
    totalSpend: number;
    totalRefunds: number;
    netSpend: number;
    transactionCount: number;
  };
  manufacturing: {
    totalCost: number;
    transactionCount: number;
  };
  payroll: {
    totalCost: number;
    transactionCount: number;
  };
  scrap: {
    totalWriteOffs: number;
    transactionCount: number;
  };
  revenue: {
    totalRevenue: number;
    transactionCount: number;
  };
  totals: {
    totalOperatingCost: number;
    totalAllSpend: number;
  };
  generatedAtUtc: string;
}

export interface BankTransaction {
  transactionId: string;
  currencyCode: string;
  amount: number;
  balanceAfter: number;
  transactionType: string;
  description: string;
  referenceId: string | null;
  transactedAtUtc: string;
}

// ── API calls ────────────────────────────────────────────────────────────────

export async function fetchBankStatus(): Promise<BankStatusResponse> {
  const res = await fetch(`${BASE}/bank/status`);
  if (!res.ok) throw new Error(`Bank status failed: ${res.status}`);
  return res.json();
}

export async function fetchFinancialSummary(): Promise<FinancialSummary> {
  const res = await fetch(`${BASE}/financials/summary`);
  if (!res.ok) throw new Error(`Financial summary failed: ${res.status}`);
  return res.json();
}

export async function fetchRecentTransactions(
  maxCount = 50,
): Promise<BankTransaction[]> {
  const res = await fetch(`${BASE}/bank/transactions?maxCount=${maxCount}`);
  if (!res.ok) throw new Error(`Transactions failed: ${res.status}`);
  return res.json();
}

export async function fetchProcurementTransactions(
  maxCount = 50,
): Promise<BankTransaction[]> {
  const res = await fetch(
    `${BASE}/financials/procurement?maxCount=${maxCount}`,
  );
  if (!res.ok)
    throw new Error(`Procurement transactions failed: ${res.status}`);
  return res.json();
}

export async function fetchManufacturingTransactions(
  maxCount = 50,
  type = "all",
): Promise<BankTransaction[]> {
  const res = await fetch(
    `${BASE}/financials/manufacturing?maxCount=${maxCount}&type=${type}`,
  );
  if (!res.ok)
    throw new Error(`Manufacturing transactions failed: ${res.status}`);
  return res.json();
}
