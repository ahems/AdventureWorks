import { MANUFACTURING_BASE as BASE } from "@/config/api";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ManufacturingAgentMode = 0 | 1 | 2 | 3; // Off | ReadOnly | ProposePending | FullyAutonomous

export const AGENT_MODE_LABELS: Record<ManufacturingAgentMode, string> = {
  0: "Off",
  1: "Read-Only",
  2: "Propose + Approve",
  3: "Fully Autonomous",
};

export const AGENT_MODE_DESCRIPTIONS: Record<ManufacturingAgentMode, string> = {
  0: "Agent is disabled. No orders are analysed and no AI tokens are consumed.",
  1: "Agent analyses inventory and logs findings. No actions taken.",
  2: "Agent proposes supply orders and manufacturing runs. You approve each one before it executes.",
  3: "Agent places supply orders and starts manufacturing runs automatically.",
};

export interface AgentConfig {
  mode: ManufacturingAgentMode;
  modeLabel: string;
  isAgentActive: boolean;
  autoShutoffAt?: string | null; // ISO 8601 UTC — null = no shutoff
}

export interface AgentStep {
  key: string;
  label: string;
  startedAt: string;
  completedAt?: string | null;
}

export type AgentRunStatus =
  | "pending"
  | "running"
  | "retrying"
  | "completed"
  | "failed";

export interface AgentRun {
  runId: string;
  salesOrderId: number;
  customerId: number;
  modeLabel: string;
  status: AgentRunStatus;
  enqueuedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  findingsSummary?: string | null;
  toolsUsed?: string[] | null;
  proposalIds?: string[] | null;
  actionsExecuted?: string[] | null;
  steps?: AgentStep[] | null;
  retryCount: number;
  retryAfterUtc?: string | null;
  lastError?: string | null;
}

export interface AgentQueueStatus {
  pending: number;
  poisonQueue: number;
  isProcessing: boolean;
  lastCompletedAt?: string | null;
  estimatedDrainMinutes?: number | null;
}

export type ProposalStatus = "pending" | "approved" | "rejected" | "executed";

export interface AgentProposal {
  proposalId: string;
  type: "manufacturing" | "supply";
  productId: number;
  qty: number;
  vendorId?: string | null;
  rationale?: string | null;
  status: ProposalStatus;
  salesOrderId: number;
  runId?: string | null;
  createdAt: string;
  actionedAt?: string | null;
}

// ── API ───────────────────────────────────────────────────────────────────────

export async function fetchAgentConfig(): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/manufacturing/agent-config`);
  if (!res.ok) throw new Error(`Failed to fetch agent config: ${res.status}`);
  return res.json();
}

export async function saveAgentMode(
  mode: ManufacturingAgentMode,
  autoShutoffHours?: number | null,
): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/manufacturing/agent-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      autoShutoffHours != null ? { mode, autoShutoffHours } : { mode },
    ),
  });
  if (!res.ok) throw new Error(`Failed to save agent config: ${res.status}`);
  return res.json();
}

export async function fetchAgentRuns(limit = 30): Promise<AgentRun[]> {
  const res = await fetch(`${BASE}/manufacturing/agent-runs?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch agent runs: ${res.status}`);
  return res.json();
}

export async function fetchAgentQueueStatus(): Promise<AgentQueueStatus> {
  const res = await fetch(`${BASE}/manufacturing/agent-queue-status`);
  if (!res.ok) throw new Error(`Failed to fetch queue status: ${res.status}`);
  return res.json();
}

export async function clearAgentQueue(): Promise<void> {
  const res = await fetch(`${BASE}/manufacturing/agent-queue`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to clear agent queue: ${res.status}`);
}

export async function clearAgentPoisonQueue(): Promise<void> {
  const res = await fetch(`${BASE}/manufacturing/agent-queue/poison`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to clear poison queue: ${res.status}`);
}

export async function fetchAgentProposals(): Promise<AgentProposal[]> {
  const res = await fetch(`${BASE}/manufacturing/proposals?status=pending`);
  if (!res.ok) throw new Error(`Failed to fetch proposals: ${res.status}`);
  return res.json();
}

export async function approveProposal(
  proposalId: string,
): Promise<{ status: string; note?: string }> {
  const res = await fetch(
    `${BASE}/manufacturing/proposals/${proposalId}/approve`,
    {
      method: "POST",
    },
  );
  if (!res.ok) {
    const body = await res.text();
    // Parse the JSON body so we show "Vendor X not found" not the raw JSON blob
    try {
      const json = JSON.parse(body);
      throw new Error(json.error ?? json.message ?? body);
    } catch (parseErr) {
      if (parseErr instanceof SyntaxError)
        throw new Error(body || `Failed to approve proposal: ${res.status}`);
      throw parseErr;
    }
  }
  return res.json();
}

export async function rejectProposal(proposalId: string): Promise<void> {
  const res = await fetch(
    `${BASE}/manufacturing/proposals/${proposalId}/reject`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Failed to reject proposal: ${res.status}`);
}

export async function rejectAllProposals(): Promise<{ rejected: number }> {
  const res = await fetch(`${BASE}/manufacturing/proposals/reject-all`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to reject all proposals: ${res.status}`);
  return res.json();
}

export interface ApproveAllResult {
  succeeded: number;
  failed: number;
  errors: string[];
}

export async function approveAllProposals(): Promise<ApproveAllResult> {
  const res = await fetch(`${BASE}/manufacturing/proposals/approve-all`, {
    method: "POST",
  });
  if (!res.ok)
    throw new Error(`Failed to approve all proposals: ${res.status}`);
  return res.json();
}
