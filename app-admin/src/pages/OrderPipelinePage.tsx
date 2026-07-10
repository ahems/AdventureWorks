import React from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  RefreshCw,
  Clock,
  CheckCircle2,
  Truck,
  Package,
  XCircle,
  AlertTriangle,
  ChevronsRight,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { toast } from "@/hooks/use-toast";
import {
  getOrderPipelineConfig,
  saveOrderPipelineConfig,
  getOrderPipelineStatus,
  promoteOrdersPendingToApproved,
  promoteOrdersApprovedToShipped,
  type OrderPipelineConfig,
  type OrderPipelineStatus,
} from "@/services/utilityService";

const POLL_INTERVAL_MS = 20_000;

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function fmtHours(h: number): string {
  if (h === 0) return "immediate";
  if (h < 1) return `${Math.round(h * 60)} min`;
  return h === 1 ? "1 h" : `${h} h`;
}

const DEFAULT_CONFIG: OrderPipelineConfig = {
  processingToApprovedMinMinutes: 5,
  processingToApprovedMaxMinutes: 60,
  approvedToShippedMinHours: 1,
  approvedToShippedMaxHours: 12,
};

const EMPTY_STATUS: OrderPipelineStatus = {
  inProcess:   { orderCount: 0, totalValue: 0 },
  approved:    { orderCount: 0, totalValue: 0 },
  backordered: { orderCount: 0, totalValue: 0 },
  rejected:    { orderCount: 0, totalValue: 0 },
  shipped:     { orderCount: 0, totalValue: 0 },
  cancelled:   { orderCount: 0, totalValue: 0 },
  note:        "",
};

// ── component ────────────────────────────────────────────────────────────────

export default function OrderPipelinePage() {
  // ── state ─────────────────────────────────────────────────────────────────
  const [config, setConfig]               = React.useState<OrderPipelineConfig>(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig]     = React.useState<OrderPipelineConfig>(DEFAULT_CONFIG);
  const [pipelineStatus, setPipelineStatus] = React.useState<OrderPipelineStatus>(EMPTY_STATUS);

  const [loadingConfig, setLoadingConfig]   = React.useState(true);
  const [loadingStatus, setLoadingStatus]   = React.useState(true);
  const [savingConfig, setSavingConfig]     = React.useState(false);
  const [promotingPending, setPromotingPending]   = React.useState(false);
  const [promotingApproved, setPromotingApproved] = React.useState(false);
  const [configError, setConfigError]       = React.useState<string | null>(null);
  const [statusError, setStatusError]       = React.useState<string | null>(null);

  // ── fetch helpers ─────────────────────────────────────────────────────────

  const fetchConfig = React.useCallback(async () => {
    try {
      const cfg = await getOrderPipelineConfig();
      setConfig(cfg);
      setSavedConfig(cfg);
      setConfigError(null);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Failed to load config.");
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  const fetchStatus = React.useCallback(async () => {
    try {
      const s = await getOrderPipelineStatus();
      setPipelineStatus(s);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to load status.");
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  // ── lifecycle ─────────────────────────────────────────────────────────────

  React.useEffect(() => {
    fetchConfig();
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchConfig, fetchStatus]);

  // ── derived ───────────────────────────────────────────────────────────────

  const isDirty =
    config.processingToApprovedMinMinutes !== savedConfig.processingToApprovedMinMinutes ||
    config.processingToApprovedMaxMinutes !== savedConfig.processingToApprovedMaxMinutes ||
    config.approvedToShippedMinHours      !== savedConfig.approvedToShippedMinHours      ||
    config.approvedToShippedMaxHours      !== savedConfig.approvedToShippedMaxHours;

  const pendingCount  = pipelineStatus.inProcess.orderCount;
  const approvedCount = pipelineStatus.approved.orderCount + pipelineStatus.backordered.orderCount;

  // ── handlers ──────────────────────────────────────────────────────────────

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      const saved = await saveOrderPipelineConfig(config);
      setSavedConfig(saved);
      toast({ title: "Configuration saved", description: "Future orders will use the new timing." });
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSavingConfig(false);
    }
  };

  const handlePromotePending = async () => {
    setPromotingPending(true);
    try {
      const result = await promoteOrdersPendingToApproved();
      toast({
        title: "Promoted to Approved",
        description: result.message,
      });
      await fetchStatus();
    } catch (err) {
      toast({
        title: "Promote failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPromotingPending(false);
    }
  };

  const handlePromoteApproved = async () => {
    setPromotingApproved(true);
    try {
      const result = await promoteOrdersApprovedToShipped();
      toast({
        title: "Promoted to Shipped",
        description: result.message,
      });
      await fetchStatus();
    } catch (err) {
      toast({
        title: "Promote failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPromotingApproved(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-doodle-bg flex flex-col">
      <AdminHeader />

      <main className="container mx-auto px-4 py-8 flex-1">
        {/* Breadcrumb */}
        <div className="mb-4">
          <Link
            to="/utilities"
            className="font-doodle text-sm text-doodle-text/60 hover:text-doodle-text flex items-center gap-1"
          >
            <ArrowLeft className="w-3 h-3" /> Utilities
          </Link>
        </div>

        {/* Header */}
        <div className="mb-8">
          <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-2">
            Order Processing Pipeline
          </h1>
          <p className="font-doodle text-doodle-text/70">
            Configure timing delays and view live order counts across each pipeline stage. Orders
            automatically flow In Process → Approved → Shipped on the configured schedule.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* ── Left: Timing configuration ────────────────────────────────── */}
          <div className="space-y-6">
            <div className="doodle-card p-6">
              <div className="flex items-center gap-2 mb-5">
                <Clock className="w-5 h-5 text-doodle-purple shrink-0" />
                <h2 className="font-doodle text-lg font-semibold text-doodle-text">
                  Timing Configuration
                </h2>
              </div>

              {configError && (
                <p className="font-doodle text-sm text-red-500 mb-4">{configError}</p>
              )}

              {loadingConfig ? (
                <p className="font-doodle text-doodle-text/60 text-sm">Loading…</p>
              ) : (
                <div className="space-y-8">
                  {/* Stage 1: Processing → Approved */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <Label className="font-doodle font-semibold text-doodle-text">
                        In Process → Approved delay
                      </Label>
                      <span className="font-doodle text-sm text-doodle-purple font-bold">
                        {fmtMinutes(config.processingToApprovedMinMinutes)}
                        {" – "}
                        {fmtMinutes(config.processingToApprovedMaxMinutes)}
                      </span>
                    </div>
                    <p className="font-doodle text-xs text-doodle-text/50 mb-3">
                      Random delay before a new order is first picked up and moved to Approved.
                    </p>
                    <div className="space-y-4">
                      <div>
                        <Label className="font-doodle text-xs text-doodle-text/70 mb-1 block">
                          Minimum — {fmtMinutes(config.processingToApprovedMinMinutes)}
                        </Label>
                        <Slider
                          min={1}
                          max={Math.min(config.processingToApprovedMaxMinutes, 240)}
                          step={1}
                          value={[config.processingToApprovedMinMinutes]}
                          onValueChange={([v]) =>
                            setConfig((c) => ({
                              ...c,
                              processingToApprovedMinMinutes: Math.min(v, c.processingToApprovedMaxMinutes),
                            }))
                          }
                        />
                      </div>
                      <div>
                        <Label className="font-doodle text-xs text-doodle-text/70 mb-1 block">
                          Maximum — {fmtMinutes(config.processingToApprovedMaxMinutes)}
                        </Label>
                        <Slider
                          min={config.processingToApprovedMinMinutes}
                          max={1440}
                          step={5}
                          value={[config.processingToApprovedMaxMinutes]}
                          onValueChange={([v]) =>
                            setConfig((c) => ({
                              ...c,
                              processingToApprovedMaxMinutes: Math.max(v, c.processingToApprovedMinMinutes),
                            }))
                          }
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-doodle-border" />

                  {/* Stage 2: Approved → Shipped */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <Label className="font-doodle font-semibold text-doodle-text">
                        Approved → Shipped delay
                      </Label>
                      <span className="font-doodle text-sm text-doodle-blue font-bold">
                        {fmtHours(config.approvedToShippedMinHours)}
                        {" – "}
                        {fmtHours(config.approvedToShippedMaxHours)}
                      </span>
                    </div>
                    <p className="font-doodle text-xs text-doodle-text/50 mb-3">
                      Random delay after approval before the order ships (or is backordered).
                    </p>
                    <div className="space-y-4">
                      <div>
                        <Label className="font-doodle text-xs text-doodle-text/70 mb-1 block">
                          Minimum — {fmtHours(config.approvedToShippedMinHours)}
                        </Label>
                        <Slider
                          min={0}
                          max={Math.min(config.approvedToShippedMaxHours, 48)}
                          step={1}
                          value={[config.approvedToShippedMinHours]}
                          onValueChange={([v]) =>
                            setConfig((c) => ({
                              ...c,
                              approvedToShippedMinHours: Math.min(v, c.approvedToShippedMaxHours),
                            }))
                          }
                        />
                      </div>
                      <div>
                        <Label className="font-doodle text-xs text-doodle-text/70 mb-1 block">
                          Maximum — {fmtHours(config.approvedToShippedMaxHours)}
                        </Label>
                        <Slider
                          min={config.approvedToShippedMinHours}
                          max={168}
                          step={1}
                          value={[config.approvedToShippedMaxHours]}
                          onValueChange={([v]) =>
                            setConfig((c) => ({
                              ...c,
                              approvedToShippedMaxHours: Math.max(v, c.approvedToShippedMinHours),
                            }))
                          }
                        />
                      </div>
                    </div>
                  </div>

                  {/* Save button */}
                  <Button
                    onClick={handleSaveConfig}
                    disabled={!isDirty || savingConfig}
                    className="w-full font-doodle"
                  >
                    {savingConfig ? (
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4 mr-2" />
                    )}
                    {savingConfig ? "Saving…" : isDirty ? "Save Changes" : "No Changes"}
                  </Button>

                  <p className="font-doodle text-xs text-doodle-text/40 text-center">
                    Changes apply to orders placed after saving. Orders already in the queue
                    retain their original delay.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ── Right: Pipeline status + bulk promote ─────────────────────── */}
          <div className="space-y-6">
            {/* Status counts */}
            <div className="doodle-card p-6">
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2">
                  <Package className="w-5 h-5 text-doodle-blue shrink-0" />
                  <h2 className="font-doodle text-lg font-semibold text-doodle-text">
                    Pipeline Status
                  </h2>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={fetchStatus}
                  disabled={loadingStatus}
                  className="font-doodle text-xs"
                >
                  <RefreshCw className={`w-3 h-3 mr-1 ${loadingStatus ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>

              {statusError && (
                <p className="font-doodle text-sm text-red-500 mb-4">{statusError}</p>
              )}

              <div className="space-y-3">
                <StatusRow
                  icon={<Clock className="w-4 h-4 text-doodle-yellow" />}
                  label="In Process"
                  badgeVariant="outline"
                  badgeClass="border-doodle-yellow text-doodle-yellow"
                  entry={pipelineStatus.inProcess}
                  note="Awaiting initial processing"
                />
                <StatusRow
                  icon={<CheckCircle2 className="w-4 h-4 text-doodle-blue" />}
                  label="Approved"
                  badgeVariant="outline"
                  badgeClass="border-doodle-blue text-doodle-blue"
                  entry={pipelineStatus.approved}
                  note="Awaiting fulfilment"
                />
                <StatusRow
                  icon={<AlertTriangle className="w-4 h-4 text-doodle-orange" />}
                  label="Backordered"
                  badgeVariant="outline"
                  badgeClass="border-doodle-orange text-doodle-orange"
                  entry={pipelineStatus.backordered}
                  note="Awaiting stock"
                />

                <div className="border-t border-doodle-border border-dashed my-1" />
                <p className="font-doodle text-xs text-doodle-text/40">{pipelineStatus.note}</p>

                <StatusRow
                  icon={<Truck className="w-4 h-4 text-doodle-green" />}
                  label="Shipped (last 7 days)"
                  badgeVariant="outline"
                  badgeClass="border-doodle-green text-doodle-green"
                  entry={pipelineStatus.shipped}
                  note="Terminal — bank credited"
                />
                <StatusRow
                  icon={<XCircle className="w-4 h-4 text-red-400" />}
                  label="Rejected (last 7 days)"
                  badgeVariant="outline"
                  badgeClass="border-red-400 text-red-400"
                  entry={pipelineStatus.rejected}
                  note="Terminal — ~5% of orders"
                />
              </div>
            </div>

            {/* Bulk promote */}
            <div className="doodle-card p-6">
              <div className="flex items-center gap-2 mb-4">
                <ChevronsRight className="w-5 h-5 text-doodle-purple shrink-0" />
                <h2 className="font-doodle text-lg font-semibold text-doodle-text">
                  Bulk Promote
                </h2>
              </div>
              <p className="font-doodle text-sm text-doodle-text/60 mb-5">
                Skip the normal queue delays and immediately advance all orders in a given stage
                to the next. Useful for demos or clearing a backlog quickly.
              </p>

              <div className="space-y-3">
                {/* Promote In Process → Approved */}
                <div className="flex items-center justify-between gap-3 p-3 rounded border border-doodle-border bg-doodle-bg">
                  <div className="min-w-0">
                    <p className="font-doodle text-sm font-semibold text-doodle-text">
                      In Process → Approved
                    </p>
                    <p className="font-doodle text-xs text-doodle-text/50">
                      {pendingCount > 0
                        ? `${pendingCount} order${pendingCount !== 1 ? "s" : ""} will be enqueued immediately`
                        : "No In Process orders right now"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handlePromotePending}
                    disabled={promotingPending || pendingCount === 0}
                    className="font-doodle shrink-0"
                  >
                    {promotingPending ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <ChevronsRight className="w-3 h-3" />
                    )}
                    <span className="ml-1">Promote all</span>
                  </Button>
                </div>

                {/* Promote Approved/Backordered → Shipped */}
                <div className="flex items-center justify-between gap-3 p-3 rounded border border-doodle-border bg-doodle-bg">
                  <div className="min-w-0">
                    <p className="font-doodle text-sm font-semibold text-doodle-text">
                      Approved / Backordered → Shipped
                    </p>
                    <p className="font-doodle text-xs text-doodle-text/50">
                      {approvedCount > 0
                        ? `${approvedCount} order${approvedCount !== 1 ? "s" : ""} will ship immediately (bank credited)`
                        : "No Approved or Backordered orders right now"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handlePromoteApproved}
                    disabled={promotingApproved || approvedCount === 0}
                    className="font-doodle shrink-0"
                  >
                    {promotingApproved ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <Truck className="w-3 h-3" />
                    )}
                    <span className="ml-1">Ship all</span>
                  </Button>
                </div>
              </div>

              <p className="font-doodle text-xs text-doodle-text/40 mt-4">
                Shipping an order triggers the shipped-notification email and records the sale
                income in the bank simulator.
              </p>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

interface StatusRowProps {
  icon: React.ReactNode;
  label: string;
  badgeVariant: "outline" | "default" | "secondary" | "destructive";
  badgeClass: string;
  entry: { orderCount: number; totalValue: number };
  note: string;
}

function StatusRow({ icon, label, badgeVariant, badgeClass, entry, note }: StatusRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        {icon}
        <div className="min-w-0">
          <p className="font-doodle text-sm font-semibold text-doodle-text leading-tight">{label}</p>
          <p className="font-doodle text-xs text-doodle-text/50 truncate">{note}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {entry.orderCount > 0 && (
          <span className="font-doodle text-xs text-doodle-text/60">
            ${entry.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        )}
        <Badge variant={badgeVariant} className={`font-doodle font-bold tabular-nums ${badgeClass}`}>
          {entry.orderCount}
        </Badge>
      </div>
    </div>
  );
}
