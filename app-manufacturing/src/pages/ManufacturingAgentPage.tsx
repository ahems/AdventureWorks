import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Check,
  Clock,
  RefreshCw,
  AlertTriangle,
  X,
  CheckCircle2,
  Loader2,
  ChevronRight,
  Inbox,
  Info,
  CheckCheck,
  XCircle,
  Eye,
  Zap,
  GitPullRequest,
  PowerOff,
  Wrench,
  ListChecks,
  Timer,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  fetchAgentConfig,
  saveAgentMode,
  fetchAgentRuns,
  fetchAgentQueueStatus,
  fetchAgentProposals,
  approveProposal,
  rejectProposal,
  rejectAllProposals,
  approveAllProposals,
  type ApproveAllResult,
  AGENT_MODE_LABELS,
  AGENT_MODE_DESCRIPTIONS,
  type ManufacturingAgentMode,
  type AgentRun,
  type AgentProposal,
} from "@/services/agentApi";
import { toast } from "sonner";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (secs < 60) return `${secs}s ago`;
  if (mins < 60) return `${mins}m ago`;
  return `${hours}h ${mins % 60}m ago`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Countdown from now until a future ISO timestamp, e.g. "23h 45m". */
function formatCountdown(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const remaining = new Date(iso).getTime() - Date.now();
  if (remaining <= 0) return "shutting off…";
  const totalMins = Math.floor(remaining / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Splits an action string into segments, converting WO #N, PO #N, and Product #N
 * into clickable links pointing to the relevant pages.
 */
function renderWithLinks(text: string): React.ReactNode[] {
  // Patterns: WO #12345 → /plan/work-orders/12345
  //           PO #67890 → /supply/orders/67890
  //           Product #776 → /receive/products/776/inventory
  //           Vendor #1492 → /supply/vendors/1492
  const pattern =
    /(WO\s*#\s*(\d+))|(PO\s*#\s*(\d+))|(Product\s*#\s*(\d+))|(Vendor\s*#\s*(\d+))/gi;
  const result: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) result.push(text.slice(last, match.index));
    const full = match[0];
    if (match[2])
      result.push(
        <Link
          key={match.index}
          to={`/plan/work-orders/${match[2]}`}
          className="font-medium text-doodle-blue underline-offset-2 hover:underline"
        >
          {full}
        </Link>,
      );
    else if (match[4])
      result.push(
        <Link
          key={match.index}
          to={`/supply/orders/${match[4]}`}
          className="font-medium text-doodle-green underline-offset-2 hover:underline"
        >
          {full}
        </Link>,
      );
    else if (match[6])
      result.push(
        <Link
          key={match.index}
          to={`/receive/products/${match[6]}/inventory`}
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          {full}
        </Link>,
      );
    else if (match[8])
      result.push(
        <Link
          key={match.index}
          to={`/supply/vendors/${match[8]}`}
          className="font-medium text-muted-foreground underline-offset-2 hover:underline"
        >
          {full}
        </Link>,
      );
    last = match.index + full.length;
  }
  if (last < text.length) result.push(text.slice(last));
  return result;
}

/**
 * When the queue trigger's JSON parser catches an exception it stores the
 * agent's full JSON response as the findingsSummary — this helper unwraps it.
 */
function parseFinding(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const s = parsed.findingsSummary ?? parsed.summary ?? parsed.message;
      if (typeof s === "string" && s.length > 0) return s;
    } catch {
      // fall through
    }
  }
  return raw;
}

// ── Queue status card ─────────────────────────────────────────────────────────

const QueueStatusCard: React.FC = () => {
  const { data } = useQuery({
    queryKey: ["agent-queue-status"],
    queryFn: fetchAgentQueueStatus,
    refetchInterval: 15_000,
  });

  const pending = data?.pending ?? 0;
  const poison = data?.poisonQueue ?? 0;
  const fillPct = Math.min(100, (pending / 50) * 100);
  const colourClass =
    pending > 20
      ? "bg-destructive"
      : pending > 5
        ? "bg-amber-500"
        : "bg-doodle-green";

  return (
    <Card className="doodle-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Inbox className="h-4 w-4 text-doodle-blue" /> Agent Queue
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end gap-3">
          <span className="text-3xl font-bold font-doodle">{pending}</span>
          <span className="text-sm text-muted-foreground mb-1">
            orders waiting
          </span>
          {data?.isProcessing && (
            <Badge
              variant="outline"
              className="border-doodle-green text-doodle-green mb-1"
            >
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Processing
            </Badge>
          )}
        </div>
        <Progress value={fillPct} className={`h-2 ${colourClass}`} />
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {poison > 0 && (
            <span className="text-destructive flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> {poison} failed (poison)
            </span>
          )}
          {data?.estimatedDrainMinutes != null && pending > 0 && (
            <span>~{data.estimatedDrainMinutes}m to drain at current rate</span>
          )}
          {data?.lastCompletedAt && (
            <span>Last completed {formatRelative(data.lastCompletedAt)}</span>
          )}
        </div>
        {pending > 20 && (
          <p className="text-xs text-amber-600 flex items-start gap-1">
            <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
            The agent is a bottleneck — like an understaffed shop floor station.
            Orders are queuing up and will be processed in order.
          </p>
        )}
      </CardContent>
    </Card>
  );
};

// ── Mode selector ─────────────────────────────────────────────────────────────

const SHUTOFF_PRESETS = [1, 2, 4, 8, 24, 72] as const;
type ShutoffPreset = (typeof SHUTOFF_PRESETS)[number];

const ModeSelector: React.FC = () => {
  const qc = useQueryClient();
  const { data: config, refetch } = useQuery({
    queryKey: ["manufacturing-agent-config"],
    queryFn: fetchAgentConfig,
    // Re-poll every minute so the countdown stays current
    refetchInterval: 60_000,
  });
  const currentMode = config?.mode ?? 0;

  // Local shutoff hours — synced from server config on load so the correct chip is highlighted
  const [shutoffHours, setShutoffHours] = useState<ShutoffPreset | null>(24);

  useEffect(() => {
    if (!config?.autoShutoffAt) {
      // No shutoff active on server — keep local default (24h intent)
      if (config !== undefined) setShutoffHours(24);
      return;
    }
    // Match the saved shutoff to the nearest preset chip
    const remainingH =
      (new Date(config.autoShutoffAt).getTime() - Date.now()) / 3_600_000;
    if (remainingH <= 0) {
      setShutoffHours(24); // expired, reset to default
      return;
    }
    const closest = SHUTOFF_PRESETS.reduce((prev, curr) =>
      Math.abs(curr - remainingH) < Math.abs(prev - remainingH) ? curr : prev,
    );
    setShutoffHours(closest);
  }, [config?.autoShutoffAt]);

  const saveMutation = useMutation({
    mutationFn: ({
      mode,
      hours,
    }: {
      mode: ManufacturingAgentMode;
      hours?: number | null;
    }) => saveAgentMode(mode, hours),
    onSuccess: (updated) => {
      qc.setQueryData(["manufacturing-agent-config"], updated);
      const countdown = formatCountdown(updated.autoShutoffAt);
      const suffix = countdown ? ` · auto-off in ${countdown}` : "";
      toast.success(`Agent mode set to ${updated.modeLabel}${suffix}`);
    },
    onError: (e: Error) => toast.error(`Failed to update mode: ${e.message}`),
  });

  function handleModeChange(newMode: ManufacturingAgentMode) {
    if (newMode === currentMode) return;
    if (newMode === 3) {
      if (
        !confirm(
          "Switch to Fully Autonomous mode?\n\n" +
            "The agent will place supply orders and start manufacturing runs without any human approval. " +
            "This will disable manual create actions on Plan, Supply, and Receive pages.\n\n" +
            "You can switch back to Off at any time.",
        )
      )
        return;
    }
    saveMutation.mutate({
      mode: newMode,
      hours: newMode === 0 ? null : shutoffHours,
    });
  }

  const modes: ManufacturingAgentMode[] = [0, 1, 2, 3];
  const countdown = formatCountdown(config?.autoShutoffAt);

  return (
    <Card className="doodle-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <Bot className="h-4 w-4 text-doodle-blue" /> Agent Mode
            </CardTitle>
            <CardDescription className="mt-0.5">
              Controls how much autonomy the AI agent has over production and
              supply chain decisions.
            </CardDescription>
          </div>
          {/* Countdown badge */}
          {countdown && currentMode !== 0 && (
            <span
              className="shrink-0 flex items-center gap-1 text-xs text-doodle-accent font-medium"
              title={`Auto-off at ${new Date(config!.autoShutoffAt!).toLocaleTimeString()}`}
            >
              <Timer className="h-3.5 w-3.5" />
              {countdown}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode buttons */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {modes.map((mode) => {
            const active = mode === currentMode;
            const mLabel = AGENT_MODE_LABELS[mode];
            const mCfg = modeConfig[mLabel];
            const MIcon = mCfg?.icon ?? Bot;
            return (
              <button
                key={mode}
                onClick={() => handleModeChange(mode)}
                disabled={saveMutation.isPending}
                title={mCfg?.title}
                className={`
                  rounded-lg border p-3 text-left transition-all
                  ${
                    active
                      ? "border-doodle-blue bg-doodle-blue/10 ring-1 ring-doodle-blue"
                      : "border-border hover:border-doodle-blue/50 hover:bg-secondary/50"
                  }
                `}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5">
                    <MIcon
                      className={`h-4 w-4 shrink-0 ${active ? "text-doodle-blue" : (mCfg?.colour ?? "text-muted-foreground")}`}
                      title={mCfg?.title}
                    />
                    <span className="text-sm font-semibold">{mLabel}</span>
                  </div>
                  {active && (
                    <Check className="h-4 w-4 text-doodle-blue shrink-0" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {AGENT_MODE_DESCRIPTIONS[mode]}
                </p>
              </button>
            );
          })}
        </div>

        {/* Auto-shutoff duration — only shown when not Off */}
        {currentMode !== 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Timer className="h-3.5 w-3.5" />
              Auto-shutoff after
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SHUTOFF_PRESETS.map((h) => {
                const isActive = shutoffHours === h;
                return (
                  <button
                    key={h}
                    onClick={() => {
                      setShutoffHours(h);
                      if (currentMode !== 0)
                        saveMutation.mutate({ mode: currentMode, hours: h });
                    }}
                    disabled={saveMutation.isPending}
                    title={
                      isActive
                        ? `Currently selected: ${h >= 24 ? `${h / 24}d` : `${h}h`}`
                        : undefined
                    }
                    className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium border transition-colors
                      ${
                        isActive
                          ? "border-doodle-accent bg-doodle-accent/15 text-doodle-accent ring-1 ring-doodle-accent font-semibold"
                          : "border-border text-muted-foreground hover:border-doodle-accent/50 hover:text-foreground"
                      }`}
                  >
                    {isActive && <Check className="h-3 w-3 shrink-0" />}
                    {h >= 24 ? `${h / 24}d` : `${h}h`}
                  </button>
                );
              })}
              {(() => {
                const isActive = shutoffHours === null;
                return (
                  <button
                    onClick={() => {
                      setShutoffHours(null);
                      if (currentMode !== 0)
                        saveMutation.mutate({ mode: currentMode, hours: null });
                    }}
                    disabled={saveMutation.isPending}
                    title={
                      isActive ? "Currently selected: No limit" : undefined
                    }
                    className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium border transition-colors
                      ${
                        isActive
                          ? "border-doodle-accent bg-doodle-accent/15 text-doodle-accent ring-1 ring-doodle-accent font-semibold"
                          : "border-border text-muted-foreground hover:border-doodle-accent/50 hover:text-foreground"
                      }`}
                  >
                    {isActive && <Check className="h-3 w-3 shrink-0" />}
                    No limit
                  </button>
                );
              })()}
            </div>
            {countdown && (
              <p className="text-xs text-doodle-accent/80">
                Agent will switch to Off in {countdown}.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ── Run entry ─────────────────────────────────────────────────────────────────

/** Maps the modeLabel string (from ManufacturingAgentMode.ToString()) to a visual. */
const modeConfig: Record<
  string,
  { icon: React.ElementType; colour: string; title: string }
> = {
  Off: {
    icon: PowerOff,
    colour: "text-muted-foreground/50",
    title: "Off — no analysis",
  },
  ReadOnly: {
    icon: Eye,
    colour: "text-doodle-blue",
    title: "Read-Only — observing",
  },
  ProposePending: {
    icon: GitPullRequest,
    colour: "text-amber-500",
    title: "Propose + Approve — awaiting human review",
  },
  FullyAutonomous: {
    icon: Zap,
    colour: "text-doodle-green",
    title: "Fully Autonomous — acting directly",
  },
};

const statusConfig = {
  pending: { icon: Clock, colour: "text-muted-foreground", label: "Queued" },
  running: { icon: Loader2, colour: "text-doodle-blue", label: "Processing" },
  retrying: {
    icon: RefreshCw,
    colour: "text-amber-500",
    label: "Retrying",
  },
  completed: {
    icon: CheckCircle2,
    colour: "text-doodle-green",
    label: "Completed",
  },
  failed: { icon: X, colour: "text-destructive", label: "Failed" },
} as const;

const RunEntry: React.FC<{ run: AgentRun }> = ({ run }) => {
  const cfg = statusConfig[run.status] ?? statusConfig.pending;
  const Icon = cfg.icon;
  const steps: AgentStep[] = Array.isArray(run.steps)
    ? (run.steps as AgentStep[])
    : [];
  const summary = parseFinding(run.findingsSummary);

  return (
    <div className="border-b border-border/60 py-3 last:border-0">
      <div className="flex items-start gap-3">
        <Icon
          className={`h-4 w-4 shrink-0 mt-0.5 ${cfg.colour} ${run.status === "running" || run.status === "retrying" ? "animate-spin" : ""}`}
        />
        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-sm font-semibold">
              Order #{run.salesOrderId}
            </span>
            <Badge
              variant="outline"
              className={`text-xs border-current ${cfg.colour}`}
            >
              {cfg.label}
            </Badge>
            {/* Mode icon — hover for full mode name */}
            {(() => {
              const m = modeConfig[run.modeLabel] ?? modeConfig.ReadOnly;
              const ModeIcon = m.icon;
              return (
                <ModeIcon
                  className={`h-3.5 w-3.5 shrink-0 ${m.colour}`}
                  title={m.title}
                />
              );
            })()}
            <span className="text-xs text-muted-foreground ml-auto shrink-0">
              {formatRelative(run.enqueuedAt)}
            </span>
          </div>

          {/* Step progress (running) */}
          {run.status === "running" && steps.length > 0 && (
            <ol className="mt-1 space-y-0.5">
              {steps.map((step) => (
                <li
                  key={step.key}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  {step.completedAt ? (
                    <Check className="h-3 w-3 text-doodle-green shrink-0" />
                  ) : (
                    <Loader2 className="h-3 w-3 animate-spin text-doodle-blue shrink-0" />
                  )}
                  <span
                    className={
                      step.completedAt ? "line-through opacity-60" : ""
                    }
                  >
                    {step.label}
                    {step.completedAt && (
                      <span className="ml-1 not-italic opacity-70">
                        {formatTime(step.completedAt)}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {/* Findings (completed) — clean prose text only */}
          {run.status === "completed" && summary && (
            <p className="text-xs text-foreground/80 mt-1 line-clamp-2 leading-relaxed">
              {summary}
            </p>
          )}

          {/* Tools used — compact chips with wrench prefix */}
          {run.status === "completed" &&
            run.toolsUsed &&
            run.toolsUsed.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 mt-1.5">
                <Wrench className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                {run.toolsUsed.map((t) => (
                  <span
                    key={t}
                    className="inline-block bg-secondary text-muted-foreground text-[10px] px-1.5 py-0.5 rounded"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}

          {/* Proposals created */}
          {(run.proposalIds?.length ?? 0) > 0 && (
            <p className="text-xs text-doodle-blue mt-1 flex items-center gap-1">
              <ListChecks className="h-3 w-3 shrink-0" />
              {run.proposalIds!.length} proposal
              {run.proposalIds!.length > 1 ? "s" : ""} pending approval
            </p>
          )}

          {/* Actions executed (FullyAutonomous) — each line is linkified */}
          {run.status === "completed" &&
            run.actionsExecuted &&
            run.actionsExecuted.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {run.actionsExecuted.map((action, i) => (
                  <li
                    key={i}
                    className="text-xs leading-relaxed text-foreground/80 flex items-start gap-1.5"
                  >
                    <span className="mt-0.5 shrink-0 text-doodle-green">→</span>
                    <span>{renderWithLinks(action)}</span>
                  </li>
                ))}
              </ul>
            )}

          {/* Retrying */}
          {run.status === "retrying" && (
            <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
              <Timer className="h-3 w-3 shrink-0" />
              Retrying in{" "}
              {run.retryAfterUtc
                ? `${Math.max(0, Math.round((new Date(run.retryAfterUtc).getTime() - Date.now()) / 1000))}s`
                : "…"}{" "}
              (attempt {run.retryCount}/8)
              {run.lastError && ` — ${run.lastError.substring(0, 80)}`}
            </p>
          )}

          {/* Failed */}
          {run.status === "failed" && run.lastError && (
            <p className="text-xs text-destructive mt-1 line-clamp-2">
              {run.lastError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Proposals panel ───────────────────────────────────────────────────────────

const ProposalsPanel: React.FC = () => {
  const qc = useQueryClient();
  const { data: proposals = [], isLoading } = useQuery({
    queryKey: ["agent-proposals"],
    queryFn: fetchAgentProposals,
    refetchInterval: 10_000,
  });

  const approveMutation = useMutation({
    mutationFn: approveProposal,
    onSuccess: (data) => {
      if (data?.note) {
        toast.info(data.note);
      } else {
        toast.success("Proposal approved and executed.");
      }
      qc.invalidateQueries({ queryKey: ["agent-proposals"] });
    },
    onError: (e: Error) => toast.error(`Approval failed: ${e.message}`),
  });

  const rejectMutation = useMutation({
    mutationFn: rejectProposal,
    onSuccess: () => {
      toast.success("Proposal rejected.");
      qc.invalidateQueries({ queryKey: ["agent-proposals"] });
    },
    onError: (e: Error) => toast.error(`Rejection failed: ${e.message}`),
  });

  const rejectAllMutation = useMutation({
    mutationFn: rejectAllProposals,
    onSuccess: (data) => {
      toast.success(
        `Rejected ${data.rejected} proposal${data.rejected !== 1 ? "s" : ""}.`,
      );
      qc.invalidateQueries({ queryKey: ["agent-proposals"] });
    },
    onError: (e: Error) => toast.error(`Reject all failed: ${e.message}`),
  });

  const approveAllMutation = useMutation({
    mutationFn: approveAllProposals,
    onSuccess: (data: ApproveAllResult) => {
      if (data.failed === 0) {
        toast.success(
          `Approved and executed ${data.succeeded} proposal${data.succeeded !== 1 ? "s" : ""}.`,
        );
      } else {
        toast.warning(
          `${data.succeeded} approved, ${data.failed} failed. Check proposals for details.`,
        );
      }
      qc.invalidateQueries({ queryKey: ["agent-proposals"] });
    },
    onError: (e: Error) => toast.error(`Approve all failed: ${e.message}`),
  });

  const anyBusy =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    rejectAllMutation.isPending ||
    approveAllMutation.isPending;

  if (isLoading)
    return (
      <p className="text-sm text-muted-foreground p-4">Loading proposals…</p>
    );

  return (
    <div>
      {/* Bulk action toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/60 bg-secondary/30">
        <span className="text-xs text-muted-foreground">
          {proposals.length === 0
            ? "No pending proposals."
            : `${proposals.length} pending · auto-expire after 5 min`}
        </span>
        {proposals.length > 0 && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-7 text-xs"
              disabled={anyBusy}
              onClick={() => rejectAllMutation.mutate()}
            >
              {rejectAllMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              Reject All
            </Button>
            <Button
              size="sm"
              className="gap-1.5 h-7 text-xs"
              disabled={anyBusy}
              onClick={() => approveAllMutation.mutate()}
            >
              {approveAllMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCheck className="h-3.5 w-3.5" />
              )}
              Approve All
            </Button>
          </div>
        )}
      </div>

      {/* Per-proposal rows */}
      {proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground px-4 py-6 text-center">
          No pending proposals.
        </p>
      ) : (
        <div className="divide-y divide-border/60">
          {proposals.map((p: AgentProposal) => (
            <div key={p.proposalId} className="px-4 py-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-start gap-2">
                <Badge variant="outline" className="text-xs">
                  {p.type === "manufacturing"
                    ? "🏭 Manufacture"
                    : "📦 Supply order"}
                </Badge>
                <span className="text-sm font-medium">
                  Product #{p.productId} × {p.qty}
                </span>
                {p.vendorId && (
                  <span className="text-xs text-muted-foreground">
                    Vendor {p.vendorId}
                  </span>
                )}
                <span className="text-xs text-muted-foreground ml-auto">
                  from order #{p.salesOrderId}
                </span>
              </div>
              {p.rationale && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {p.rationale}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="gap-1.5 h-7 text-xs"
                  disabled={anyBusy}
                  onClick={() => approveMutation.mutate(p.proposalId)}
                >
                  <Check className="h-3.5 w-3.5" /> Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-7 text-xs"
                  disabled={anyBusy}
                  onClick={() => rejectMutation.mutate(p.proposalId)}
                >
                  <X className="h-3.5 w-3.5" /> Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────

const ManufacturingAgentPage: React.FC = () => {
  const { data: config } = useQuery({
    queryKey: ["manufacturing-agent-config"],
    queryFn: fetchAgentConfig,
  });
  const isOff = (config?.mode ?? 0) === 0;
  const isProposePending = config?.mode === 2;

  // Runs: poll every 5 s when active, every 30 s when idle, disabled when Off
  const { data: runs = [] } = useQuery({
    queryKey: ["agent-runs"],
    queryFn: () => fetchAgentRuns(30),
    enabled: !isOff,
    refetchInterval: (query) => {
      if (isOff) return false;
      const data = query.state.data as AgentRun[] | undefined;
      const hasActive = data?.some(
        (r) => r.status === "running" || r.status === "retrying",
      );
      return hasActive ? 5_000 : 30_000;
    },
  });

  const hasActiveRun = runs.some(
    (r) => r.status === "running" || r.status === "retrying",
  );

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold font-doodle flex items-center gap-2">
          <Bot className="h-7 w-7 text-doodle-blue" /> AI Manufacturing Agent
        </h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
          Control the agent's autonomy level, monitor its activity, and approve
          or reject proposed actions. The agent analyses every new order for
          inventory and manufacturing impact.
        </p>
      </div>

      {/* Top row: mode + queue */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <ModeSelector />
        </div>
        <QueueStatusCard />
      </div>

      {/* Proposals (ProposePending only) */}
      {isProposePending && (
        <Card className="doodle-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ChevronRight className="h-4 w-4 text-doodle-blue" /> Pending
              Approvals
            </CardTitle>
            <CardDescription>
              The agent has proposed the following actions. Review and approve
              or reject each one.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ProposalsPanel />
          </CardContent>
        </Card>
      )}

      {/* Activity feed */}
      <Card className="doodle-card">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              {hasActiveRun ? (
                <Loader2 className="h-4 w-4 text-doodle-blue animate-spin" />
              ) : (
                <Bot className="h-4 w-4 text-doodle-blue" />
              )}
              Activity Feed
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {hasActiveRun ? "Updating every 5s" : "Updating every 30s"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0 px-4">
          {isOff ? (
            <div className="py-10 flex flex-col items-center gap-3 text-center">
              <Bot className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-muted-foreground">
                Agent is Off
              </p>
              <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                No orders are being analysed and no AI tokens are consumed.
                Select <span className="font-semibold">Read-Only</span> or
                higher above to start receiving activity.
              </p>
            </div>
          ) : runs.length === 0 ? (
            <div className="py-8 space-y-4 text-center">
              <p className="text-sm text-muted-foreground">
                No agent activity yet. The agent will start analysing orders as
                they come in.
              </p>
              <div className="mx-4 flex items-start gap-2 rounded-lg border border-doodle-blue/30 bg-doodle-blue/5 px-4 py-3 text-left">
                <Info className="h-4 w-4 shrink-0 mt-0.5 text-doodle-blue" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Orders placed <span className="font-medium">before</span> the
                  agent was enabled are not retroactively queued — only new
                  orders will appear here. If the shopping simulator is running,
                  activity should appear within a few seconds of the next order.
                </p>
              </div>
            </div>
          ) : (
            runs.map((run) => <RunEntry key={run.runId} run={run} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ManufacturingAgentPage;
